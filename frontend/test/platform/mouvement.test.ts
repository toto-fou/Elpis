// SPDX-License-Identifier: MIT
/** frontend/test/platform/mouvement.test.ts — animations de l'interface : le choix du compte l'emporte sur le poste dans le code et dans les feuilles, il est gardé par le navigateur, et « système » ne touche à rien. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  choixMouvementMemorise,
  CLE_MOUVEMENT,
  definirMouvement,
  lireChoixMouvement,
  mouvementReduit,
  mouvementReduitPour,
} from "../../src/platform/mouvement";

const FEUILLE = `
  .volet { transition: width 260ms }
  @media (prefers-reduced-motion: reduce) { .volet { transition: none } }
  @media (prefers-reduced-motion: no-preference) { .menu { transform: translateY(6px) } }
  @media (min-width: 640px) { .large { display: block } }
  @supports (display: block) { @media (prefers-reduced-motion: reduce) { .anime { animation: none } } }
  @media screen and (prefers-reduced-motion) { .ecran { animation: none } }
`;

let ecouteurs: (() => void)[] = [];

/** Poste qui demande, ou non, moins de mouvement ; `basculer` rejoue le changement du réglage du poste. */
function poste(reduit: boolean): { basculer(v: boolean): void } {
  const liste = {
    matches: reduit,
    addEventListener: (_: string, f: () => void) => ecouteurs.push(f),
    removeEventListener: (_: string, f: () => void) => {
      ecouteurs = ecouteurs.filter((e) => e !== f);
    },
  };
  vi.stubGlobal("matchMedia", () => liste);
  return {
    basculer(v) {
      liste.matches = v;
      for (const f of [...ecouteurs]) f();
    },
  };
}

function poserFeuille(css = FEUILLE): HTMLStyleElement {
  const s = document.createElement("style");
  s.textContent = css;
  document.head.append(s);
  return s;
}

/** Textes des requêtes média de la page, groupes compris, dans l'ordre des feuilles. */
function medias(): string[] {
  const lus: string[] = [];
  const visiter = (regles: CSSRuleList): void => {
    for (const r of Array.from(regles)) {
      if (r instanceof CSSMediaRule) lus.push(r.media.mediaText);
      const filles = (r as Partial<CSSGroupingRule>).cssRules;
      if (filles?.length) visiter(filles);
    }
  };
  for (const f of Array.from(document.styleSheets)) visiter(f.cssRules);
  return lus;
}

const ORIGINE = [
  "(prefers-reduced-motion: reduce)",
  "(prefers-reduced-motion: no-preference)",
  "(min-width: 640px)",
  "(prefers-reduced-motion: reduce)",
  "screen and (prefers-reduced-motion)",
];
const INVERSE = [
  "(prefers-reduced-motion: no-preference)",
  "(prefers-reduced-motion: reduce)",
  "(min-width: 640px)",
  "(prefers-reduced-motion: no-preference)",
  "screen and (prefers-reduced-motion: no-preference)",
];

afterEach(() => {
  definirMouvement("system");
  document.head.querySelectorAll("style").forEach((s) => s.remove());
  localStorage.clear();
  ecouteurs = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("choix du compte", () => {
  it("toute valeur hors liste suit le poste", () => {
    expect(["system", "full", "reduced"].map(lireChoixMouvement)).toEqual(["system", "full", "reduced"]);
    for (const v of [undefined, null, "", "Full", "none", 1, true, {}])
      expect(lireChoixMouvement(v)).toBe("system");
  });

  it("l'emporte sur le poste, qui ne décide que pour « système »", () => {
    for (const reduit of [true, false]) {
      poste(reduit);
      expect(mouvementReduitPour("system")).toBe(reduit);
      expect(mouvementReduitPour("full")).toBe(false);
      expect(mouvementReduitPour("reduced")).toBe(true);
      definirMouvement("full");
      expect(mouvementReduit()).toBe(false);
      definirMouvement("reduced");
      expect(mouvementReduit()).toBe(true);
      definirMouvement("system");
      expect(mouvementReduit()).toBe(reduit);
    }
  });

  it("sans requête média disponible : mouvement complet, rien ne casse", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("indisponible");
    });
    expect(mouvementReduit()).toBe(false);
    expect(() => definirMouvement("reduced")).not.toThrow();
    expect(mouvementReduit()).toBe(true);
  });
});

