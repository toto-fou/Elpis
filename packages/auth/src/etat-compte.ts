// SPDX-License-Identifier: MIT
/** packages/auth/src/etat-compte.ts — état d'un compte : suspendu dès que `suspended_at` est non nul et différent de 0 (valeur illisible comprise). */

const ZERO_TEXTE = /^0(\.0+)?$/u;

/** Vrai si la ligne du compte porte une suspension : valeur absente, nulle ou 0 (nombre ou texte « 0 », « 0.0 ») = actif, toute autre (négative, vide, non numérique) = suspendu. */
export function compteSuspendu(ligne: { suspended_at?: unknown } | null | undefined): boolean {
  const brut = ligne?.suspended_at;
  if (brut === null || brut === undefined) return false;
  if (typeof brut === "string") return !ZERO_TEXTE.test(brut);
  return Number(brut) !== 0;
}
