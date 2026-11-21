// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-identite.ts — console › connexion d'entreprise (admins seulement) : réglages `auth`, fournisseurs d'identité, secret, activation et extinction. */
import { createHash } from "node:crypto";

import type { DependancesAuth } from "@elpis/auth";
import { estDict, HttpError, poserCle } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { sousVerrouConfigJson, writeConfigJson } from "@elpis/config";
import { REGEX_ID_FOURNISSEUR } from "@elpis/contracts";
import type { Base, Executeur } from "@elpis/db";
import { corpsJson, parametreChemin } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditer, lireConfigPourEcrire } from "../admin/aides";
import { ancreIdentite } from "../identite/ancre";
import { exigerConfirmationAdmin } from "../identite/droits";
import { adminsLocauxUneFois, compterAdminsLocaux, exigerAdminLocal } from "../identite/etat";
import { lancerTest } from "../identite/essai";
import { effacerEtatOidc } from "../identite/oidc/flux";
import type { OptionsEssai } from "../identite/essai";
import {
  couperSessionsDesFournisseurs,
  empreinteFournisseur,
  enregistrerSecret,
  connexionSecurisee,
  etatFournisseur,
  champsFigesChanges,
  revendicationIdentifiantChangee,
  hoteDuFournisseur,
  nombreIdentites,
  secretFournisseur,
  supprimerSecretFournisseur,
} from "../identite/fournisseurs";
import {
  BORNES_AUTH,
  FOURNISSEURS_MAX,
  lireReglagesAuth,
  reglagesAuthDepuis,
  validerCreation,
  validerFournisseur,
  validerModification,
  validerReglagesGeneraux,
} from "../identite/reglages";
import type { Fournisseur } from "../identite/reglages";
import { diffConfig } from "../journal-securite/diff-config";
import type { Journal } from "../journal";
import { ErreurSecret } from "../secrets/erreurs";
import { acteurDe } from "./secrets";
import type { DefinitionRoute, Famille, Traitement } from "../routes";

export interface DependancesAdminIdentite {
  readonly base: Base;
  readonly auth: Pick<DependancesAuth, "attributsCookie" | "maintenant">;
  readonly journal: Journal;
  /** Flux ouverts d'un compte coupés dans tous les process (`session_revoked`). */
  readonly revoquer: (uid: number) => Promise<unknown>;
  /** Résolution, juge et bornes du test (tests seulement). */
  readonly essai?: OptionsEssai;
}

const TESTS_MAX = 2;
const CIBLES_AUDIT_MAX = 5;

const SANS_CACHE = { "cache-control": "no-store" };

function route(
  methode: "GET" | "PUT" | "POST" | "DELETE",
  chemin: string,
  traiter: Traitement,
): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

/** Section `auth` du fichier (créée vide si absente) rangée dans `cfg`, `providers` toujours une liste. */
function sectionAEcrire(cfg: Dict): { section: Dict; providers: unknown[] } {
  const brute = cfg["auth"];
  const section: Dict = estDict(brute) ? brute : {};
  if (!Array.isArray(section["providers"])) poserCle(section, "providers", []);
  poserCle(cfg, "auth", section);
  return { section, providers: section["providers"] as unknown[] };
}

/** Vrai si toutes les identités restantes de l'identifiant portent l'ancre que donnent les réglages du nouveau fournisseur (aucune : vrai). */
async function identitesDeMemeAncre(x: Executeur, f: Fournisseur): Promise<boolean> {
  const ancres = await x.valeurs<[string]>(
    "SELECT DISTINCT issuer FROM user_identities WHERE provider_id=?",
    [f.id],
  );
  const ancre = ancreIdentite(f);
  return ancres.every(([a]) => a === ancre);
}

function positionDuFournisseur(providers: readonly unknown[], id: string): number {
  return providers.findIndex((p) => estDict(p) && p["id"] === id);
}

