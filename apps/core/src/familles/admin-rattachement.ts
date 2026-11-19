// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-rattachement.ts — console (admins seulement) : rattachement des comptes locaux à une identité d'annuaire, détachement, rattachements préparés des fournisseurs OIDC. */
import { ligneUtilisateur, revoquerTousAcces } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import {
  schemaCorpsDetachement,
  schemaCorpsRattachement,
  schemaCorpsRattachementPrepare,
  schemaCorpsRechercheMigration,
} from "@elpis/contracts";
import type { Base } from "@elpis/db";
import { corpsJson, entrees, parametreRequete, py } from "@elpis/http";
import type { FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { auditer } from "../admin/aides";
import { validerMotDePasse } from "../comptes/aides";
import { fabriqueLdapts } from "../identite/annuaire/client";
import type { FabriqueConnexion } from "../identite/annuaire/client";
import { annuairesActifs, PorteAnnuaire } from "../identite/annuaire/connexion";
import type { DependancesAnnuaire } from "../identite/annuaire/connexion";
import {
  chercherEntrees,
  comptesAMigrer,
  COMPTES_PAR_PAGE_MAX,
  rattacherComptes,
} from "../identite/annuaire/rattachement-annuaire";
import { fournisseurParId } from "../identite/fournisseurs";
import {
  attenduValide,
  detacher,
  preparerRattachement,
  purgerRattachementsPerimes,
} from "../identite/rattachement";
import type { LigneRattachementPrepare, RaisonRefusPrepare } from "../identite/rattachement";
import type { FournisseurLdap } from "../identite/reglages";
import { ipDeRequete } from "../journal-securite/auditer";
import type { Journal } from "../journal";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";

export interface DependancesAdminRattachement {
  readonly base: Base;
  readonly auth: DependancesAuth & DependancesJetons;
  readonly journal: Journal;
  /** Flux ouverts d'un compte coupés dans tous les process (`session_revoked`). */
  readonly revoquer: (uid: number) => Promise<unknown>;
  /** Connexions à l'annuaire (LDAPS vérifié par défaut) ; les essais y glissent une fabrique factice. */
  readonly fabrique?: FabriqueConnexion;
}

const SANS_CACHE = { "cache-control": "no-store" };
const REQUETE_INVALIDE = "Requête invalide.";
const ENTIER = /^\d{1,9}$/u;

const REFUS_PREPARE: Readonly<Record<RaisonRefusPrepare, [number, string]>> = {
  account_not_found: [404, "Utilisateur introuvable."],
  account_has_identity: [409, "Ce compte est déjà rattaché à une identité."],
  prelink_exists: [409, "Ce compte a déjà un rattachement préparé."],
  expected_taken: [409, "Cet identifiant est déjà attendu pour un autre compte."],
  waiver_forbidden_for_admin: [400, "La dispense n'est pas permise pour un compte administrateur."],
  admin_confirmation_required: [400, "La confirmation est requise pour un compte administrateur."],
  last_local_admin: [409, "Il doit rester au moins un administrateur actif avec un mot de passe local."],
};

function route(methode: "GET" | "POST" | "DELETE", chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

function corpsValide<T>(req: FastifyRequest, schema: ZodType<T>): T {
  const r = schema.safeParse(corpsJson(req));
  if (!r.success) throw new HttpError(400, REQUETE_INVALIDE);
  return r.data;
}

function idDuChemin(req: FastifyRequest, nom: string): string {
  const brut = (req.params as Record<string, unknown> | undefined)?.[nom];
  return typeof brut === "string" ? brut : "";
}

function entierDuChemin(req: FastifyRequest, nom: string): number {
  return (entrees(req, { path: { [nom]: py.int() } }).path as Record<string, number>)[nom] as number;
}

function entierDeRequete(req: FastifyRequest, nom: string, defaut: number, max: number, min = 0): number {
  const brut = parametreRequete(req, nom);
  if (brut === null) return defaut;
  const n = ENTIER.test(brut) ? Number(brut) : Number.NaN;
  if (!(n >= min && n <= max)) throw new HttpError(400, REQUETE_INVALIDE);
  return n;
}

export function creerFamilleAdminRattachement(dep: DependancesAdminRattachement): Famille {
  const { base, auth } = dep;
  const maintenant = (): number => (auth.maintenant ? auth.maintenant() : Date.now() / 1000);
  const annuaire: DependancesAnnuaire = {
    base,
    fabrique: dep.fabrique ?? fabriqueLdapts(),
    maintenant,
    cookieSecure: () => auth.attributsCookie().https_only === true,
    journal: dep.journal,
    porte: new PorteAnnuaire(),
  };

  /** Annuaire LDAP actif de l'identifiant du chemin ; 404 s'il n'existe pas, 409 s'il n'est pas un annuaire actif. */
  async function annuaireActif(req: FastifyRequest): Promise<FournisseurLdap> {
    const id = idDuChemin(req, "id");
    const f = fournisseurParId(id);
    if (f === undefined) throw new HttpError(404, "Fournisseur introuvable.");
    if (f.type !== "ldap") throw new HttpError(409, "Ce fournisseur ne se rattache pas par cet assistant.");
    const actif = (await annuairesActifs(annuaire)).find((a) => a.id === id);
    if (actif === undefined) throw new HttpError(409, "Cet annuaire n'est pas actif.");
    return actif;
  }

  /** Fournisseur OIDC de l'identifiant du chemin (allumé ou non) ; 404 s'il n'existe pas, 409 s'il n'est pas OIDC. */
  function fournisseurOidc(req: FastifyRequest): string {
    const f = fournisseurParId(idDuChemin(req, "id"));
    if (f === undefined) throw new HttpError(404, "Fournisseur introuvable.");
    if (f.type !== "oidc")
      throw new HttpError(409, "Un annuaire se rattache par l'assistant de rattachement.");
    return f.id;
  }

  async function lireMigration(req: FastifyRequest): Promise<unknown> {
    const f = await annuaireActif(req);
    const offset = entierDeRequete(req, "offset", 0, 100_000);
    const limit = entierDeRequete(req, "limit", COMPTES_PAR_PAGE_MAX, COMPTES_PAR_PAGE_MAX, 1);
    return { ...(await comptesAMigrer(annuaire, f, { offset, limit })), offset, limit };
  }

  async function chercherMigration(req: FastifyRequest): Promise<unknown> {
    const f = await annuaireActif(req);
    const { query } = corpsValide(req, schemaCorpsRechercheMigration);
    if (!query.isWellFormed() || /\p{Cc}/u.test(query)) throw new HttpError(400, REQUETE_INVALIDE);
    return { items: await chercherEntrees(annuaire, f, query) };
  }

  async function rattacherLot(req: FastifyRequest): Promise<unknown> {
    const f = await annuaireActif(req);
    const corps = corpsValide(req, schemaCorpsRattachement);
    const operateur = utilisateur(req);
    const resultats = await rattacherComptes(
      { ...annuaire, revoquer: dep.revoquer },
      f,
      corps.links,
      new Set(corps.confirm_admins),
      { id: operateur, username: req.utilisateur?.username ?? null, ip: ipDeRequete(req) },
    );
    return { results: resultats };
  }

  async function detacherCompte(req: FastifyRequest): Promise<unknown> {
    const operateur = utilisateur(req);
    const cible = entierDuChemin(req, "target_id");
    const { new_password: motDePasse } = corpsValide(req, schemaCorpsDetachement);
    if (cible === operateur) throw new HttpError(400, "Vous ne pouvez pas détacher votre propre compte.");
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Utilisateur introuvable");
    validerMotDePasse(motDePasse, auth.config());
    const t = maintenant();
    const detache = await base.ecriture((x) => detacher(x, cible, motDePasse, t));
    if (detache === null) throw new HttpError(409, "Ce compte n'est rattaché à aucune identité.");
    try {
      await dep.revoquer(cible);
    } catch (e) {
      dep.journal.error({ err: e }, "[admin] publication session_revoked (détachement) échouée");
    }
    await revoquerTousAcces(auth, cible);
    auditer(req, "auth.identity.unlink", {
      target_user_id: cible,
      provider_id: detache.fournisseurId,
      by: `admin:${operateur}`,
    });
    return { ok: true };
  }

  const vuePrepare = (
    l: LigneRattachementPrepare & { username?: string | null },
  ): Record<string, unknown> => ({
    id: Number(l.id),
    user_id: Number(l.user_id),
    username: l.username ?? null,
    expected: l.expected,
    waiver: Number(l.waiver) === 1,
    created_by: Number(l.created_by),
    created_at: Number(l.created_at),
    expires_at: Number(l.expires_at),
  });

  async function listerPrepares(req: FastifyRequest): Promise<unknown> {
    const id = fournisseurOidc(req);
    await base.ecriture((x) => purgerRattachementsPerimes(x, maintenant()));
    const lignes = await base.all<LigneRattachementPrepare & { username: string | null }>(
      "SELECT p.id, p.user_id, p.provider_id, p.expected, p.waiver, p.created_by, p.created_at, p.expires_at, u.username FROM auth_prelinks p LEFT JOIN users u ON u.id=p.user_id WHERE p.provider_id=? ORDER BY p.created_at DESC, p.id DESC",
      [id],
    );
    return { items: lignes.map(vuePrepare) };
  }

  async function creerPrepare(req: FastifyRequest): Promise<unknown> {
    const id = fournisseurOidc(req);
    const corps = corpsValide(req, schemaCorpsRattachementPrepare);
    const attendu = attenduValide(corps.expected);
    if (attendu === null) throw new HttpError(400, REQUETE_INVALIDE);
    const operateur = utilisateur(req);
    const t = maintenant();
    const r = await base.ecriture((x) =>
      preparerRattachement(x, {
        uid: corps.user_id,
        fournisseurId: id,
        attendu,
        dispense: corps.waiver,
        confirmeAdmin: corps.confirm_admin,
        par: operateur,
        t,
      }),
    );
    if ("raison" in r) {
      const [statut, message] = REFUS_PREPARE[r.raison];
      throw new HttpError(statut, message);
    }
    auditer(req, "auth.prelink.create", {
      target_user_id: corps.user_id,
      provider_id: id,
      waiver: corps.waiver,
      by: `admin:${operateur}`,
    });
    const ligne = await base.get<LigneRattachementPrepare & { username: string | null }>(
      "SELECT p.id, p.user_id, p.provider_id, p.expected, p.waiver, p.created_by, p.created_at, p.expires_at, u.username FROM auth_prelinks p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=?",
      [r.id],
    );
    if (ligne === undefined) throw new HttpError(409, "Rattachement préparé introuvable.");
    return vuePrepare(ligne);
  }

  async function supprimerPrepare(req: FastifyRequest): Promise<unknown> {
    const id = fournisseurOidc(req);
    const prelinkId = entierDuChemin(req, "prelink_id");
    const cible = await base.ecriture(async (x) => {
      const l = await x.get<{ user_id: number }>(
        "SELECT user_id FROM auth_prelinks WHERE id=? AND provider_id=?",
        [prelinkId, id],
      );
      if (l === undefined) return null;
      await x.run("DELETE FROM auth_prelinks WHERE id=?", [prelinkId]);
      return Number(l.user_id);
    });
    if (cible === null) throw new HttpError(404, "Rattachement préparé introuvable.");
    auditer(req, "auth.prelink.delete", {
      target_user_id: cible,
      provider_id: id,
      by: `admin:${utilisateur(req)}`,
    });
    return { ok: true };
  }

  const sansCache =
    (traiter: Traitement): Traitement =>
    async (req, rep) => {
      void rep.headers(SANS_CACHE);
      return traiter(req, rep);
    };

  return {
    nom: "admin-rattachement",
    routes: [
      route("GET", "/api/admin/auth/providers/:id/migration", sansCache(lireMigration)),
      route("POST", "/api/admin/auth/providers/:id/migration/search", sansCache(chercherMigration)),
      route("POST", "/api/admin/auth/providers/:id/migration/link", sansCache(rattacherLot)),
      route("POST", "/api/admin/users/:target_id/identity/detach", detacherCompte),
      route("GET", "/api/admin/auth/providers/:id/prelinks", sansCache(listerPrepares)),
      route("POST", "/api/admin/auth/providers/:id/prelinks", creerPrepare),
      route("DELETE", "/api/admin/auth/providers/:id/prelinks/:prelink_id", supprimerPrepare),
    ],
  };
}
