// SPDX-License-Identifier: MIT
/** apps/core/src/identite/cle-identifiant.ts — clé d'un identifiant tapé : forme comparée par l'annuaire et par le compte local, `null` s'il n'est pas admis. */

const INADMIS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Mn}\p{Me}\p{Zl}\p{Zp}]|(?! )\p{Zs}| {2}/u;

/** NFKC, espaces de bord retirés, minuscules ; `null` si un caractère invisible, combinant ou une espace insolite subsiste, ou deux espaces de suite. */
export function cleIdentifiant(saisie: string): string | null {
  if (typeof saisie !== "string" || !saisie.isWellFormed()) return null;
  const cle = saisie.normalize("NFKC").trim().toLowerCase();
  return cle === "" || INADMIS.test(cle) ? null : cle;
}
