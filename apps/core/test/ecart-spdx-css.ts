// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-spdx-css.ts — écart voulu au Python : les feuilles de style livrées portent un en-tête SPDX d'une ligne ; contenu servi ramené à sa forme d'avant pour rejouer les vecteurs. */
export const ENTETE_SPDX_CSS = Buffer.from("/* SPDX-License-Identifier: MIT */\n");

/** Le contenu sans sa ligne SPDX (la première, en début de ligne ; inchangé s'il n'en a pas). */
export function sansEnteteSpdx(css: Buffer): Buffer {
  let i = css.indexOf(ENTETE_SPDX_CSS);
  while (i > 0 && css[i - 1] !== 0x0a) i = css.indexOf(ENTETE_SPDX_CSS, i + 1);
  return i < 0 ? css : Buffer.concat([css.subarray(0, i), css.subarray(i + ENTETE_SPDX_CSS.length)]);
}
