// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/budget-battement.ts — budget du battement du flux : moyenne glissante du coût d'un battement, un battement toutes les n images au-delà du seuil. */

const IMAGE_MS = 1000 / 60;
const SEUIL_MS = 9;
const CADENCE_MAX = 6;
const FACTEUR = 0.25;
const HYSTERESIS_MS = 1;
const TOLERANCE = 0.15;

export interface BudgetBattement {
  /** Coût moyen d'un battement, en ms (0 : aucune mesure). */
  moyenne: number;
  /** Un battement toutes les `cadence` images de 1/60 s. */
  cadence: number;
  /** Date du dernier battement exécuté. */
  dernier: number;
}

export function creerBudget(): BudgetBattement {
  return { moyenne: 0, cadence: 1, dernier: -Infinity };
}

/** Intègre le coût d'un battement ; la cadence monte d'un cran par tranche de 9 ms (la moitié d'une image) et redescend avec une marge. */
export function noterCout(b: BudgetBattement, ms: number): void {
  b.moyenne = b.moyenne ? b.moyenne + FACTEUR * (ms - b.moyenne) : ms;
  const cible = Math.min(CADENCE_MAX, Math.max(1, Math.ceil(b.moyenne / SEUIL_MS)));
  if (cible >= b.cadence) b.cadence = cible;
  else if (b.moyenne <= (b.cadence - 1) * SEUIL_MS - HYSTERESIS_MS) b.cadence = cible;
}

/** Vrai si ce battement est sauté (trop proche du précédent) ; les tampons continuent de se remplir. Au plus 60 par seconde, quel que soit l'écran. */
export function sauterImage(b: BudgetBattement, maintenant: number): boolean {
  if (maintenant - b.dernier < (b.cadence - TOLERANCE) * IMAGE_MS) return true;
  b.dernier = maintenant;
  return false;
}
