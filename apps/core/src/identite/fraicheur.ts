// SPDX-License-Identifier: MIT
/** apps/core/src/identite/fraicheur.ts — fraîcheurs des fournisseurs actifs (durée validée, 1 à 90 jours), gardées une seconde par process : un fournisseur qui n'y figure pas rend ses comptes périmés. */
import type { Fraicheurs } from "@elpis/auth";
import type { Base } from "@elpis/db";

import { fournisseursActifs } from "./fournisseurs";

export const DUREE_CACHE_FRAICHEUR_MS = 1000;

/** Lecteur de fraîcheurs construit sur `fournisseursActifs` ; `cookieSecure` est la valeur du process appelant. */
export function lecteurFraicheurs(
  base: Base,
  cookieSecure: () => boolean,
  horlogeMs: () => number = Date.now,
): () => Promise<Fraicheurs> {
  let garde: { jusqua: number; valeur: Promise<Fraicheurs> } | null = null;
  return () => {
    const t = horlogeMs();
    if (garde !== null && t < garde.jusqua) return garde.valeur;
    const valeur = fournisseursActifs(base, cookieSecure).then(
      (liste) => new Map(liste.map((f) => [f.id, f.freshness_days] as const)),
    );
    garde = { jusqua: t + DUREE_CACHE_FRAICHEUR_MS, valeur };
    valeur.catch(() => {
      if (garde?.valeur === valeur) garde = null;
    });
    return valeur;
  };
}
