// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-identite-balayage.ts — console › connexion d'entreprise : passe immédiate de l'annuaire et confirmation des suspensions retenues par le garde-fou de masse (admins seulement). */
import { estDict, HttpError } from "@elpis/commun";
import { corpsJson } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditer } from "../admin/aides";
import { balayerAnnuaire, RETENUS_MAX } from "../identite/annuaire/balayage";
import type { DependancesBalayage, EtatBalayage } from "../identite/annuaire/balayage";
import { annuairesActifs } from "../identite/annuaire/connexion";
import type { FournisseurLdap } from "../identite/reglages";
import type { DefinitionRoute, Famille, Traitement } from "../routes";

const SANS_CACHE = { "cache-control": "no-store" };

function route(chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode: "POST", chemin, processus: ["admin"], acces: "admin", traiter };
}

function idDuChemin(req: FastifyRequest): string {
  const brut = (req.params as Record<string, unknown> | undefined)?.["id"];
  return typeof brut === "string" ? brut : "";
}

export function creerFamilleAdminIdentiteBalayage(dep: DependancesBalayage): Famille {
  /** Annuaire actif de ce nom ; 404 s'il n'existe pas, 409 s'il n'est pas actif. */
  async function annuaire(id: string): Promise<FournisseurLdap> {
    const actifs = await annuairesActifs(dep);
    const f = actifs.find((a) => a.id === id);
    if (f !== undefined) return f;
    throw new HttpError(404, "Annuaire introuvable ou inactif.");
  }

  async function passer(req: FastifyRequest, rep: FastifyReply): Promise<EtatBalayage> {
    const f = await annuaire(idDuChemin(req));
    const r = await balayerAnnuaire(dep, f);
    if (r.type === "verrou_indisponible")
      throw new HttpError(503, "La vérification est indisponible : demandez à votre administrateur.");
    if (r.type !== "bilan") throw new HttpError(409, "Une passe est déjà en cours pour cet annuaire.");
    auditer(req, "admin.auth.sweep", {
      provider_id: f.id,
      seen: r.etat.seen,
      suspended: r.etat.suspended,
      reactivated: r.etat.reactivated,
      aborted: r.etat.aborted,
    });
    void rep.headers(SANS_CACHE);
    return r.etat;
  }

  /** Identifiants confirmés : la liste vue par l'administrateur, entiers positifs distincts, 200 au plus. */
  function comptesConfirmes(req: FastifyRequest): number[] {
    const corps = corpsJson(req);
    const liste = estDict(corps) ? corps["user_ids"] : undefined;
    const valide =
      Array.isArray(liste) &&
      liste.length >= 1 &&
      liste.length <= RETENUS_MAX &&
      liste.every((v) => Number.isInteger(v) && (v as number) >= 1) &&
      new Set(liste).size === liste.length &&
      Object.keys(corps as object).length === 1;
    if (!valide) throw new HttpError(400, "Champ « user_ids » : liste d'identifiants distincts attendue.");
    return liste as number[];
  }

  async function confirmer(req: FastifyRequest, rep: FastifyReply): Promise<EtatBalayage> {
    const f = await annuaire(idDuChemin(req));
    const ids = comptesConfirmes(req);
    const r = await balayerAnnuaire(dep, f, { confirmer: ids });
    if (r.type === "occupe") throw new HttpError(409, "Une passe est déjà en cours pour cet annuaire.");
    if (r.type === "verrou_indisponible")
      throw new HttpError(503, "La vérification est indisponible : demandez à votre administrateur.");
    const etat = r.etat;
    if (r.type === "decompte_change" || etat.aborted !== null)
      throw new HttpError(409, {
        message: "La liste a changé : relisez l'état avant de confirmer.",
        sweep: etat,
      });
    auditer(req, "admin.auth.sweep.confirm", {
      provider_id: f.id,
      confirmed_user_ids: ids,
      confirmed: ids.length,
      suspended: etat.suspended,
    });
    void rep.headers(SANS_CACHE);
    return etat;
  }

  return {
    nom: "admin-identite-balayage",
    routes: [
      route("/api/admin/auth/providers/:id/sweep", passer),
      route("/api/admin/auth/providers/:id/sweep/confirm", confirmer),
    ],
  };
}
