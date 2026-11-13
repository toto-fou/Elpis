// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/bouton-bas.test.ts — « Aller en bas » : saut jusqu'à un écran du bas puis glissé vers le bas réel, suivi automatique rendu à la fin ; immédiat en mouvement réduit ; un geste interrompt le glissé. */
import { createApp, h, nextTick } from "vue";
import type { App, InjectionKey } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BoutonBas from "../../../src/components/chat/page/BoutonBas.vue";
import { CLE_CONVERSATION } from "../../../src/features/chat/page/domaines";
import { etat } from "./montage";

let app: App | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
});

afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function poser(reduit: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) => ({ matches: reduit && q.includes("reduce") }) as MediaQueryList,
  );
  const page = document.createElement("main");
  const fil = document.createElement("div");
  fil.className = "elpis-fil";
  let hauteur = 10_000;
  Object.defineProperty(fil, "scrollHeight", { get: () => hauteur });
  Object.defineProperty(fil, "clientHeight", { get: () => 800 });
  fil.scrollTop = 2000;
  const hote = document.createElement("div");
  page.append(fil, hote);
  document.body.appendChild(page);
  const conv = etat<{ isUserScrolling: boolean }>({
    messages: [1, 2, 3],
    chatAwayFromBottom: true,
    scrollBtnBottom: 90,
    isUserScrolling: true,
  });
  // scrollToBottom simulé : le bas est atteint au nextTick, comme dans le cœur.
  const domaineConv = new Proxy(conv, {
    get: (c, cle: string) =>
      cle === "scrollToBottom"
        ? () => void nextTick(() => (fil.scrollTop = hauteur - 800))
        : (c as Record<string, unknown>)[cle],
  });
  app = createApp({ render: () => h(BoutonBas) });
  app.provide(CLE_CONVERSATION as InjectionKey<object>, domaineConv);
  app.mount(hote);
  const bouton = hote.querySelector("button") as HTMLButtonElement;
  return { fil, conv, bouton, grandir: (n: number) => (hauteur += n) };
}

describe("« Aller en bas »", () => {
  it("saute à un écran du bas puis glisse jusqu'au bas réel ; le suivi automatique reprend à la fin", async () => {
    const { fil, conv, bouton, grandir } = poser(false);
    bouton.click();
    await nextTick();
    await nextTick();
    expect(fil.scrollTop).toBe(10_000 - 1600);
    expect(conv.isUserScrolling).toBe(true);
    vi.advanceTimersByTime(130);
    expect(fil.scrollTop).toBeGreaterThan(8400);
    expect(fil.scrollTop).toBeLessThan(9200);
    grandir(300);
    vi.advanceTimersByTime(200);
    expect(fil.scrollTop).toBe(10_300 - 800);
    expect(conv.isUserScrolling).toBe(false);
  });

  it("mouvement réduit : saut immédiat au bas, suivi rendu tout de suite", async () => {
    const { fil, conv, bouton } = poser(true);
    bouton.click();
    expect(conv.isUserScrolling).toBe(false);
    await nextTick();
    expect(fil.scrollTop).toBe(9200);
    vi.advanceTimersByTime(300);
    expect(fil.scrollTop).toBe(9200);
  });

  it("une molette pendant le glissé l'interrompt : l'utilisateur garde la main", async () => {
    const { fil, conv, bouton } = poser(false);
    bouton.click();
    await nextTick();
    await nextTick();
    vi.advanceTimersByTime(50);
    fil.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    const ici = fil.scrollTop;
    vi.advanceTimersByTime(300);
    expect(fil.scrollTop).toBe(ici);
    expect(conv.isUserScrolling).toBe(true);
  });
});
