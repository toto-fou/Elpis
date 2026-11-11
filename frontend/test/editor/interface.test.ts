// SPDX-License-Identifier: MIT
/** frontend/test/editor/interface.test.ts — éditeur du compte : selon le skin par défaut, classique sur demande ou si le skin n'a pas de feuille d'éditeur. */
import { describe, expect, it } from "vitest";

import {
  CHOIX_INTERFACES_EDITEUR,
  INTERFACES_EDITEUR,
  interfaceAffichee,
  lireInterfaceEditeur,
} from "../../src/features/editor/interface";

const FEUILLE = "/static/css/skins/elpis/editeur.css";

describe("choix du compte", () => {
  it("selon le skin tant que le classique n'est pas demandé", () => {
    expect(lireInterfaceEditeur(undefined)).toBe("skin");
    expect(lireInterfaceEditeur({})).toBe("skin");
    expect(lireInterfaceEditeur({ editor_ui: "modern" })).toBe("skin");
    expect(lireInterfaceEditeur({ editor_ui: 3 })).toBe("skin");
    expect(lireInterfaceEditeur({ editor_ui: "skin" })).toBe("skin");
  });

  it("classique seulement si le compte l'a choisi", () => {
    expect(lireInterfaceEditeur({ editor_ui: "classic" })).toBe("classic");
  });

  it("le réglage propose les deux, selon le skin d'abord, classique toujours présent", () => {
    expect(CHOIX_INTERFACES_EDITEUR.map((c) => c.valeur)).toEqual([...INTERFACES_EDITEUR]);
    expect(CHOIX_INTERFACES_EDITEUR.map((c) => c.libelle)).toEqual(["Selon le skin", "Classique"]);
    for (const c of CHOIX_INTERFACES_EDITEUR) expect(c.aide.length).toBeGreaterThan(10);
  });
});

describe("interface affichée", () => {
  it("le style du skin par défaut, s'il a une feuille d'éditeur", () => {
    expect(interfaceAffichee({}, FEUILLE)).toBe("skin");
    expect(interfaceAffichee({ editor_ui: "skin" }, FEUILLE)).toBe("skin");
  });

  it("skin sans editeur.css : classique, quel que soit le choix", () => {
    expect(interfaceAffichee({}, "")).toBe("classic");
    expect(interfaceAffichee({ editor_ui: "skin" }, "")).toBe("classic");
  });

  it("classique choisi : classique, même si le skin a sa feuille", () => {
    expect(interfaceAffichee({ editor_ui: "classic" }, FEUILLE)).toBe("classic");
  });
});
