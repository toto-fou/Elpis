// SPDX-License-Identifier: MIT
/** apps/core/src/familles/systeme.ts — routes système simples. */
import type { Famille } from "../routes";

export const familleSysteme: Famille = {
  nom: "systeme",
  routes: [
    {
      methode: "GET",
      chemin: "/api/health",
      processus: ["main", "admin"],
      acces: "public",
      traiter: () => ({ status: "ok" }),
    },
  ],
};
