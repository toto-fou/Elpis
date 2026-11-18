// SPDX-License-Identifier: MIT
/** packages/auth/src/etat-compte.ts — état d'un compte : suspendu dès que `suspended_at` est non nul et différent de 0 (valeur illisible comprise). */

/** Vrai si la ligne du compte porte une suspension : valeur absente, nulle ou 0 = actif, toute autre (négative, non numérique) = suspendu. */
export function compteSuspendu(ligne: { suspended_at?: unknown } | null | undefined): boolean {
  const brut = ligne?.suspended_at;
  if (brut === null || brut === undefined || brut === "") return false;
  return Number(brut) !== 0;
}
