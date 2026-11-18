// SPDX-License-Identifier: MIT
/** packages/auth/src/etat-compte.ts — état d'un compte : suspendu quand `suspended_at` est positif, lecture tolérante d'une valeur absente. */

/** Vrai si la ligne du compte porte une suspension (valeur nulle, absente ou illisible : actif). */
export function compteSuspendu(ligne: { suspended_at?: unknown } | null | undefined): boolean {
  const v = Number(ligne?.suspended_at ?? 0);
  return Number.isFinite(v) && v > 0;
}
