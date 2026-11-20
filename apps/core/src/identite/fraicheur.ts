// SPDX-License-Identifier: MIT
/** apps/core/src/identite/fraicheur.ts — fournisseurs actifs gardés une seconde par process, et leurs fraîcheurs (durée validée, 1 à 90 jours) : un fournisseur qui n'y figure pas rend ses comptes périmés. */
import type { Fraicheurs } from "@elpis/auth";
import type { Base } from "@elpis/db";

import { fournisseursActifs } from "./fournisseurs";
import type { Fournisseur } from "./reglages";

export const DUREE_CACHE_FRAICHEUR_MS = 1000;

/** Lecteur des fournisseurs actifs construit sur `fournisseursActifs` ; `cookieSecure` est la valeur du process appelant. */
export function lecteurActifs(
  base: Base,
  cookieSecure: () => boolean,
  horlogeMs: () => number = Date.now,
): () => Promise<Fournisseur[]> {
  let garde: { jusqua: number; valeur: Promise<Fournisseur[]> } | null = null;
  return () => {
    const t = horlogeMs();
    if (garde !== null && t < garde.jusqua) return garde.valeur;
    const valeur = fournisseursActifs(base, cookieSecure);
    garde = { jusqua: t + DUREE_CACHE_FRAICHEUR_MS, valeur };
    valeur.catch(() => {
      if (garde?.valeur === valeur) garde = null;
    });
    return valeur;
  };
}

/** Fraîcheurs (jours) des fournisseurs actifs que rend ce lecteur. */
export function fraicheursDe(actifs: () => Promise<Fournisseur[]>): () => Promise<Fraicheurs> {
  return async () => new Map((await actifs()).map((f) => [f.id, f.freshness_days] as const));
}
