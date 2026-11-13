// SPDX-License-Identifier: MIT
/** frontend/test/platform/precharge.test.ts — préchargement à l'intention : survol, focus ou appui d'un `[data-precharge]`, une fois par clé, relançable après un échec. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { definirPrechargement, ecouterIntentions } from "../../src/platform/precharge";
import { definirOccupation } from "../../src/platform/repos";

const attendre = () => new Promise((ok) => setTimeout(ok, 0));
let retirer = (): void => undefined;
afterEach(() => {
  retirer();
  document.body.innerHTML = "";
});

describe("préchargement à l'intention", () => {
  it("survol, focus et appui d'un descendant lancent chaque clé nommée une seule fois", async () => {
    const editeur = vi.fn();
    const studio = vi.fn();
    definirPrechargement("editeur-t", editeur);
    definirPrechargement("studio-t", studio);
    document.body.innerHTML = '<button data-precharge="editeur-t studio-t"><i></i></button><p>autre</p>';
    retirer = ecouterIntentions();
    const icone = document.querySelector("i") as HTMLElement;
    icone.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    (document.querySelector("button") as HTMLElement).dispatchEvent(
      new FocusEvent("focusin", { bubbles: true }),
    );
    icone.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    (document.querySelector("p") as HTMLElement).dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true }),
    );
    await attendre();
    expect(editeur).toHaveBeenCalledTimes(1);
    expect(studio).toHaveBeenCalledTimes(1);
  });

  it("rien pendant un flux ; la clé reste relançable après", async () => {
    let flux = true;
    definirOccupation(() => flux);
    const f = vi.fn();
    definirPrechargement("routines-t", f);
    document.body.innerHTML = '<button data-precharge="routines-t">Routines</button>';
    retirer = ecouterIntentions();
    const bouton = document.querySelector("button") as HTMLElement;
    bouton.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await attendre();
    expect(f).not.toHaveBeenCalled();
    flux = false;
    bouton.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await attendre();
    expect(f).toHaveBeenCalledTimes(1);
    definirOccupation(() => false);
  });

  it("un échec laisse la clé relançable ; plus rien une fois l'écoute retirée", async () => {
    let echecs = 1;
    const f = vi.fn(() => (echecs-- > 0 ? Promise.reject(new Error("réseau")) : Promise.resolve()));
    definirPrechargement("rag-t", f);
    document.body.innerHTML = '<a data-precharge="rag-t">RAG</a>';
    retirer = ecouterIntentions();
    const lien = document.querySelector("a") as HTMLElement;
    lien.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await attendre();
    lien.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await attendre();
    lien.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await attendre();
    expect(f).toHaveBeenCalledTimes(2);
    retirer();
    definirPrechargement("autre-t", f);
    lien.setAttribute("data-precharge", "autre-t");
    lien.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await attendre();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
