// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/interruption.test.ts — erreur d'inférence en ligne : cause typée, action adaptée, détail copiable au clavier, texte partiel gardé. */
import { createApp, h, nextTick } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import LigneInterruption from "../../../src/components/chat/message/LigneInterruption.vue";
import { interruption } from "../../../src/features/chat/message/interruption";
import type { ContexteMessage, MessageAffiche } from "../../../src/features/chat/message/types";
import { CLE_COMPOSEUR, CLE_FIL } from "../../../src/features/chat/page/domaines";
import type { DomaineComposeur } from "../../../src/features/chat/page/types";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function monter(msg: MessageAffiche, avecComposeur = true, isStreaming = false): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(LigneInterruption, { entry: { idx: 3, msg } }) });
  app.provide(CLE_FIL, {
    isStreaming,
    resumeAfterError: (i: number) => appels.push(["reprendre", i]),
    showToast: (m: string) => appels.push(["toast", m]),
  } as unknown as ContexteMessage);
  if (avecComposeur)
    app.provide(CLE_COMPOSEUR, {
      startNewChat: () => appels.push(["nouveau"]),
    } as unknown as DomaineComposeur);
  app.mount(hote);
  return hote;
}

describe("cause typée", () => {
  it.each([
    ["unreachable", "serveur injoignable", "reprendre"],
    ["context_overflow", "contexte saturé", "nouveau"],
    ["rate_limited", "moteur occupé", "reprendre"],
    ["loading", "modèle en chargement", "reprendre"],
    ["network", "connexion perdue", "reprendre"],
    ["forbidden", "accès refusé", null],
  ])("%s → « %s »", (kind, cause, action) => {
    expect(interruption({ errorMessage: "m", errorKind: kind })).toMatchObject({ cause, action });
  });

  it("sans genre : déduit du message (navigateur, contexte), sinon erreur interne", () => {
    expect(interruption({ errorMessage: "TypeError: Failed to fetch" }).cause).toBe("connexion perdue");
    expect(interruption({ errorMessage: "context size exceeded" }).cause).toBe("contexte saturé");
    expect(interruption({ errorMessage: "boum" }).cause).toBe("erreur interne");
  });
});

describe("LigneInterruption", () => {
  it("serveur injoignable : « Reprendre » quand un texte partiel existe, détail en infobulle", () => {
    const hote = monter({
      role: "assistant",
      content: "début",
      isError: true,
      errorMessage: "Le serveur du modèle est injoignable.",
      errorDetail: "connect ECONNREFUSED",
      errorKind: "unreachable",
    });
    const ligne = hote.querySelector("[data-interruption]");
    expect(ligne?.getAttribute("role")).toBe("status");
    expect(ligne?.getAttribute("title")).toBe("Le serveur du modèle est injoignable.\nconnect ECONNREFUSED");
    const bouton = hote.querySelector<HTMLButtonElement>("[data-interruption-action]");
    expect(bouton?.textContent?.trim()).toBe("Reprendre");
    bouton?.click();
    expect(appels).toEqual([["reprendre", 3]]);
  });

  it("rien d'acquis : « Réessayer » ; génération en cours : aucune action", () => {
    const msg: MessageAffiche = { role: "assistant", isError: true, errorMessage: "x", errorKind: "timeout" };
    expect(monter(msg).querySelector("[data-interruption-action]")?.textContent?.trim()).toBe("Réessayer");
    app?.unmount();
    expect(monter(msg, true, true).querySelector("[data-interruption-action]")).toBeNull();
  });

  it("contexte saturé : « Nouveau chat » ; sans composeur, pas de bouton", () => {
    const msg: MessageAffiche = {
      role: "assistant",
      isError: true,
      errorMessage: "trop long",
      errorKind: "context_overflow",
    };
    monter(msg).querySelector<HTMLButtonElement>("[data-interruption-action]")?.click();
    expect(appels).toEqual([["nouveau"]]);
    app?.unmount();
    expect(monter(msg, false).querySelector("[data-interruption-action]")).toBeNull();
  });

  it("« Copier le détail » : un bouton (atteignable au clavier) qui copie message et détail", async () => {
    const ecrit: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void ecrit.push(t) } });
    const hote = monter({
      role: "assistant",
      isError: true,
      errorMessage: "Le moteur est occupé.",
      errorDetail: "HTTP 503 · no slot available",
      errorKind: "rate_limited",
    });
    const copier = hote.querySelector<HTMLButtonElement>("[data-copier-detail]");
    expect(copier?.tagName).toBe("BUTTON");
    copier?.click();
    await nextTick();
    await Promise.resolve();
    expect(ecrit).toEqual(["Le moteur est occupé.\nHTTP 503 · no slot available"]);
    expect(appels).toContainEqual(["toast", "Détail copié"]);
  });
});
