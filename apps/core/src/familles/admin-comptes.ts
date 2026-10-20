// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-comptes.ts — console : comptes, groupes, accès aux serveurs d'inférence et clients OAuth (admin/users.py, groups.py, oauth.py). */
import {
  createGroup,
  createUser,
  deleteClient,
  deleteGroup,
  ErreurGroupe,
  getAllUsersWithGroups,
  getGroup,
  getUser,
  getUsernameById,
  getUserSettings,
  leverMinSession,
  ligneUtilisateur,
  listClients,
  listerJetons,
  listGrants,
  listGroups,
  mergeUserSettings,
  resetUserPassword,
  revoquerTousAcces,
  setUserGroups,
  updateGroup,
  validerNomUtilisateur,
  ErreurNomUtilisateur,
} from "@elpis/auth";
import { chargerConfigBac } from "@elpis/bac";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  arrondiPy,
  comparePointsDeCode,
  ErreurPython,
  estDict,
  getPy,
  HttpError,
  intPy,
  iterExige,
  nomTypePy,
  reprPy,
  stripPy,
  texteNet,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { readConfigJson } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditer, entierBase, entierPy, exigerTexte, niveauDuRole } from "../admin/aides";
import { racineBac, sandboxUsageBytes, supprimerBac, travailBac } from "../admin/bac";
import type { PortBac } from "../admin/bac";
import { definirAccesBureau, lireCorpsAccesLlm, vueAccesLlm, vueCiblesBureau } from "../admin/comptes";
import { validerMotDePasse } from "../comptes/aides";
import { deleteUserFull } from "../comptes/suppression";
import type { Journal } from "../journal";
import {
  deletePrincipalRows,
  describeUsers,
  getPolicy,
  invalidateCache,
  listEngineOptions,
  listPolicies,
  setPolicy,
} from "../llm/acces-moteurs";
import { invaliderAccesRag, purgerGroupeRag } from "../rag/acces";
import { profilReseauDesReglages } from "../relais/identite";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, parametreRequete, py, reponseJsonPy } from "@elpis/http";

export interface DependancesAdminComptes {
  readonly base: Base;
  readonly auth: DependancesAuth & DependancesJetons;
  readonly journal: Journal;
  /** `publish_event({"type": "session_revoked", "uid": …})` : flux du compte coupés dans tous les process. */
  readonly revoquer: (uid: number | null) => Promise<unknown>;
  readonly bac?: PortBac;
}

const MO = 1024 * 1024;

function route(
  methode: "GET" | "POST" | "PUT" | "DELETE",
  chemin: string,
  traiter: Traitement,
): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

function cheminEntier(requete: FastifyRequest, nom: string): number {
  return (entrees(requete, { path: { [nom]: py.int() } }).path as Record<string, number>)[nom] as number;
}

/** `len(v)` d'une valeur JSON qui n'est pas un texte : liste ou dict, TypeError sinon. */
function longueurNonTexte(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (estDict(v)) return Object.keys(v).length;
  throw new ErreurPython("TypeError", `object of type '${nomTypePy(v)}' has no len()`);
}

/** `validate_password` sur une valeur reçue : la longueur et les motifs n'acceptent qu'un texte (TypeError, 500), comme `len()` et `re.search`. */
function validerMotDePasseRecu(v: unknown, config: unknown): void {
  if (typeof v === "string") return validerMotDePasse(v, config);
  const politique = getPy(getPy(config, "security", {}), "password_policy", {});
  const longueur = intPy(getPy(politique, "min_length", 0));
  if (longueur > 0 && longueurNonTexte(v) < longueur)
    throw new HttpError(400, `Le mot de passe doit faire au moins ${longueur} caractères.`);
  for (const cle of ["require_uppercase", "require_lowercase", "require_numbers", "require_special"])
    if (veritePy(getPy(politique, cle, false)))
      throw new ErreurPython("TypeError", "expected string or bytes-like object, got '" + nomTypePy(v) + "'");
}

