// SPDX-License-Identifier: MIT
/** frontend/test/css/contraste.test.ts — contraste WCAG AA des jetons d'état et d'accent, pour chaque thème en clair et en sombre. */
import { PAIRES_TEXTE, SEUIL_TEXTE } from "@elpis/commun/couleurs";
import { describe, expect, it } from "vitest";

import { THEMES, mesure } from "./contraste";

describe.each(THEMES.flatMap((t) => [[t, false] as const, [t, true] as const]))(
  "thème %s (sombre : %s)",
  (theme, sombre) => {
    it.each(PAIRES_TEXTE)(
      "%s sur %s : au moins 4,5:1 (texte), donc au-delà des 3:1 des signes",
      (fg, fond) => {
        const r = mesure(theme, sombre, fg, fond);
        expect(r, `${fg} / ${fond} introuvable`).not.toBeNull();
        expect(r).toBeGreaterThanOrEqual(SEUIL_TEXTE);
      },
    );
  },
);
