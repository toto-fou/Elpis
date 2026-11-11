// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/captures-tour.test.ts — captures du navigateur : rattachées à leur étape, bouton appareil photo, aperçu en direct, « N captures » du pied, visionneuse en mode captures, réglage et déroulé Classique. */
/* eslint-disable vue/one-component-per-file -- fil du message et visionneuse montés à part */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import CorpsMessage from "../../../src/components/chat/message/CorpsMessage.vue";
import VisionneuseImages from "../../../src/components/chat/modales/VisionneuseImages.vue";
import { capturesDuTour, visionneuseCaptures } from "../../../src/features/chat/message/captures-tour";
import type { ContexteMessage, MessageAffiche } from "../../../src/features/chat/message/types";
import { CLE_MODALES } from "../../../src/features/chat/modales/domaine";
import type { DomaineModalesChat } from "../../../src/features/chat/modales/domaine";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

const nav = (
  nom: string,
  objet: Record<string, unknown>,
  seg: number,
  extra: Partial<EtapeOutil> = {},
): EtapeOutil => ({
  name: nom,
  status: "done",
  args: objet,
  durationMs: 600,
  seg,
  ...extra,
});
const capture = (stepIdx: number, n: number, extra: Record<string, unknown> = {}) => ({
  tool: "pw_page",
  blobUrl: "blob:c" + n,
  serverUrl: "/api/playwright/screenshot/s/" + n + ".png",
  stepIdx,
  pending: false,
  ...extra,
});

// Ouvre la page (capture), texte, puis deux étapes groupées dont une sans capture et une avec.
function message(extra: Partial<MessageAffiche> = {}): MessageAffiche {
  return {
    role: "assistant",
    content: "Le bandeau s'affiche.",
    segTexts: ["J'ouvre la page.", "Je vérifie après une erreur."],
    toolSteps: [
      nav("pw_page", { action: "goto", url: "https://intranet.lan/connexion" }, 0, { callId: "a" }),
      nav("read_file", { path: "notes.md" }, 1, { callId: "b" }),
      nav("pw_visual", { selector: ".bandeau" }, 1, { callId: "c" }),
    ],
    webScreenshots: [capture(0, 1), capture(2, 2, { tool: "pw_visual" })],
    ...extra,
  } as MessageAffiche;
}

function contexte(settings: Record<string, unknown> = {}): ContexteMessage {
  const etat = reactive({
    settings: { hide_thinking: false, ...settings },
    lastAssistantIdx: 1,
    isStreaming: false,
    logoApp: "x.png",
    compressionStatus: null,
    messageSearchQ: "",
    messageSearchActive: false,
  });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: false }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: () => null,
    fmtThinkingMeta: () => "",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
  };
  return new Proxy(etat, {
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      if (cle in neutres) return neutres[cle];
      return (...args: unknown[]) => void appels.push([cle, ...args]);
    },
  }) as unknown as ContexteMessage;
}

function monter(
  msg: MessageAffiche,
  o: { classique?: boolean; settings?: Record<string, unknown> } = {},
): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(CorpsMessage, { entry: { idx: 1, msg }, pied: true }) });
  app.provide(
    CLE_PREFERENCES_CHAT,
    prefsDeroule(o.classique ? "classic" : "timeline", {
      captures: o.settings?.["hide_web_screenshots"] !== true,
    }),
  );
  app.provide(CLE_FIL, contexte(o.settings));
  app.mount(hote);
  return hote;
}

const ouvertures = () => appels.filter((a) => a[0] === "openImageViewer");

describe("capturesDuTour", () => {
  it("numéro et libellé de l'étape, source lisible, captures en attente hors de la visionneuse", () => {
    const caps = capturesDuTour(
      message({
        webScreenshots: [
          capture(0, 1),
          capture(2, 2, { blobUrl: null }),
          capture(1, 3, { blobUrl: null, serverUrl: "https://ailleurs/x.png" }),
          { tool: "pw_act", blobUrl: null, serverUrl: "/api/playwright/screenshot/s/4.png", pending: true },
        ],
      }),
    );
    expect(caps.map((c) => [c.flat, c.numero, c.url, c.attente])).toEqual([
      [0, 1, "blob:c1", false],
      [2, 3, "/api/playwright/screenshot/s/2.png", false],
      [1, 2, "", false],
      [-1, 0, "/api/playwright/screenshot/s/4.png", true],
    ]);
    expect(caps[0]?.titre).toBe("Étape 1 · Ouvre connexion");
    expect(caps[1]?.titre).toMatch(/^Étape 3 · Capture/);
    expect(caps[3]?.titre).toBe("Capture 4");
    const v = visionneuseCaptures(caps);
    expect(v.items.map((i) => i.url)).toEqual(["blob:c1", "/api/playwright/screenshot/s/2.png"]);
    expect([...v.parEtape]).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });
});

