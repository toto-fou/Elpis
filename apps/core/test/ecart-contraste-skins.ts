// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-contraste-skins.ts — écart voulu au Python : jetons d'état et d'accent des skins livrés relevés au contraste AA ; contenu servi ramené à sa forme d'avant pour rejouer les vecteurs. */

/** Blocs d'aujourd'hui → blocs du Python (Elpis, Parchemin, Pingouins clair puis sombre). */
const AVANT: readonly (readonly [string, string])[] = [
  [
    "    --ok:             #6f7040;\n    --ok-strong:      #5a5b33;\n",
    "    --ok:             #8a8b52;\n    --ok-strong:      #6f7040;\n",
  ],
  [
    "    --ok-text:        #6f7040;\n    --ok-text-strong: #5a5b33;\n",
    "    --ok-text:        #7c7a45;\n    --ok-text-strong: #666636;\n",
  ],
  [
    "    --accent-fg:          #1f1e1d;\n    --accent-text:        #ad5034;\n    --accent-text-strong: #8f3f26;\n",
    "    --accent-fg:          var(--cl-clay-fg);\n    --accent-text:        var(--cl-clay-deep);\n    --accent-text-strong: #ad5034;\n",
  ],
  [
    "    --accent-text:        #d6006e;\n    --accent-text-strong: #b0005a;\n",
    "    --accent-text:        var(--tr-pink);\n    --accent-text-strong: #d6006e;\n",
  ],
  [
    "    --accent-text:        var(--tr-pink);\n    --accent-text-strong: #ff7ab8;\n",
    "    --accent-text-strong: #ff7ab8;\n",
  ],
];

/** Le contenu avec les jetons d'avant le relèvement (inchangé pour une autre feuille). */
export function sansContrasteAA(css: Buffer): Buffer {
  let texte = css.toString("utf-8");
  let change = false;
  for (const [apres, avant] of AVANT) {
    if (!texte.includes(apres)) continue;
    texte = texte.replace(apres, avant);
    change = true;
  }
  return change ? Buffer.from(texte, "utf-8") : css;
}
