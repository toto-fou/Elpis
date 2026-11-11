// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-longueur-explicite.ts — écart voulu au Python : une longueur explicite n'est plus plafonnée par `clampGenerationBudget` (bornée à l'envoi par `bornerLongueurALaFenetre`). */
import { entierPy } from "../src/python";

type Dict = Record<string, unknown>;

const CLES = ["max_tokens", "n_predict"] as const;

/** Sortie attendue du TS pour un vecteur Python : les clés de longueur réécrites à partir d'une longueur explicite gardent leur état d'entrée. */
export function sortieSansPlafondExplicite(payload: Dict, sampling: Dict, sortiePython: Dict): Dict {
  const explicite = CLES.some((k) => {
    try {
      return entierPy(sampling[k]) > 0;
    } catch {
      return false;
    }
  });
  if (!explicite) return sortiePython;
  const sortie = { ...sortiePython };
  for (const k of CLES) {
    if (JSON.stringify(sortie[k]) === JSON.stringify(payload[k])) continue;
    if (k in payload) sortie[k] = payload[k];
    else delete sortie[k];
  }
  return sortie;
}

/** Corps llama.cpp attendu du TS : la longueur explicite de l'échantillonnage reste telle que demandée (le Python l'y plafonnait). */
export function corpsSansPlafondExplicite(corpsPython: string, sampling: Dict): string {
  const corps = JSON.parse(corpsPython) as Dict;
  for (const k of CLES) if (k in corps && k in sampling) corps[k] = sampling[k];
  return JSON.stringify(corps);
}
