// SPDX-License-Identifier: MIT
/** frontend/test/editor/couches.test.ts — menus de l'interface moderne : Échap ferme le menu du dessus, sinon la cascade continue ; explorateur posé sur le code. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  empilerCouche,
  explorateurSuperpose,
  fermerCoucheOuverte,
  garderDansCadre,
} from "../../src/features/editor/couches";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Échap", () => {
  it("rien d'ouvert : la cascade continue", () => {
    expect(fermerCoucheOuverte()).toBe(false);
  });

  it("le menu du dessus d'abord ; retiré, il ne se ferme plus", () => {
    const dessous = vi.fn();
    const dessus = vi.fn();
    const retirerDessous = empilerCouche(dessous);
    const retirerDessus = empilerCouche(dessus);
    expect(fermerCoucheOuverte()).toBe(true);
    expect(dessus).toHaveBeenCalledOnce();
    expect(dessous).not.toHaveBeenCalled();
    retirerDessus();
    expect(fermerCoucheOuverte()).toBe(true);
    expect(dessous).toHaveBeenCalledOnce();
    retirerDessous();
    expect(fermerCoucheOuverte()).toBe(false);
  });
});

describe("menu dans son cadre", () => {
  function menuDans(cadre: Partial<DOMRect>, boite: Partial<DOMRect>): HTMLElement {
    document.body.innerHTML = '<div class="elpis-ed-corps"><div id="m"></div></div>';
    const m = document.getElementById("m") as HTMLElement;
    (m.parentElement as HTMLElement).getBoundingClientRect = () => cadre as DOMRect;
    m.getBoundingClientRect = () => boite as DOMRect;
    return m;
  }

  it("débordement à gauche ou à droite : décalé d'autant, marge comprise", () => {
    const gauche = menuDans({ left: 100, right: 500 }, { left: 40, right: 280 });
    garderDansCadre(gauche);
    expect(gauche.style.translate).toBe("66px");
    const droite = menuDans({ left: 0, right: 400 }, { left: 200, right: 430 });
    garderDansCadre(droite);
    expect(droite.style.translate).toBe("-36px");
  });

  it("dans le cadre, ou sans cadre : pas de décalage", () => {
    const dedans = menuDans({ left: 0, right: 400 }, { left: 100, right: 300 });
    dedans.style.translate = "12px";
    garderDansCadre(dedans);
    expect(dedans.style.translate).toBe("");
    garderDansCadre(null);
    const seul = document.createElement("div");
    garderDansCadre(seul);
    expect(seul.style.translate).toBe("");
  });
});

describe("explorateur", () => {
  it("posé sur le code seulement s'il est en position absolue", () => {
    expect(explorateurSuperpose()).toBe(false);
    document.body.innerHTML = '<div class="elpis-ed-explorateur"></div>';
    expect(explorateurSuperpose()).toBe(false);
    (document.querySelector(".elpis-ed-explorateur") as HTMLElement).style.position = "absolute";
    expect(explorateurSuperpose()).toBe(true);
  });
});