describe("mémoire du navigateur", () => {
  it("garde le dernier choix appliqué ; « système » l'efface", () => {
    poste(false);
    expect(choixMouvementMemorise()).toBe("system");
    definirMouvement("full");
    expect(localStorage.getItem(CLE_MOUVEMENT)).toBe("full");
    expect(choixMouvementMemorise()).toBe("full");
    definirMouvement("reduced");
    expect(choixMouvementMemorise()).toBe("reduced");
    definirMouvement("system");
    expect(localStorage.getItem(CLE_MOUVEMENT)).toBeNull();
  });

  it("valeur illisible ou stockage refusé : suit le poste, rien ne casse", () => {
    poste(false);
    localStorage.setItem(CLE_MOUVEMENT, "turbo");
    expect(choixMouvementMemorise()).toBe("system");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("refusé");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("refusé");
    });
    expect(choixMouvementMemorise()).toBe("system");
    expect(() => definirMouvement("full")).not.toThrow();
    expect(mouvementReduit()).toBe(false);
  });
});

describe("feuilles de style", () => {
  it("« système », ou un choix d'accord avec le poste : aucune requête média n'est touchée", () => {
    poserFeuille();
    for (const [reduit, choix] of [
      [true, "system"],
      [false, "system"],
      [true, "reduced"],
      [false, "full"],
    ] as const) {
      poste(reduit);
      definirMouvement(choix);
      expect(medias()).toEqual(ORIGINE);
    }
  });

  it("« complètes » sur un poste qui réduit, « réduites » sur un poste qui ne réduit pas : requêtes inversées, les autres intactes", () => {
    poserFeuille();
    for (const [reduit, choix] of [
      [true, "full"],
      [false, "reduced"],
    ] as const) {
      poste(reduit);
      definirMouvement(choix);
      expect(medias()).toEqual(INVERSE);
      definirMouvement(choix);
      expect(medias()).toEqual(INVERSE);
      definirMouvement("system");
      expect(medias()).toEqual(ORIGINE);
    }
  });

  it("une feuille posée après coup est inversée à son tour, une seule fois", async () => {
    poste(true);
    poserFeuille();
    definirMouvement("full");
    poserFeuille("@media (prefers-reduced-motion: reduce) { .skin { transition: none } }");
    await new Promise((r) => setTimeout(r, 0));
    expect(medias()).toEqual([...INVERSE, "(prefers-reduced-motion: no-preference)"]);
    document.title = "autre mutation de la tête";
    await new Promise((r) => setTimeout(r, 0));
    expect(medias()).toEqual([...INVERSE, "(prefers-reduced-motion: no-preference)"]);
    definirMouvement("system");
    expect(medias()).toEqual([...ORIGINE, "(prefers-reduced-motion: reduce)"]);
  });

  it("une feuille liée est inversée à son chargement", () => {
    poste(true);
    definirMouvement("full");
    const lien = document.createElement("link");
    document.head.append(lien);
    const s = document.createElement("style");
    s.textContent = "@media (prefers-reduced-motion: reduce) { .a { transition: none } }";
    document.body.append(s);
    try {
      expect(medias()).toEqual(["(prefers-reduced-motion: reduce)"]);
      lien.dispatchEvent(new Event("load"));
      expect(medias()).toEqual(["(prefers-reduced-motion: no-preference)"]);
    } finally {
      s.remove();
      lien.remove();
    }
  });

  it("le réglage du poste change en cours de route : les feuilles suivent", () => {
    const p = poste(true);
    poserFeuille();
    definirMouvement("full");
    expect(medias()).toEqual(INVERSE);
    p.basculer(false);
    expect(medias()).toEqual(ORIGINE);
    expect(mouvementReduit()).toBe(false);
    p.basculer(true);
    expect(medias()).toEqual(INVERSE);
    expect(mouvementReduit()).toBe(false);
  });
});
