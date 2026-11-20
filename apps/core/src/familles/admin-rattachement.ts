// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-rattachement.ts — console (admins seulement) : détachement d'un compte de son identité externe, rattachements préparés des fournisseurs OIDC. */
import { ligneUtilisateur } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { schemaCorpsDetachement, schemaCorpsRattachementPrepare } from "@elpis/contracts";
import type { Base } from "@elpis/db";
import { corpsJson, entrees, parametreChemin, py } from "@elpis/http";
import type { FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { auditer } from "../admin/aides";
import { validerMotDePasse } from "../comptes/aides";
import { fournisseurParId } from "../identite/fournisseurs";
import { ancreIdentite } from "../identite/ancre";
import {
  attenduValide,
  detacher,
  revoquerOauthRattachement,
  preparerRattachement,
} from "../identite/rattachement";
import type { LigneRattachementPrepare, RaisonRefusPrepare } from "../identite/rattachement";
import type { Fournisseur } from "../identite/reglages";
import type { Journal } from "../journal";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";

export interface DependancesAdminRattachement {
  readonly base: Base;
  readonly auth: DependancesAuth & DependancesJetons;
  readonly journal: Journal;
  /** Flux ouverts d'un compte coupés dans tous les process (`session_revoked`). */
  readonly revoquer: (uid: number) => Promise<unknown>;
}

const SANS_CACHE = { "cache-control": "no-store" };
const REQUETE_INVALIDE = "Requête invalide.";

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

function entierDuChemin(req: FastifyRequest, nom: string): number {
  return (entrees(req, { path: { [nom]: py.int() } }).path as Record<string, number>)[nom] as number;
}

export function creerFamilleAdminRattachement(dep: DependancesAdminRattachement): Famille {
  const { base, auth } = dep;
  const maintenant = (): number => (auth.maintenant ? auth.maintenant() : Date.now() / 1000);
  /** Fournisseur OIDC de l'identifiant du chemin (allumé ou non) ; 404 s'il n'existe pas. */
  function fournisseurOidc(req: FastifyRequest): Fournisseur {
    const f = fournisseurParId(parametreChemin(req));
    if (f === undefined) throw new HttpError(404, "Fournisseur introuvable.");
    return f;
  }

  async function detacherCompte(req: FastifyRequest): Promise<unknown> {
    const operateur = utilisateur(req);
    const cible = entierDuChemin(req, "target_id");
    const { new_password: motDePasse } = corpsValide(req, schemaCorpsDetachement);
    if (cible === operateur) throw new HttpError(400, "Vous ne pouvez pas détacher votre propre compte.");
    if (!(await ligneUtilisateur(base, cible))) throw new HttpError(404, "Utilisateur introuvable");
    validerMotDePasse(motDePasse, auth.config());
    const detache = await base.ecriture((x) => detacher(x, cible, motDePasse, maintenant()));
    if (detache === null) throw new HttpError(409, "Ce compte n'est rattaché à aucune identité.");
    auditer(req, "auth.identity.unlink", {
      target_user_id: cible,
      provider_id: detache.fournisseurId,
      by: `admin:${operateur}`,
    });
    try {
      await dep.revoquer(cible);
    } catch (e) {
      dep.journal.error({ err: e }, "[admin] publication session_revoked (détachement) échouée");
    }
    await revoquerOauthRattachement({ acces: auth, journal: dep.journal }, cible);
    return { ok: true };
  }

  type LigneVue = Pick<LigneRattachementPrepare, "id" | "expected" | "waiver" | "expires_at"> & {
    username: string | null;
  };
  const vuePrepare = (l: LigneVue): Record<string, unknown> => ({
    id: Number(l.id),
    username: l.username ?? null,
    expected: l.expected,
    waiver: Number(l.waiver) === 1,
    expires_at: Number(l.expires_at),
  });

  async function listerPrepares(req: FastifyRequest): Promise<unknown> {
    const id = fournisseurOidc(req).id;
    const lignes = await base.all<LigneVue>(
      "SELECT p.id, p.expected, p.waiver, p.expires_at, u.username FROM auth_prelinks p LEFT JOIN users u ON u.id=p.user_id WHERE p.provider_id=? AND p.expires_at>? ORDER BY p.created_at DESC, p.id DESC",
      [id, maintenant()],
    );
    return { items: lignes.map(vuePrepare) };
  }

  async function creerPrepare(req: FastifyRequest): Promise<unknown> {
    const fournisseur = fournisseurOidc(req);
    const id = fournisseur.id;
    const ancre = ancreIdentite(fournisseur);
    const corps = corpsValide(req, schemaCorpsRattachementPrepare);
    const attendu = attenduValide(corps.expected);
    if (attendu === null) throw new HttpError(400, REQUETE_INVALIDE);
    const operateur = utilisateur(req);
    const t = maintenant();
    const r = await base.ecriture((x) =>
      preparerRattachement(x, {
        uid: corps.user_id,
        fournisseurId: id,
        ancre,
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
    const ligne = await base.get<LigneVue>(
      "SELECT p.id, p.expected, p.waiver, p.expires_at, u.username FROM auth_prelinks p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=?",
      [r.id],
    );
    if (ligne === undefined) throw new HttpError(409, "Rattachement préparé introuvable.");
    return vuePrepare(ligne);
  }

  async function supprimerPrepare(req: FastifyRequest): Promise<unknown> {
    const id = fournisseurOidc(req).id;
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
      route("POST", "/api/admin/users/:target_id/identity/detach", detacherCompte),
      route("GET", "/api/admin/auth/providers/:id/prelinks", sansCache(listerPrepares)),
      route("POST", "/api/admin/auth/providers/:id/prelinks", creerPrepare),
      route("DELETE", "/api/admin/auth/providers/:id/prelinks/:prelink_id", supprimerPrepare),
    ],
  };
}
