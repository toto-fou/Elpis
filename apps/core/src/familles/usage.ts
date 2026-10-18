// SPDX-License-Identifier: MIT
/** apps/core/src/familles/usage.ts — `GET /api/usage/me` : usage du compte connecté seul, fenêtre ramenée à 1, 7, 30 ou 90 jours (shared_infra/observability/routes_usage.py). */
import type { Base } from "@elpis/db";

import { fenetreJours, usageDuCompte } from "../observabilite/usage-compte";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { entrees, py } from "@elpis/http";

export interface DependancesUsage {
  readonly base: Base;
}

export function creerFamilleUsage(dep: DependancesUsage): Famille {
  return {
    nom: "usage",
    routes: [
      {
        methode: "GET",
        chemin: "/api/usage/me",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const uid = utilisateur(req);
          const { query } = entrees(req, { query: { days: py.str().defaut("30") } });
          const corps = await usageDuCompte(dep.base, uid, fenetreJours(query.days));
          void rep.header("cache-control", "no-cache");
          return corps;
        },
      },
    ],
  };
}
