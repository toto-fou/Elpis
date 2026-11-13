// SPDX-License-Identifier: MIT
/** frontend/test/code/retour-flux.test.ts — retour sur la page Code : ce que la CLI émet entre la relecture du transcript et l'ouverture du flux est rattrapé (test de la relecture indépendante). */
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerCode } from "../../src/features/code/code";

class FauxFlux {
  static dernier: FauxFlux | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor() {
    FauxFlux.dernier = this;
  }
  close(): void {}
}

afterEach(() => vi.unstubAllGlobals());

describe("page Code : flux repris au retour sur la page", () => {
  it("un événement émis avant l'ouverture du flux est rattrapé à son ouverture", async () => {
    vi.stubGlobal("EventSource", FauxFlux);
    let texte = "réponse partielle";
    const gets: string[] = [];
    const vue = ref("chat");
    const c = creerCode(
      { currentView: vue },
      {
        showToast: () => undefined,
        fetchJsonAuth: (url) => {
          gets.push(url);
          if (url === "/api/code/sessions")
            return Promise.resolve([{ id: "s1", connected: true, busy: true }]);
          if (url === "/api/code/sessions/s1/messages")
            return Promise.resolve([
              {
                info: { id: "m1", role: "assistant", sessionID: "s1" },
                parts: [{ id: "p1", type: "text", text: texte }],
              },
            ]);
          return Promise.resolve([]);
        },
        fetchAuth: () => Promise.resolve(null),
        openConfirm: () => Promise.resolve(true),
      },
    );
    // Première visite : flux ouvert, puis clic sur la session.
    await c.openCodePage();
    FauxFlux.dernier?.onopen?.();
    await c.codeSelectSession("s1");
    expect(c.codeMessages.value[0]?.parts[0]?.text).toBe("réponse partielle");
    // On quitte la page (le watcher de racine.ts coupe le flux), puis on revient.
    vue.value = "chat";
    c.codeDisconnectStream();
    await c.openCodePage();
    // L'agent termine son texte APRÈS la relecture du transcript mais AVANT l'ouverture du flux : l'événement est perdu.
    texte = "réponse complète";
    const avantOuverture = gets.filter((u) => u.endsWith("/messages")).length;
    FauxFlux.dernier?.onopen?.();
    await new Promise((ok) => setTimeout(ok, 20));
    c.codeDisconnectStream();
    const apres = gets.filter((u) => u.endsWith("/messages")).length;
    // Attendu : l'ouverture du flux relit l'état (comme une reconnexion) ; sur le lot, rien n'est relu.
    expect({
      relecturesALOuverture: apres - avantOuverture,
      texte: c.codeMessages.value[0]?.parts[0]?.text,
    }).toEqual({
      relecturesALOuverture: 1,
      texte: "réponse complète",
    });
  });
});
