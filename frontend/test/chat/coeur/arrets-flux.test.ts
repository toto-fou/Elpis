// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/arrets-flux.test.ts — texte gardé à chaque sortie du flux (Stop, erreur, appel d'outil, « Répondre maintenant »), composants remontés en plein flux, textes faits de blancs. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import TexteFlux from "../../../src/components/chat/TexteFlux.vue";
import { GestionnaireSession } from "../../../src/features/auth/session";
import { setupChat } from "../../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../../src/features/chat/coeur/chat";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

type Ev = Record<string, unknown>;
type Api = Record<string, unknown> & {
  handleStreamEvent(e: Ev): Promise<void>;
  stopGeneration(): void;
  respondNow(i: number): Promise<void>;
};

const MODULES = {
  echantillonnage: () => ({
    showSamplingPanel: Vue.ref(false),
    samplingOverride: Vue.ref({}),
    loadEffectiveParams: () => undefined,
    _cleanSamplingOverride: () => null,
  }),
  voix: () => ({
    voiceState: Vue.ref("arrete"),
    cancelVoice: () => undefined,
    stopDictation: () => undefined,
    onAssistantStart: () => undefined,
    onAssistantStream: () => undefined,
    onAssistantToolStream: () => undefined,
    onAssistantFinal: () => undefined,
  }),
  images: () => ({
    imageMode: Vue.ref(false),
    imageAvailable: Vue.ref(false),
    imageViewer: Vue.ref(null),
    imageGallery: Vue.ref(null),
    imagePop: Vue.ref(null),
    imageEscape: () => false,
    closeImageViewer: () => undefined,
    closeImageGallery: () => undefined,
    toggleImageMode: async () => false,
    closeImageMode: () => undefined,
    buildImageRequest: () => ({}),
    clearImageEditRef: () => undefined,
    loadImageStatus: async () => null,
  }),
} as unknown as ModulesChat;

function refs(messages: MessageChat[]): RefsRacineChat {
  return {
    user: Vue.ref(null),
    settings: Vue.ref({ enable_editor: false }),
    config: Vue.ref({ active_mcp_ids: [] }),
    messages: Vue.ref(messages),
    currentChatId: Vue.ref("c1"),
    inputMessage: Vue.ref(""),
    inputRef: Vue.ref(null),
    isStreaming: Vue.ref(true),
    currentView: Vue.ref("chat"),
    isUserScrolling: Vue.ref(false),
    features: Vue.ref({}),
  } as RefsRacineChat;
}

function ctx(): CtxChat {
  return {
    showToast: () => undefined,
    fetchAuth: async () => new Response("{}", { status: 404 }),
    openConfirm: async () => true,
    openPrompt: async () => null,
    systemAlert: Vue.ref(null),
    liveLogs: Vue.ref(null),
  } as unknown as CtxChat;
}

/** Images simulées : une file de rappels déclenchée à la main, l'horloge avance de 1/60 s à chaque image. */
let file = new Map<number, FrameRequestCallback>();
let ids = 0;
async function image(n = 1): Promise<void> {
  for (let k = 0; k < n; k++) {
    vi.advanceTimersByTime(1000 / 60);
    const rappels = [...file.values()];
    file.clear();
    for (const rappel of rappels) rappel(performance.now());
    await vi.advanceTimersByTimeAsync(0);
  }
}

const noyaux: Vue.EffectScope[] = [];
function monter(texte = ""): { api: Api; r: RefsRacineChat; remplacements: () => number } {
  const r = refs([
    { role: "user", content: "Q" },
    { role: "assistant", content: texte, isStreaming: true },
  ]);
  const scope = Vue.effectScope();
  const api = scope.run(() => setupChat(new GestionnaireSession(), r, ctx(), MODULES)) as unknown as Api;
  let n = 0;
  scope.run(() =>
    Vue.watch(
      () => r.messages.value[1],
      () => n++,
      { flush: "sync" },
    ),
  );
  noyaux.push(scope);
  return { api, r, remplacements: () => n };
}
const bulle = (r: RefsRacineChat): MessageChat => r.messages.value[1] as MessageChat;
const contenu = (api: Api, t: string): Promise<void> =>
  api.handleStreamEvent({ type: "content_token", text: t, n: 1 });
