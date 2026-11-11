// SPDX-License-Identifier: MIT
/** frontend/test/chat/historique/fidelite.test.ts — rechargement fidèle au direct : durées, réflexions et arrêt des étapes, captures, réflexion finale, résultat tronqué signalé, erreur du tour ; aller-retour vers le serveur. */
import { createApp, h, nextTick } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import CapturesWeb from "../../../src/components/chat/message/CapturesWeb.vue";
import CarteOutil from "../../../src/components/chat/outils/CarteOutil.vue";
import { projeterPourPersistance } from "../../../src/features/chat/coeur/persistance";
import type { MessageChat } from "../../../src/features/chat/coeur/types";
import { construireMessages } from "../../../src/features/chat/historique/historique";
import type { Message } from "../../../src/features/chat/historique/historique";
import type { ContexteMessage } from "../../../src/features/chat/message/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(rendu: () => VNode, fil?: Partial<ContexteMessage>): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  if (fil) app.provide(CLE_FIL, fil as ContexteMessage);
  app.mount(hote);
  return hote;
}

const CAPTURE = "/api/playwright/screenshot/step_abc12345_3.png";
const LONG = JSON.stringify({ content: "x".repeat(2600) });

const appel = (id: string, nom: string, args: object) => ({
  id,
  type: "function",
  function: { name: nom, arguments: JSON.stringify(args) },
});

function enregistre(extra: Record<string, unknown> = {}): Message {
  return {
    role: "assistant",
    content: "Les tests passent.",
    thinking: "je lis la config\n\nje conclus",
    tool_history: [
      { role: "assistant", content: "Je lis.", tool_calls: [appel("a", "read_file", { path: "p.json" })] },
      { role: "tool", tool_call_id: "a", content: LONG },
      { role: "assistant", content: "", tool_calls: [appel("b", "pw_goto", { url: "http://x" })] },
      { role: "tool", tool_call_id: "b", content: "{}" },
      { role: "assistant", content: "", tool_calls: [appel("c", "execute_shell", { command: "npm test" })] },
      { role: "tool", tool_call_id: "c", content: '{"error": "interrompu par l\'utilisateur"}' },
    ],
    tool_history_delta: true,
    tool_meta: {
      steps: {
        a: { ms: 120, think: "je lis la config", think_ms: 3000 },
        b: { ms: 900, shot: CAPTURE, shot_step: 3 },
        c: { state: "stopped", ms: 18_000 },
      },
      tail: { think: "je conclus", think_ms: 1500 },
    },
    ...extra,
  };
}

const analyse = (c: unknown) => ({ files: undefined, displayContent: c });

describe("rechargement fidèle", () => {
  it("étapes : durée, réflexion et sa durée, arrêt, identifiant d'appel ; réflexion finale seule en tête", () => {
    const [m] = construireMessages([enregistre()], analyse) as MessageChat[];
    const etapes = m?.toolSteps ?? [];
    expect(etapes.map((s) => [s.callId, s.status, s.durationMs])).toEqual([
      ["a", "done", 120],
      ["b", "done", 900],
      ["c", "stopped", 18_000],
    ]);
    expect(etapes[0]).toMatchObject({ thinking: "je lis la config", thinkingMs: 3000 });
    expect(m?.thinking).toBe("je conclus");
    expect(m?._thinkingMs).toBe(1500);
  });

  it("résultat long : extrait de 2 000 caractères et longueur complète signalée", () => {
    const [m] = construireMessages([enregistre()], analyse) as MessageChat[];
    expect(String(m?.toolSteps?.[0]?.result).length).toBe(2000);
    expect(m?.toolSteps?.[0]?.resultLength).toBe(LONG.length);
    expect(m?.toolSteps?.[1]?.resultLength).toBeUndefined();
  });

  it("captures restituées depuis tool_meta, rattachées à leur étape", () => {
    const [m] = construireMessages([enregistre()], analyse) as MessageChat[];
    expect(m?.webScreenshots).toEqual([
      { blobUrl: null, serverUrl: CAPTURE, tool: "pw_goto", stepIdx: 1, step: 3, pending: false },
    ]);
  });

  it("erreur du tour : message, détail et genre restitués", () => {
    const erreur = { text: "Serveur injoignable", detail: "connect ECONNREFUSED", kind: "unreachable" };
    const [m] = construireMessages([enregistre({ error: erreur })], analyse) as MessageChat[];
    expect(m).toMatchObject({
      isError: true,
      errorMessage: "Serveur injoignable",
      errorDetail: "connect ECONNREFUSED",
      errorKind: "unreachable",
    });
  });

  it("ancienne conversation sans tool_meta : lisible comme avant (réflexion entière, étapes « terminé »)", () => {
    const { tool_meta: _m, ...ancien } = enregistre();
    const [m] = construireMessages([ancien], analyse) as MessageChat[];
    expect(m?.thinking).toBe("je lis la config\n\nje conclus");
    expect(m?.toolSteps?.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(m?.webScreenshots).toBeUndefined();
    expect(m?.toolSteps?.[0]?.durationMs).toBeUndefined();
  });

  it("tool_meta illisible : ignoré sans casser le chargement", () => {
    const [m] = construireMessages([enregistre({ tool_meta: { steps: "x" } })], analyse) as MessageChat[];
    expect(m?.toolSteps?.length).toBe(3);
    expect(m?.tool_meta).toBeUndefined();
  });

  it("aller-retour : tool_meta et erreur repartent avec le message", () => {
    const erreur = { text: "Contexte saturé", detail: "n_ctx", kind: "context" };
    const [m] = construireMessages([enregistre({ error: erreur })], analyse) as MessageChat[];
    const o = projeterPourPersistance(m as MessageChat);
    expect(o["tool_meta"]).toEqual(enregistre()["tool_meta"]);
    expect(o["error"]).toEqual(erreur);
    expect(o["thinking"]).toBe("je conclus");
  });
});

describe("affichage du rechargé", () => {
  it("carte d'outil : « Résultat tronqué à 2 000 caractères »", () => {
    const hote = monter(() =>
      h(CarteOutil, {
        step: { name: "read_file", status: "done", result: "x", resultLength: 2600 },
        numero: 1,
        compactOuvert: false,
      }),
    );
    const note = hote.querySelector("[data-resultat-tronque]");
    expect(note?.textContent?.replace(/\s/g, " ")).toContain("Résultat tronqué à 2 000 caractères");
    expect(note?.getAttribute("title")).toContain("2");
  });

  it("capture rechargée : lue sur le serveur, « Capture expirée » si elle n'existe plus", async () => {
    const msg = {
      role: "assistant",
      webScreenshots: [{ serverUrl: CAPTURE, tool: "pw_goto", blobUrl: null, pending: false }],
      webScreenshotIdx: null,
    };
    const hote = monter(() => h(CapturesWeb, { entry: { idx: 0, msg } }), { settings: {} });
    const img = hote.querySelector("img");
    expect(img?.getAttribute("src")).toBe(CAPTURE);
    img?.dispatchEvent(new Event("error"));
    await nextTick();
    expect(hote.querySelector("img")).toBeNull();
    expect(hote.querySelector("[data-capture-expiree]")?.textContent).toBe("Capture expirée");
  });
});