/** Fournisseur du fichier lu strictement ; 404 s'il n'existe pas, 409 s'il ne se lit pas. */
function fournisseurDuFichier(providers: readonly unknown[], id: string): { f: Fournisseur; i: number } {
  const i = positionDuFournisseur(providers, id);
  if (i < 0) throw new HttpError(404, "Fournisseur introuvable.");
  try {
    return { f: validerFournisseur(providers[i]), i };
  } catch (e) {
    if (e instanceof HttpError)
      throw new HttpError(409, "Ce fournisseur est illisible : supprimez-le puis recréez-le.");
    throw e;
  }
}

/** Fournisseur réduit pour le journal : le PEM devient sa longueur et son empreinte. */
function pourJournal(f: Fournisseur | null): Dict {
  if (f === null) return {};
  const pem =
    f.ca_pem === ""
      ? ""
      : `pem len=${f.ca_pem.length} sha256=${createHash("sha256").update(f.ca_pem).digest("hex").slice(0, 12)}`;
  return { ...f, ca_pem: pem } as unknown as Dict;
}

export function creerFamilleAdminIdentite(dep: DependancesAdminIdentite): Famille {
  const { base } = dep;
  const maintenant = (): number => (dep.auth.maintenant ? dep.auth.maintenant() : Date.now() / 1000);

  /** Réglages, état de chaque fournisseur et prérequis, tels que la console les lit. */
  async function vue(x: Executeur): Promise<Record<string, unknown>> {
    const r = lireReglagesAuth();
    const securise = connexionSecurisee(dep.auth.attributsCookie().https_only === true);
    const admins = adminsLocauxUneFois(x);
    const providers = [];
    for (const f of r.providers) {
      const e = await etatFournisseur(x, f, r.public_url, securise, admins);
      providers.push({
        ...f,
        has_secret: e.has_secret,
        tested: e.tested,
        active: f.enabled && e.ecart === null,
        identities: await nombreIdentites(x, f.id),
      });
    }
    return {
      public_url: r.public_url,
      local: r.local,
      providers,
      invalid_providers: r.invalides,
      prerequisites: {
        public_url_https: r.public_url !== "",
        cookie_secure: securise,
        local_admins: await admins(),
      },
      bounds: {
        providers_max: FOURNISSEURS_MAX,
        label_max: BORNES_AUTH.label.max,
        required_groups_max: BORNES_AUTH.required_groups_max,
        secret_max: BORNES_AUTH.secret_max,
        freshness_days: BORNES_AUTH.freshness_days,
        clock_skew_sec: BORNES_AUTH.clock_skew_sec,
      },
    };
  }

  /** Publie la coupure de ces comptes huit par huit, après la réponse : la coupure elle-même est déjà écrite. */
  async function publierCoupures(uids: readonly number[]): Promise<void> {
    for (let i = 0; i < uids.length; i += 8)
      await Promise.all(
        uids.slice(i, i + 8).map(async (uid) => {
          try {
            await dep.revoquer(uid);
          } catch (e) {
            dep.journal.error({ err: e }, "[admin] publication session_revoked (fournisseur éteint) échouée");
          }
        }),
      );
  }

  /** Écriture sous le verrou d'écriture de la base puis celui de config.json : l'invariant gardé et l'action se décident au même instant. */
  async function ecrire<T>(f: (x: Executeur, cfg: Dict) => Promise<T>, ecrireFichier = true): Promise<T> {
    return base.ecriture((x) =>
      sousVerrouConfigJson(async () => {
        const cfg = lireConfigPourEcrire();
        const r = await f(x, cfg);
        if (ecrireFichier) writeConfigJson(cfg);
        return r;
      }),
    );
  }

  async function lire(_req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    void rep.headers(SANS_CACHE);
    return vue(base);
  }

  async function reglages(req: FastifyRequest): Promise<unknown> {
    const corps = corpsJson(req);
    const [avant, apres] = await ecrire<[Dict, Dict]>(async (x, cfg) => {
      const { section } = sectionAEcrire(cfg);
      const actuels = reglagesAuthDepuis(section);
      const nouveaux = validerReglagesGeneraux(corps, actuels);
      if (nouveaux.public_url !== actuels.public_url && actuels.providers.some((p) => p.enabled))
        throw new HttpError(409, "Désactivez d'abord les fournisseurs pour changer l'adresse publique.");
      if (nouveaux.local.mode === "admins" && actuels.local.mode !== "admins") await exigerAdminLocal(x);
      poserCle(section, "public_url", nouveaux.public_url);
      poserCle(section, "local", {
        ...(estDict(section["local"]) ? section["local"] : {}),
        mode: nouveaux.local.mode,
      });
      return [
        { public_url: actuels.public_url, local: actuels.local },
        { public_url: nouveaux.public_url, local: nouveaux.local },
      ] as [Dict, Dict];
    });
    const changes = diffConfig(avant, apres).changes;
    if (changes.length) auditer(req, "admin.auth.settings", { changes });
    return vue(base);
  }

  /** 400 si une correspondance nouvelle vise un groupe Elpis qui n'existe pas. */
  async function exigerGroupesElpis(
    x: Executeur,
    nouveau: Fournisseur,
    actuel: Fournisseur | null,
  ): Promise<void> {
    const connus = new Set(actuel?.group_map.map.map((m) => m.group_id));
    const ids = [...new Set(nouveau.group_map.map.map((m) => m.group_id))].filter((i) => !connus.has(i));
    if (ids.length === 0) return;
    const presents = new Set(
      (
        await x.valeurs<[unknown]>(
          `SELECT id FROM "groups" WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids,
        )
      ).map(([g]) => Number(g)),
    );
    if (ids.some((i) => !presents.has(i)))
      throw new HttpError(400, "Champ « group_map.map.group_id » : ce groupe n'existe pas.");
  }

  function sansConfirmation(req: FastifyRequest): { corps: unknown; confirme: boolean } {
    const recu = corpsJson(req);
    const { confirm_admin_mapping: confirmation, ...reste } = estDict(recu) ? recu : ({} as Dict);
    if (confirmation !== undefined && typeof confirmation !== "boolean")
      throw new HttpError(400, "Champ « confirm_admin_mapping » : vrai ou faux attendu.");
    return { corps: estDict(recu) ? reste : recu, confirme: confirmation === true };
  }

  async function creer(req: FastifyRequest): Promise<unknown> {
    const { corps, confirme } = sansConfirmation(req);
    const f = validerCreation(corps);
    await ecrire(async (x, cfg) => {
      const { providers } = sectionAEcrire(cfg);
      exigerConfirmationAdmin(null, f, confirme);
      await exigerGroupesElpis(x, f, null);
      if (providers.length >= FOURNISSEURS_MAX)
        throw new HttpError(400, `${FOURNISSEURS_MAX} fournisseurs au plus.`);
      if (positionDuFournisseur(providers, f.id) >= 0)
        throw new HttpError(409, "Cet identifiant est déjà pris.");
      if (!(await identitesDeMemeAncre(x, f)))
        throw new HttpError(409, "Cet identifiant est encore lié à des comptes : choisissez-en un autre.");
      await supprimerSecretFournisseur(base, f.id, acteurDe(req));
      await x.run("DELETE FROM auth_provider_state WHERE provider_id=?", [f.id]);
      await x.run("DELETE FROM auth_prelinks WHERE provider_id=?", [f.id]);
      providers.push(f);
    });
    auditer(req, "admin.auth.provider.create", {
      provider_id: f.id,
      type: f.type,
      changes: diffConfig({}, pourJournal(f)).changes,
    });
    return vue(base);
  }

  async function modifier(req: FastifyRequest): Promise<unknown> {
    const id = parametreChemin(req);
    const { corps, confirme } = sansConfirmation(req);
    const [avant, apres] = await ecrire<[Fournisseur, Fournisseur]>(async (x, cfg) => {
      const { providers } = sectionAEcrire(cfg);
      const { f: actuel, i } = fournisseurDuFichier(providers, id);
      const nouveau = validerModification(corps, actuel);
      exigerConfirmationAdmin(actuel, nouveau, confirme);
      await exigerGroupesElpis(x, nouveau, actuel);
      const publique = reglagesAuthDepuis(cfg["auth"]).public_url;
      if (
        actuel.enabled &&
        empreinteFournisseur(nouveau, publique) !== empreinteFournisseur(actuel, publique)
      )
        throw new HttpError(409, "Désactivez ce fournisseur avant de modifier ses réglages.");
      if (champsFigesChanges(actuel, nouveau).length > 0 && (await nombreIdentites(x, id)) > 0)
        throw new HttpError(
          409,
          "Ce réglage ne se modifie plus : des comptes sont rattachés à ce fournisseur.",
        );
      if (champsFigesChanges(actuel, nouveau).length > 0 || revendicationIdentifiantChangee(actuel, nouveau))
        await x.run("DELETE FROM auth_prelinks WHERE provider_id=?", [id]);
      await x.run("DELETE FROM auth_flows WHERE provider_id=? AND trial_admin IS NOT NULL", [id]);
      providers[i] = nouveau;
      return [actuel, nouveau];
    });
    const changes = diffConfig(pourJournal(avant), pourJournal(apres)).changes;
    if (changes.length) auditer(req, "admin.auth.provider.update", { provider_id: id, changes });
    return vue(base);
  }

  async function supprimer(req: FastifyRequest): Promise<unknown> {
    const id = parametreChemin(req);
    const type = await ecrire(async (x, cfg) => {
      const { providers } = sectionAEcrire(cfg);
      const i = positionDuFournisseur(providers, id);
      if (i < 0) throw new HttpError(404, "Fournisseur introuvable.");
      let lu: Fournisseur | null = null;
      try {
        lu = validerFournisseur(providers[i]);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
      }
      if (lu?.enabled) throw new HttpError(409, "Désactivez ce fournisseur avant de le supprimer.");
      if ((await nombreIdentites(x, id)) > 0)
        throw new HttpError(
          409,
          "Des comptes sont rattachés à ce fournisseur : il ne peut pas être supprimé.",
        );
      providers.splice(i, 1);
      await supprimerSecretFournisseur(base, id, acteurDe(req));
      await x.run("DELETE FROM auth_provider_state WHERE provider_id=?", [id]);
      await x.run("DELETE FROM auth_prelinks WHERE provider_id=?", [id]);
      await effacerEtatOidc(x, id);
      return lu?.type ?? null;
    });
    auditer(req, "admin.auth.provider.delete", { provider_id: id, type });
    return { ok: true };
  }

  async function secret(req: FastifyRequest): Promise<unknown> {
    const id = parametreChemin(req);
    const corps = corpsJson(req);
    const valeur = estDict(corps) ? corps["secret"] : undefined;
    if (typeof valeur !== "string" || Object.keys(corps as Dict).length !== 1)
      throw new HttpError(400, "Champ « secret » : texte attendu.");
    if (valeur.length > BORNES_AUTH.secret_max || !valeur.isWellFormed())
      throw new HttpError(400, `Champ « secret » : ${BORNES_AUTH.secret_max} caractères au plus.`);
    try {
      await ecrire(async (_x, cfg) => {
        const f = reglagesAuthDepuis(cfg["auth"]).providers.find((p) => p.id === id);
        if (f === undefined) throw new HttpError(404, "Fournisseur introuvable.");
        if (valeur === "") await supprimerSecretFournisseur(base, id, acteurDe(req));
        else await enregistrerSecret(base, f, valeur, acteurDe(req));
      }, false);
    } catch (e) {
      if (e instanceof ErreurSecret) throw new HttpError(e.statut === 409 ? 409 : 400, "Secret refusé.");
      throw e;
    }
    auditer(req, "admin.auth.provider.secret", { provider_id: id, action: valeur === "" ? "delete" : "set" });
    return vue(base);
  }

  async function activer(req: FastifyRequest): Promise<unknown> {
    const id = parametreChemin(req);
    await ecrire(async (x, cfg) => {
      const { providers } = sectionAEcrire(cfg);
      const { f, i } = fournisseurDuFichier(providers, id);
      const publique = reglagesAuthDepuis(cfg["auth"]).public_url;
      if (publique === "") throw new HttpError(409, "L'adresse publique en https est requise.");
      if (!connexionSecurisee(dep.auth.attributsCookie().https_only === true))
        throw new HttpError(409, "La connexion sécurisée (https) doit être en vigueur sur ce serveur.");
      await exigerAdminLocal(x);
      if (f.required_groups.length === 0)
        throw new HttpError(409, "Au moins un groupe requis doit être renseigné.");
      const e = await etatFournisseur(x, f, publique, true);
      if (!e.has_secret) throw new HttpError(409, "Le secret du fournisseur est absent.");
      if (!e.tested) throw new HttpError(409, "Un test réussi sur les réglages courants est requis.");
      providers[i] = { ...f, enabled: true };
    });
    auditer(req, "admin.auth.provider.enable", { provider_id: id });
    return vue(base);
  }

  async function desactiver(req: FastifyRequest): Promise<unknown> {
    const id = parametreChemin(req);
    const comptes = await ecrire(async (x, cfg) => {
      const { providers } = sectionAEcrire(cfg);
      const i = positionDuFournisseur(providers, id);
      if (i < 0) throw new HttpError(404, "Fournisseur introuvable.");
      providers[i] = { ...(providers[i] as Dict), enabled: false };
      await effacerEtatOidc(x, id);
      return couperSessionsDesFournisseurs(x, [id], maintenant());
    });
    void publierCoupures(comptes);
    auditer(req, "admin.auth.provider.disable", { provider_id: id, sessions_cut: comptes.length });
    return vue(base);
  }

  let testsEnCours = 0;

  /** Secret enregistré d'un SSO pour un test : seulement sous les adresses et l'autorité de certification du fournisseur ENREGISTRÉ. */
  async function secretOidcEnregistre(f: Fournisseur): Promise<string | null> {
    const enregistre = lireReglagesAuth().providers.find((p) => p.id === f.id);
    if (enregistre === undefined || enregistre.ca_pem !== f.ca_pem) return null;
    if (hoteDuFournisseur(f) !== hoteDuFournisseur(enregistre)) return null;
    return secretFournisseur(base, f);
  }

  /** Test d'un fournisseur sous le plafond de deux à la fois pour l'instance : 429 au-delà, le créneau n'étant rendu qu'à la fin réelle du travail ; toujours 200 avec le résultat. */
  async function tester(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const corps = corpsJson(req);
    if (testsEnCours >= TESTS_MAX)
      throw new HttpError(429, "Deux tests sont déjà en cours, réessayez dans un instant.", {
        "Retry-After": "5",
      });
    testsEnCours += 1;
    let lance: ReturnType<typeof lancerTest>;
    try {
      lance = lancerTest(
        corps,
        {
          publicUrl: lireReglagesAuth().public_url,
          cookieSecure: connexionSecurisee(dep.auth.attributsCookie().https_only === true),
          adminsLocaux: await compterAdminsLocaux(base),
        },
        { ...dep.essai, oidc: { secretEnregistre: secretOidcEnregistre } },
      );
    } catch (e) {
      testsEnCours -= 1;
      throw e;
    }
    void lance.termine.finally(() => {
      testsEnCours -= 1;
    });
    const r = await lance.resultat;
    const brut = estDict(corps) ? corps : {};
    const id = typeof brut["id"] === "string" && REGEX_ID_FOURNISSEUR.test(brut["id"]) ? brut["id"] : null;
    const type = brut["type"] === "oidc" ? "oidc" : null;
    const targets = [...new Set(r.steps.flatMap((e) => (e.target === null ? [] : [e.target])))].slice(
      0,
      CIBLES_AUDIT_MAX,
    );
    auditer(req, "admin.auth.provider.test", {
      provider_id: id,
      type,
      ok: r.ok,
      failed_step: r.steps.find((e) => e.level === "fail")?.id ?? null,
      targets,
    });
    void rep.headers(SANS_CACHE);
    return r;
  }

  return {
    nom: "admin-identite",
    routes: [
      route("GET", "/api/admin/auth", lire),
      route("PUT", "/api/admin/auth/settings", reglages),
      route("POST", "/api/admin/auth/providers", creer),
      route("POST", "/api/admin/auth/providers/test", tester),
      route("PUT", "/api/admin/auth/providers/:id", modifier),
      route("DELETE", "/api/admin/auth/providers/:id", supprimer),
      route("PUT", "/api/admin/auth/providers/:id/secret", secret),
      route("POST", "/api/admin/auth/providers/:id/enable", activer),
      route("POST", "/api/admin/auth/providers/:id/disable", desactiver),
    ],
  };
}