const reflexion = (api: Api, t: string): Promise<void> =>
  api.handleStreamEvent({ type: "thinking_token", text: t, n: 1 });
const outil = async (api: Api): Promise<void> => {
  await api.handleStreamEvent({ type: "tool_call", name: "read_file", call_id: "t", args: { path: "a" } });
  await api.handleStreamEvent({ type: "tool_result", name: "read_file", call_id: "t", result: "{}" });
};
function tranches(t: string, pas: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < t.length; i += pas) out.push(t.slice(i, i + pas));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  file = new Map();
  ids = 0;
  vi.stubGlobal("requestAnimationFrame", (rappel: FrameRequestCallback) => {
    file.set(++ids, rappel);
    return ids;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => file.delete(id));
});

afterEach(() => {
  for (const s of noyaux.splice(0)) s.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("« Répondre maintenant »", () => {
  it("pendant une rafale de réflexion : la réflexion encore dans le tampon est gardée et préremplie", async () => {
    const { api, r } = monter();
    const t = "Raisonnement détaillé ".repeat(30);
    await reflexion(api, t);
    await image(2);
    expect((bulle(r).thinking ?? "").length).toBeLessThan(t.length);
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    void api.respondNow(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const m = bulle(r);
    expect(m.thinking).toBe(t.trim());
    expect(m._respondNowPrefill).toBe("<think>\n" + t.trim() + "\n</think>\n\n");
  });
});

describe("erreur en plein flux", () => {
  it("corps : le texte reçu mais pas encore versé reste dans la bulle", async () => {
    const { api, r } = monter();
    const t = "Une réponse assez longue qui arrive d'un bloc. ".repeat(8);
    await contenu(api, t);
    await image(2);
    expect((bulle(r).content ?? "").length).toBeLessThan(t.length);
    await api.handleStreamEvent({ type: "error", text: "boum" });
    expect(bulle(r)).toMatchObject({ content: t, isError: true, isStreaming: false });
    expect(bulle(r)._flux ?? null).toBeNull();
    expect(file.size).toBe(0);
  });

  it("réflexion et narration en attente : versées dans la bulle", async () => {
    const { api, r } = monter();
    const pensee = "Une réflexion assez longue. ".repeat(10);
    await reflexion(api, pensee);
    await image(2);
    await api.handleStreamEvent({ type: "error", text: "boum" });
    expect(bulle(r).thinking).toBe(pensee);
    const b = monter();
    await contenu(b.api, "Je vais lire.");
    await image(2);
    await outil(b.api);
    const n = "Le fichier contient beaucoup de choses intéressantes. ".repeat(4);
    await contenu(b.api, n);
    await image(2);
    await b.api.handleStreamEvent({ type: "error", text: "boum" });
    expect(bulle(b.r)._pendingPreContent).toBe(n);
  });
});

describe("Stop et appel d'outil : tout le texte reçu est gardé", () => {
  const TEXTE =
    "Voici du code :\n\n```python\ndef f(x):\n    return x < 2 and \"a\" != 'b'\n```\n\nPuis une liste :\n\n1. un élément\n2. deux éléments\n\nFin du paragraphe qui s'écrit mot à mot.";

  it("corps : Stop en milieu de mot, de bloc de code, à la première image", async () => {
    const ecarts: string[] = [];
    for (const pas of [3, 11]) {
      const morceaux = tranches(TEXTE, pas);
      for (let k = 1; k <= morceaux.length; k += 2) {
        const { api, r } = monter();
        let envoye = "";
        for (let j = 0; j < k; j++) {
          await contenu(api, morceaux[j] ?? "");
          envoye += morceaux[j] ?? "";
          await image(j % 3);
        }
        api.stopGeneration();
        if (bulle(r).content !== envoye) ecarts.push(pas + "/" + k);
        if (bulle(r)._flux) ecarts.push("porteur " + pas + "/" + k);
      }
    }
    expect(ecarts).toEqual([]);
  }, 60000);

  it("réflexion puis Stop ; narration après un outil puis Stop ; appel d'outil juste après une rafale", async () => {
    const a = monter();
    const t = "Je réfléchis longuement ".repeat(20);
    for (const m of tranches(t, 40)) {
      await reflexion(a.api, m);
      await image(1);
    }
    a.api.stopGeneration();
    expect(bulle(a.r).thinking).toBe(t);
    const b = monter();
    await contenu(b.api, "Je vais lire.");
    await image(2);
    await outil(b.api);
    expect(bulle(b.r).segTexts?.at(-1)).toBe("Je vais lire.");
    const n = "Le fichier contient beaucoup de choses intéressantes.";
    for (const m of tranches(n, 7)) {
      await contenu(b.api, m);
      await image(1);
    }
    b.api.stopGeneration();
    expect(bulle(b.r).content).toBe(n);
    const c = monter();
    const rafale = "Un texte assez long ".repeat(15);
    await contenu(c.api, rafale);
    await image(2);
    await c.api.handleStreamEvent({
      type: "tool_call",
      name: "read_file",
      call_id: "t",
      args: { path: "a" },
    });
    expect(bulle(c.r).segTexts?.at(-1)).toBe(rafale.trim());
    expect(bulle(c.r)._flux ?? null).toBeNull();
  });
});

describe("composants remontés en plein flux (liste virtuelle)", () => {
  it("ContenuMarkdown et TexteFlux montés au milieu du flux montrent tout le texte déjà versé, puis suivent", async () => {
    const { api, r } = monter();
    await reflexion(api, "Pensée une. ");
    await image(30);
    await reflexion(api, "Pensée deux.");
    await image(30);
    await contenu(api, "Premier paragraphe.\n\nDeuxième qui ");
    await image(60);
    await contenu(api, "grandit encore");
    await image(60);
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const m = bulle(r);
    const app = Vue.createApp({
      render: () =>
        Vue.h("div", [
          Vue.h(TexteFlux, { texte: m.thinking, flux: m._flux?.reflexion }),
          Vue.h(ContenuMarkdown, { msg: r.messages.value[1] as MessageChat }),
        ]),
    });
    app.mount(hote);
    await Vue.nextTick();
    expect(hote.querySelector("pre")?.textContent).toBe("Pensée une. Pensée deux.");
    expect(hote.querySelector(".markdown-body")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Premier paragraphe. Deuxième qui grandit encore",
    );
    await contenu(api, " et encore");
    await reflexion(api, " Trois.");
    await image(60);
    expect(hote.querySelector(".markdown-body")?.textContent).toContain("grandit encore et encore");
    expect(hote.querySelector("pre")?.textContent).toBe("Pensée une. Pensée deux. Trois.");
    app.unmount();
  });
});

describe("textes faits de blancs", () => {
  it("content puis narration en blancs seuls : le message est remplacé quand le premier vrai caractère arrive", async () => {
    const { api, r, remplacements } = monter();
    await contenu(api, "\n\n  ");
    await image(5);
    const blancs = remplacements();
    expect(blancs).toBeGreaterThan(0);
    expect(bulle(r).content).toBe("\n\n  ");
    await contenu(api, "Texte");
    await image(5);
    expect(remplacements()).toBeGreaterThan(blancs);
    expect(bulle(r)._flux?.corps.value.actif).toContain("Texte");
    await outil(api);
    await contenu(api, "   ");
    await image(5);
    const narrationBlanche = remplacements();
    expect(bulle(r)._pendingPreContent).toBe("   ");
    await contenu(api, "Je regarde.");
    await image(5);
    expect(remplacements()).toBeGreaterThan(narrationBlanche);
    expect(bulle(r)._pendingPreContent).toBe("   Je regarde.");
  });
});
