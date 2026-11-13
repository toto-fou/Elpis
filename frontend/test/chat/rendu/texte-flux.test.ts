// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/texte-flux.test.ts — composant TexteFlux : texte lu sur la référence du porteur, ajout au bout du même nœud texte (sélection gardée), texte reposé quand il ne prolonge pas le précédent. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import TexteFlux from "../../../src/components/chat/TexteFlux.vue";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(texte: string, flux: { value: string } | null) {
  const props = shallowRef<{ texte: string; flux: { value: string } | null }>({ texte, flux });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(TexteFlux, { class: "x", ...props.value }) });
  app.mount(hote);
  return { pre: hote.firstElementChild as HTMLElement, props };
}

describe("TexteFlux", () => {
  it("le texte du porteur grandit au bout du même nœud ; une sélection faite dedans survit", async () => {
    const flux = shallowRef("Je pense à");
    const { pre } = monter("ignoré", flux);
    expect(pre.tagName).toBe("PRE");
    expect(pre.className).toBe("x");
    const noeud = pre.firstChild as Text;
    expect(noeud.data).toBe("Je pense à");
    const plage = document.createRange();
    plage.setStart(noeud, 3);
    plage.setEnd(noeud, 8);
    const ajouts = vi.spyOn(noeud, "appendData");
    for (const suite of [" une", " réponse", " longue."]) {
      flux.value += suite;
      await nextTick();
      expect(pre.firstChild).toBe(noeud);
      expect(pre.childNodes.length).toBe(1);
    }
    expect(noeud.data).toBe("Je pense à une réponse longue.");
    expect(ajouts.mock.calls.map((c) => c[0])).toEqual([" une", " réponse", " longue."]);
    expect(plage.toString()).toBe("pense");
  });

  it("repli : un texte qui ne prolonge pas le précédent est reposé ; sans porteur, le texte du message", async () => {
    const flux = shallowRef("Réflexion diffusée");
    const { pre, props } = monter("Réflexion du serveur", flux);
    flux.value = "Autre texte";
    await nextTick();
    expect(pre.textContent).toBe("Autre texte");
    props.value = { texte: "Réflexion du serveur", flux: null };
    await nextTick();
    expect(pre.textContent).toBe("Réflexion du serveur");
    expect(pre.childNodes.length).toBe(1);
  });
});
