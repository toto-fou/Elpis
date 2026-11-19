// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-identite-balayage.ts — console › connexion d'entreprise : passe immédiate de l'annuaire et confirmation des suspensions retenues par le garde-fou de masse (admins seulement). */
import { estDict, HttpError } from "@elpis/commun";
import { corpsJson } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditer } from "../admin/aides";
import { balayerAnnuaire, etatBalayage } from "../identite/annuaire/balayage";
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

  async function confirmer(req: FastifyRequest, rep: FastifyReply): Promise<EtatBalayage> {
    const f = await annuaire(idDuChemin(req));
    const corps = corpsJson(req);
    const vu = estDict(corps) ? corps["pending"] : undefined;
    if (!Number.isInteger(vu) || (vu as number) < 1 || Object.keys(corps as object).length !== 1)
      throw new HttpError(400, "Champ « pending » : entier positif attendu.");
    const stocke = await etatBalayage(dep.base, f.id);
    if (stocke === null || stocke.pending !== vu)
      throw new HttpError(409, "Le décompte a changé : relisez l'état avant de confirmer.");
    const r = await balayerAnnuaire(dep, f, { confirmer: vu as number });
    if (r.type === "occupe") throw new HttpError(409, "Une passe est déjà en cours pour cet annuaire.");
    if (r.type === "decompte_change" || r.etat.aborted !== null)
      throw new HttpError(409, "Le décompte a changé : relisez l'état avant de confirmer.");
    auditer(req, "admin.auth.sweep.confirm", {
      provider_id: f.id,
      confirmed: vu,
      suspended: r.etat.suspended,
    });
    void rep.headers(SANS_CACHE);
    return r.etat;
  }

  return {
    nom: "admin-identite-balayage",
    routes: [
      route("/api/admin/auth/providers/:id/sweep", passer),
      route("/api/admin/auth/providers/:id/sweep/confirm", confirmer),
    ],
  };
}