describe("captures dans le fil", () => {
  it("fin du tour : aucune image dans le fil, appareil photo sur les étapes, « 2 captures » au pied", async () => {
    const hote = monter(message());
    expect(hote.querySelector("img")).toBeNull();
    expect(hote.querySelector("[data-apercu-direct]")).toBeNull();
    const boutons = [...hote.querySelectorAll<HTMLButtonElement>("[data-voir-capture]")];
    expect(boutons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Voir la capture de l’étape 1",
      "Voir la capture de l’étape 3",
    ]);
    boutons[1]?.click();
    const [, items, rang, info] = ouvertures()[0] ?? [];
    expect((items as { prompt: string }[]).map((i) => i.prompt)).toEqual([
      "Étape 1 · Ouvre connexion",
      expect.stringMatching(/^Étape 3 · Capture/),
    ]);
    expect(rang).toBe(1);
    expect(info).toEqual({ captures: true });
    const pied = hote.querySelector<HTMLButtonElement>("[data-voir-captures]");
    expect(pied?.textContent?.trim()).toBe("2 captures");
    pied?.click();
    await nextTick();
    expect(ouvertures()[1]?.[2]).toBe(0);
  });

  it("pendant la navigation : aperçu en direct sous le groupe qui tourne, replié dès que la réponse s'écrit", () => {
    const enCours = message({
      isStreaming: true,
      content: "",
      toolSteps: [
        nav("pw_page", { url: "https://intranet.lan/connexion" }, 0),
        nav("pw_act", { action: "click", target: "Se connecter" }, 1, { status: "running" }),
      ],
      webScreenshots: [capture(0, 1)],
    });
    const hote = monter(enCours);
    const apercu = hote.querySelector("[data-apercu-direct]");
    expect(apercu?.textContent).toContain("En direct");
    expect(apercu?.querySelector("img")?.getAttribute("src")).toBe("blob:c1");
    expect(hote.querySelectorAll("[data-voir-capture]")).toHaveLength(1);
    app?.unmount();
    const hote2 = monter({ ...enCours, _pendingPreContent: "Le bandeau est là." } as MessageAffiche);
    expect(hote2.querySelector("[data-apercu-direct]")).toBeNull();
  });

  it("« Masquer les captures web » : ni appareil photo, ni aperçu, ni « captures » au pied", () => {
    const hote = monter(message(), { settings: { hide_web_screenshots: true } });
    expect(hote.querySelector("[data-voir-capture]")).toBeNull();
    expect(hote.querySelector("[data-voir-captures]")).toBeNull();
    expect(hote.querySelector("img")).toBeNull();
  });

  it("déroulé Classique : le carrousel reste, sans les boutons du fil chronologique", () => {
    const hote = monter(message(), { classique: true });
    expect(hote.querySelector("img")?.getAttribute("src")).toBe("blob:c2");
    expect(hote.querySelector("[data-voir-captures]")).toBeNull();
  });
});

describe("visionneuse en mode captures", () => {
  function monterVisionneuse(captures: boolean): HTMLElement {
    const courant = { id: "capture:0", url: "blob:c1", prompt: "Étape 1 · Ouvre connexion" };
    const m = reactive({
      imageViewer: { items: [courant], idx: 0, prompt: "", revised: "", meta: null, captures },
      imageViewerCurrent: courant,
      imageViewerPrompt: courant.prompt,
      imageViewerInfo: "",
      imageCanEdit: true,
      imageGallery: null,
    });
    const proxy = new Proxy(m, {
      get: (c, k: string) => (k in c ? (c as Record<string, unknown>)[k] : () => undefined),
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(VisionneuseImages) });
    app.provide(CLE_MODALES, proxy as unknown as DomaineModalesChat);
    app.mount(hote);
    return hote;
  }

  it("titre de l'étape, téléchargement seul ; les images générées gardent leurs actions", () => {
    const cap = monterVisionneuse(true);
    expect(cap.querySelector("[data-image-viewer]")?.getAttribute("aria-label")).toBe(
      "Capture du navigateur",
    );
    expect(cap.querySelector(".elpis-img-viewer__prompt")?.textContent).toBe("Étape 1 · Ouvre connexion");
    expect([...cap.querySelectorAll(".elpis-img-btn")].map((b) => b.textContent?.trim())).toEqual([
      "Télécharger",
    ]);
    app?.unmount();
    const gen = monterVisionneuse(false);
    expect([...gen.querySelectorAll(".elpis-img-btn")].map((b) => b.textContent?.trim())).toEqual([
      "Modifier",
      "Télécharger",
      "Copier",
      "Supprimer",
    ]);
  });

  it("capture disparue du serveur : « Capture expirée » au lieu d'une image cassée", async () => {
    const cap = monterVisionneuse(true);
    cap.querySelector("img")?.dispatchEvent(new Event("error"));
    await nextTick();
    expect(cap.querySelector("img")).toBeNull();
    expect(cap.querySelector("[data-capture-expiree]")?.textContent).toBe("Capture expirée");
  });
});
