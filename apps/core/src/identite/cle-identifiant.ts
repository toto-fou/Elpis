// SPDX-License-Identifier: MIT
/** apps/core/src/identite/cle-identifiant.ts — clé d'un identifiant tapé : forme comparée par l'annuaire et par le compte local, `null` s'il n'est pas admis. */

/** Caractères que RFC 4518 §2.2 (« map to nothing ») fait disparaître à la comparaison, un intervalle par élément. */
const SANS_EFFET = [
  "\\u00AD",
  "\\u034F",
  "\\u06DD",
  "\\u070F",
  "\\u1806",
  "\\u180B-\\u180E",
  "\\u200B-\\u200F",
  "\\u2060-\\u2064",
  "\\uFE00-\\uFE0F",
  "\\uFEFF",
  "\\uFFF9-\\uFFFC",
  "\\u{1D173}-\\u{1D17A}",
  "\\u{E0001}",
  "\\u{E0020}-\\u{E007F}",
  "\\u{E0100}-\\u{E01EF}",
].map((i) => `[${i}]`);
const INADMIS = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Mn}\\p{Me}\\p{Zl}\\p{Zp}]|${SANS_EFFET.join("|")}|(?! )\\p{Zs}| {2}`,
  "u",
);
const A_RETIRER = new RegExp(SANS_EFFET.join("|"), "gu");

/** NFKC, espaces de bord retirés, minuscules ; `null` si un caractère invisible, combinant ou une espace insolite subsiste, ou deux espaces de suite. */
export function cleIdentifiant(saisie: string): string | null {
  if (typeof saisie !== "string" || !saisie.isWellFormed()) return null;
  const cle = saisie.normalize("NFKC").trim().toLowerCase();
  return cle === "" || INADMIS.test(cle) ? null : cle;
}

/** Forme de comparaison d'un nom quelconque (compte local, entrée d'annuaire) : NFKC, caractères sans effet retirés, repli de casse complet (`ß` = `ss`), sans jamais refuser. */
export function cleComparee(nom: string): string {
  return nom.normalize("NFKC").replace(A_RETIRER, "").trim().toUpperCase().toLowerCase();
}
