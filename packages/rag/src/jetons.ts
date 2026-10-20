// SPDX-License-Identifier: MIT
/** packages/rag/src/jetons.ts — estimation de la taille en jetons (caractères / ratio), sans tokenizer. */

/** Estimation par défaut, prudente pour le français et l'anglais ; à baisser pour le CJK (≈ 1 caractère par jeton). */
export const CARACTERES_PAR_JETON_DEFAUT = 3.3;

function ratioValide(ratio: number | undefined): number {
  return ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? ratio : CARACTERES_PAR_JETON_DEFAUT;
}

/** Nombre de jetons estimé d'un texte. */
export function estimerJetons(texte: string, ratio?: number): number {
  return texte.length === 0 ? 0 : Math.ceil(texte.length / ratioValide(ratio));
}

/** Longueur en caractères équivalente à `jetons` jetons (au moins 1). */
export function jetonsEnCaracteres(jetons: number, ratio?: number): number {
  return Math.max(1, Math.floor(jetons * ratioValide(ratio)));
}
