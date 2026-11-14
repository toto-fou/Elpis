// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/fondu-defilement.test.ts — fondu de l'historique : position lue à l'image suivante, jamais pendant un rendu ; `v-fondu` branché une fois par élément, pas à chaque mise à jour du volet. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BarreLaterale from "../../../src/components/chat/page/BarreLaterale.vue";
import { CLE_BARRE } from "../../../src/features/chat/page/domaines";
import { fonduDefilement } from "../../../src/features/chat/page/fondu-defilement";
import { barre, demonter, monter } from "./montage";

let lectures = 0;
const observateurs = { crees: 0, coupes: 0 };

// Prototype qui porte la propriété (les getters de géométrie ne sont pas propres à l'élément).
function porteur(nom: string): HTMLElement {
  let p: object | null = HTMLElement.prototype;
  while (p && !Object.getOwnPropertyDescriptor(p, nom)) p = Object.getPrototypeOf(p) as object | null;
  return p as HTMLElement;
}

const image = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

beforeEach(() => {
  lectures = 0;
  observateurs.crees = observateurs.coupes = 0;
  const valeurs = { scrollTop: 0, clientHeight: 100, scrollHeight: 500 } as const;
  for (const nom of Object.keys(valeurs) as (keyof typeof valeurs)[])
    vi.spyOn(porteur(nom), nom, "get").mockImplementation(() => {
      lectures++;
      return valeurs[nom];
    });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor() {
        observateurs.crees++;
      }
      observe(): void {}
      disconnect(): void {
        observateurs.coupes++;
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  demonter();
});

describe("fondu de défilement", () => {
  it("rien n'est lu au branchement ; la position est lue à l'image suivante", async () => {
    const el = document.createElement("div");
    const detacher = fonduDefilement(el);
    expect(lectures).toBe(0);
    await image();
    expect(lectures).toBeGreaterThan(0);
    expect(el.classList.contains("fade-bottom")).toBe(true);
    expect(el.classList.contains("fade-top")).toBe(false);
    detacher();
  });

  it("volet : branché une fois, ni rebranché ni relu quand il se met à jour ; détaché au démontage", async () => {
    const b = barre();
    const hote = monter(BarreLaterale, [[CLE_BARRE as InjectionKey<object>, b]]);
    expect(hote.querySelector(".chat-history-scroll")).not.toBeNull();
    expect(observateurs.crees).toBe(1);
    expect(lectures).toBe(0);
    b.chatEnOuverture = "c2";
    await nextTick();
    b.chatSelectMode = true;
    await nextTick();
    expect(hote.querySelectorAll("[data-chat-open][aria-pressed]").length).toBe(2);
    expect(observateurs).toEqual({ crees: 1, coupes: 0 });
    expect(lectures).toBe(0);
    demonter();
    expect(observateurs.coupes).toBe(1);
  });
});