export function creerFamilleAdminComptes(dep: DependancesAdminComptes): Famille {
  const { base, auth } = dep;
  const maintenant = (): number => (auth.maintenant ? auth.maintenant() : Date.now() / 1000);

  async function supprimerCompte(req: FastifyRequest): Promise<Dict> {
    const uid = utilisateur(req);
    const cible = cheminEntier(req, "target_id");
    if (uid === cible) throw new HttpError(400, "Vous ne pouvez pas vous supprimer vous-même.");
    const avecBac = (parametreRequete(req, "delete_sandbox") ?? "false").toLowerCase() === "true";
    let dossier: string | null = null;
    if (avecBac) {
      try {
        dossier = racineBac(await getUsernameById(base, cible), cible);
      } catch {
        dossier = null;
      }
    }
    try {
      await dep.revoquer(cible);
    } catch (e) {
      dep.journal.error({ err: e }, "[admin] publication session_revoked (delete) échouée");
    }
    const parti = await getUsernameById(base, cible);
    if (!(await deleteUserFull(base, cible))) throw new HttpError(404, "Utilisateur introuvable");
    if (parti) {
      try {
        await definirAccesBureau(parti, new Set());
      } catch (e) {
        dep.journal.error({ err: e }, "[admin] nettoyage des accès desktop (delete) échoué");
      }
    }
    let supprime = false;
    let erreur: string | null = null;
    if (avecBac && dossier !== null)
      [supprime, erreur] = await supprimerBac(cible, parti ?? "", dossier, dep.bac);
    const reponse: Dict = { ok: true, sandbox_deleted: supprime };
    if (erreur) reponse["sandbox_error"] = erreur;
    return reponse;
  }

  async function creerCompte(req: FastifyRequest): Promise<Dict> {
    const data = corpsJsonValeurs(req);
    const username = stripPy(exigerTexte(getPy(data, "username", "")));
    const password = stripPy(exigerTexte(getPy(data, "password", "")));
    const niveau = niveauDuRole(getPy(data, "role", "user"));
    if (!username || !password) throw new HttpError(400, "Données invalides");
    if (await getUser(base, username)) throw new HttpError(400, "L'utilisateur existe déjà");
    try {
      await validerNomUtilisateur(base, username);
    } catch (e) {
      if (e instanceof ErreurNomUtilisateur) throw new HttpError(400, e.message);
      throw e;
    }
    validerMotDePasse(password, auth.config());
    await createUser(base, username, password, {
      isAdmin: niveau,
      mustChangePwd: 1,
      maintenant: maintenant(),
    });
    return { ok: true };
  }

  async function changerRole(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const uid = utilisateur(req);
    const cible = cheminEntier(req, "target_id");
    const data = corpsJsonValeurs(req);
    const role = getPy(data, "role", "user");
    const niveau = niveauDuRole(role);
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Utilisateur non trouvé");
    if (cible === uid && niveau !== 1)
      throw new HttpError(400, "Impossible de retirer vos propres droits admin");
    await base.run("UPDATE users SET is_admin=? WHERE id=?", [niveau, cible]);
    invaliderAccesRag(base);
    return reponseJsonPy(rep, { ok: true, role });
  }

  async function reinitialiserMotDePasse(req: FastifyRequest): Promise<Dict> {
    const data = corpsJsonValeurs(req);
    const brut = getPy(data, "target_id");
    const mdp = getPy(data, "new_password");
    if (!veritePy(brut) || !veritePy(mdp)) throw new HttpError(400, "Missing data");
    validerMotDePasseRecu(mdp, auth.config());
    const exact = entierPy(brut);
    if (typeof mdp !== "string")
      throw new ErreurPython("AttributeError", `'${nomTypePy(mdp)}' object has no attribute 'encode'`);
    const cible = entierBase(exact);
    await resetUserPassword(base, cible, mdp);
    await leverMinSession(base, cible, maintenant());
    try {
      await dep.revoquer(cible);
    } catch (e) {
      dep.journal.error({ err: e }, "[admin] publication session_revoked (reset-password) échouée");
    }
    await revoquerTousAcces(auth, cible);
    await base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [cible]);
    return { ok: true };
  }

  async function comptesEtGroupes(_req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const cfg = readConfigJson();
    const quotaGlobal = entierPy(getPy(getPy(cfg, "app", {}), "sandbox_quota_mb", 5120));
    const profils = chargerConfigBac().network_profiles.map((p) => ({
      id: p.id,
      name: p.name,
      mode: p.mode,
      ips: [...p.ips],
      description: p.description,
      domains: [...p.domains],
      ports: [...p.ports],
      dns: [...p.dns],
    }));
    const comptes = await getAllUsersWithGroups(base);
    for (const u of comptes) {
      const s = u["_settings"] as Dict;
      delete u["_settings"];
      u["sandbox_quota_mb"] = Object.hasOwn(s, "sandbox_quota_mb") ? s["sandbox_quota_mb"] : quotaGlobal;
      u["network_profile_id"] = profilReseauDesReglages(s);
      u["forced_network_profile_id"] = texteOu(getPy(s, "forced_network_profile_id"), "");
      const id = u["id"] as number;
      const octets = await sandboxUsageBytes(id, travailBac(u["username"] as string, id));
      u["sandbox_used_mb"] = versFlottantPy(arrondiPy(octets / MO, 2));
    }
    await describeUsers(base, comptes);
    return reponseJsonPy(rep, {
      users: comptes,
      network_profiles: profils,
      desktop_targets: vueCiblesBureau(),
    });
  }

  async function machinesDuCompte(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const cible = cheminEntier(req, "target_id");
    const compte = await ligneUtilisateur(base, cible);
    if (!compte) throw new HttpError(404, "Utilisateur introuvable");
    let data: unknown;
    try {
      data = corpsJsonValeurs(req);
    } catch {
      throw new HttpError(400, "Corps JSON attendu");
    }
    const noms = estDict(data) ? getPy(data, "targets", null) : null;
    if (!Array.isArray(noms) || !noms.every((n) => typeof n === "string"))
      throw new HttpError(400, "targets : liste de noms de machines");
    const connues = new Set(vueCiblesBureau().map((t) => t["name"]));
    const inconnues = (noms as string[]).filter((n) => !connues.has(n));
    if (inconnues.length) throw new HttpError(400, `Machine inconnue : ${inconnues[0] ?? ""}`);
    const username = String(compte.username);
    const modifiees = await definirAccesBureau(username, new Set(noms as string[]));
    auditer(req, "admin.user.desktop_targets", {
      target_user_id: cible,
      target_username: username,
      targets: [...(noms as string[])].sort(comparePointsDeCode),
      changed: modifiees,
    });
    return reponseJsonPy(rep, { ok: true, changed: modifiees, desktop_targets: vueCiblesBureau() });
  }

  async function accesLlmDuCompte(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "target_id");
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Utilisateur introuvable");
    return vueAccesLlm(base, cible);
  }

  async function definirAccesLlmDuCompte(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "target_id");
    const compte = await ligneUtilisateur(base, cible);
    if (!compte) throw new HttpError(404, "Utilisateur introuvable");
    const nouveau = await lireCorpsAccesLlm(base, req, await getPolicy(base, "user", cible));
    await setPolicy(base, "user", cible, nouveau);
    auditer(req, "admin.user.llm_access", {
      target_user_id: cible,
      target_username: compte.username,
      engine_keys: nouveau.engine_keys,
      can_manage_models: nouveau.can_manage_models,
    });
    return { ok: true, ...(await vueAccesLlm(base, cible)) };
  }

  async function quotaDuBac(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const cible = cheminEntier(req, "target_id");
    const brut = getPy(corpsJsonValeurs(req), "quota_mb");
    if (brut === null) throw new HttpError(400, "quota_mb required");
    let quota: number | bigint;
    try {
      quota = entierPy(brut);
    } catch (e) {
      if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))
        throw new HttpError(400, "quota_mb doit être un entier (Mo)");
      throw e;
    }
    if (quota !== -1 && quota < 0) throw new HttpError(400, "quota_mb must be >= 0 or -1 to reset");
    await mergeUserSettings(base, cible, (s) => {
      if (quota === -1) delete s["sandbox_quota_mb"];
      else s["sandbox_quota_mb"] = quota;
    });
    return reponseJsonPy(rep, { ok: true, quota_mb: quota });
  }

  async function profilReseau(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "target_id");
    const data = corpsJsonValeurs(req);
    const profil = texteNet(estDict(data) ? getPy(data, "profile_id") : null);
    const connus = chargerConfigBac().network_profiles.map((p) => p.id);
    if (profil && !connus.includes(profil))
      throw new HttpError(
        400,
        `Profil réseau ${reprPy(profil)} introuvable. Disponibles : ${reprPy(connus)}`,
      );
    const username = await getUsernameById(base, cible);
    if (!username) throw new HttpError(404, `User ${cible} introuvable`);
    const avant = profilReseauDesReglages(await getUserSettings(base, cible));
    await mergeUserSettings(base, cible, (s) => {
      if (profil) {
        s["forced_network_profile_id"] = profil;
        s["network_profile_id"] = profil;
      } else delete s["forced_network_profile_id"];
    });
    const apres = profilReseauDesReglages(await getUserSettings(base, cible));
    let detruit = false;
    if (apres !== avant) {
      try {
        if (!dep.bac) throw new Error("pas de pilote de bac à sable dans ce process");
        await dep.bac.detruireConteneur(cible, username, travailBac(username, cible), avant);
        detruit = true;
      } catch (e) {
        dep.journal.warn(
          `[admin] destruction container user_id=${cible} après changement de profil réseau : ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    auditer(req, "admin.user.network_profile", {
      target_user_id: cible,
      target_username: username,
      forced: profil || null,
      effective: apres,
      container_destroyed: detruit,
    });
    return {
      ok: true,
      forced_network_profile_id: profil,
      network_profile_id: apres,
      container_destroyed: detruit,
    };
  }

  async function accesDuCompte(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "target_id");
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Utilisateur introuvable");
    const jetons = await listerJetons(base, cible);
    let autorisations: Dict[];
    try {
      autorisations = await listGrants(base, cible, maintenant());
    } catch {
      autorisations = [];
    }
    const flottant = (v: number | null): unknown => (v === null ? null : versFlottantPy(v));
    return {
      tokens: jetons.map((t) => ({
        id: t.id,
        kind: t.kind,
        name: t.name,
        families: t.families,
        created_at: flottant(t.created_at),
        expires_at: flottant(t.expires_at),
        last_used_at: flottant(t.last_used_at),
      })),
      grants: autorisations.map((g) => ({
        grant_id: g["grant_id"] ?? null,
        client_name: g["client_name"] ?? null,
        families: g["families"] ?? null,
        created_at: g["created_at"] ?? null,
        last_used_at: g["last_used_at"] ?? null,
      })),
    };
  }

  async function couperAcces(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "target_id");
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Utilisateur introuvable");
    const bilan = await revoquerTousAcces(auth, cible);
    auditer(req, "admin.users.access.revoke", { target_user_id: cible, ...bilan });
    return { ok: true, ...bilan };
  }

  async function groupes(): Promise<Dict> {
    const liste = await listGroups(base);
    let politiques: Map<string, { engine_keys: unknown; can_manage_models: unknown }>;
    try {
      politiques = await listPolicies(base, "group");
    } catch {
      politiques = new Map();
    }
    for (const g of liste) {
      const pol = politiques.get(`group:${String(g["id"])}`);
      g["llm_engine_keys"] = pol?.engine_keys ?? null;
      g["llm_can_manage_models"] = pol?.can_manage_models ?? null;
    }
    return { groups: liste };
  }

  /** `(data.get(cle) or "").strip()`. */
  function texteRecu(data: unknown, cle: string): string {
    const v = getPy(data, cle);
    return stripPy(exigerTexte(veritePy(v) ? v : ""));
  }

  async function creerGroupe(req: FastifyRequest): Promise<Dict> {
    const data = corpsJsonValeurs(req);
    const nom = texteRecu(data, "name");
    const description = texteRecu(data, "description");
    if (!nom) throw new HttpError(400, "Nom requis");
    return { ok: true, id: await createGroup(base, nom, description, maintenant()) };
  }

  async function modifierGroupe(req: FastifyRequest): Promise<Dict> {
    const gid = cheminEntier(req, "group_id");
    const data = corpsJsonValeurs(req);
    const nom = texteRecu(data, "name");
    const description = texteRecu(data, "description");
    if (!nom) throw new HttpError(400, "Nom requis");
    if (!(await updateGroup(base, gid, nom, description))) throw new HttpError(404, "Groupe introuvable");
    return { ok: true };
  }

  async function supprimerGroupe(req: FastifyRequest): Promise<Dict> {
    const gid = cheminEntier(req, "group_id");
    const purger = async (x: Executeur): Promise<void> => {
      await deletePrincipalRows(x, "group", gid, base);
      await purgerGroupeRag(x, gid);
    };
    const supprime = await deleteGroup(base, gid, purger);
    invaliderAccesRag(base);
    if (!supprime) throw new HttpError(404, "Groupe introuvable");
    return { ok: true };
  }

  async function groupesDuCompte(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "target_id");
    const data = corpsJsonValeurs(req);
    let ids: (number | bigint)[];
    try {
      ids = iterExige(getPy(data, "group_ids", [])).map((x) => entierPy(x));
    } catch (e) {
      if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))
        throw new HttpError(400, "group_ids : identifiants entiers attendus");
      throw e;
    }
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Compte introuvable");
    const entiers = ids.map((g) => entierBase(g));
    try {
      await setUserGroups(base, cible, entiers);
    } catch (e) {
      if (e instanceof ErreurGroupe) throw new HttpError(400, e.message);
      throw e;
    }
    try {
      invalidateCache(base, cible);
    } catch (e) {
      dep.journal.debug({ err: e }, "[groups] invalidation du cache d'accès échouée");
    }
    invaliderAccesRag(base);
    return { ok: true, group_ids: [...new Set(entiers)] };
  }

  async function accesLlmDuGroupe(req: FastifyRequest): Promise<Dict> {
    const gid = cheminEntier(req, "group_id");
    if (!(await getGroup(base, gid))) throw new HttpError(404, "Groupe introuvable");
    return { ...(await getPolicy(base, "group", gid)) };
  }

  async function definirAccesLlmDuGroupe(req: FastifyRequest): Promise<Dict> {
    const gid = cheminEntier(req, "group_id");
    const groupe = await getGroup(base, gid);
    if (!groupe) throw new HttpError(404, "Groupe introuvable");
    const nouveau = await lireCorpsAccesLlm(base, req, await getPolicy(base, "group", gid));
    const enregistre = await setPolicy(base, "group", gid, nouveau);
    auditer(req, "admin.group.llm_access", { group_id: gid, group_name: groupe["name"], ...enregistre });
    return { ok: true, ...enregistre };
  }

  async function clientsOauth(_req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const t = maintenant();
    const items = (await listClients(base, t)).map((it) => ({
      ...it,
      age_days: Math.floor((t - Number(it["created_at"])) / 86400),
    }));
    return reponseJsonPy(rep, { items }, { "Cache-Control": "no-store" });
  }

  async function supprimerClientOauth(req: FastifyRequest): Promise<Dict> {
    const { client_id: clientId } = entrees(req, { query: { client_id: py.str() } }).query;
    if (!(await deleteClient(base, clientId))) throw new HttpError(404, "Client introuvable.");
    return { ok: true };
  }

  return {
    nom: "admin-comptes",
    routes: [
      route("DELETE", "/api/admin/users/:target_id", supprimerCompte),
      route("POST", "/api/admin/users/new", creerCompte),
      route("POST", "/api/admin/users/:target_id/role", changerRole),
      route("POST", "/api/admin/reset-password", reinitialiserMotDePasse),
      route("GET", "/api/admin/users-with-groups", comptesEtGroupes),
      route("PUT", "/api/admin/users/:target_id/desktop-targets", machinesDuCompte),
      route("GET", "/api/admin/llm/engine-options", async () => ({ engines: await listEngineOptions(base) })),
      route("GET", "/api/admin/users/:target_id/llm-access", accesLlmDuCompte),
      route("PUT", "/api/admin/users/:target_id/llm-access", definirAccesLlmDuCompte),
      route("POST", "/api/admin/users/:target_id/sandbox-quota", quotaDuBac),
      route("POST", "/api/admin/users/:target_id/network-profile", profilReseau),
      route("GET", "/api/admin/users/:target_id/access", accesDuCompte),
      route("POST", "/api/admin/users/:target_id/access/revoke", couperAcces),
      route("GET", "/api/admin/groups", groupes),
      route("POST", "/api/admin/groups", creerGroupe),
      route("PUT", "/api/admin/groups/:group_id", modifierGroupe),
      route("DELETE", "/api/admin/groups/:group_id", supprimerGroupe),
      route("PUT", "/api/admin/users/:target_id/groups", groupesDuCompte),
      route("GET", "/api/admin/groups/:group_id/llm-access", accesLlmDuGroupe),
      route("PUT", "/api/admin/groups/:group_id/llm-access", definirAccesLlmDuGroupe),
      route("GET", "/api/admin/oauth/clients", clientsOauth),
      route("DELETE", "/api/admin/oauth/clients", supprimerClientOauth),
    ],
  };
}
