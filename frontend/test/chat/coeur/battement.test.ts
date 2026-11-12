// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/battement.test.ts — battement du flux : un remplacement du message par image, arrêt au repos, budget par image, onglet caché, vidage synchrone (Stop, appel d'outil, fin), voix. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../../src/features/auth/session";
import { setupChat } from "../../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../../src/features/chat/coeur/chat";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";

type Ev = Record<string, unknown>;
type Api = Record<string, unknown> & {
  handleStreamEvent(e: Ev): Promise<void>;
  stopGeneration(): void;
};

const voix = {
  onAssistantStream: vi.fn(),
  onAssistantToolStream: vi.fn(),
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
    onAssistantStream: voix.onAssistantStream,
    onAssistantToolStream: voix.onAssistantToolStream,
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
const IMAGE = 1000 / 60;

async function image(n = 1): Promise<void> {
  for (let k = 0; k < n; k++) {
    vi.advanceTimersByTime(IMAGE);
    const rappels = [...file.values()];
    file.clear();
    for (const rappel of rappels) rappel(performance.now());
    await vi.advanceTimersByTimeAsync(0);
  }
}

function monter(texte = ""): { api: Api; r: RefsRacineChat; remplacements: () => number; stop: () => void } {
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
  return { api, r, remplacements: () => n, stop: () => scope.stop() };
}

const bulle = (r: RefsRacineChat): MessageChat | undefined => r.messages.value[1];
const contenu = (api: Api, texte: string, n = 1): Promise<void> =>
  api.handleStreamEvent({ type: "content_token", text: texte, n });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  file = new Map();
  ids = 0;
  vi.stubGlobal("requestAnimationFrame", (rappel: FrameRequestCallback) => {
    file.set(++ids, rappel);
    return ids;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => file.delete(id));
  voix.onAssistantStream.mockClear();
  voix.onAssistantToolStream.mockClear();
});

afterEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("battement : une image, un remplacement", () => {
  it("plusieurs événements dans la même image : un seul remplacement du message", async () => {
    const { api, r, remplacements, stop } = monter();
    await contenu(api, "Bon");
    await contenu(api, "jour");
    await contenu(api, " tout");
    expect(remplacements()).toBe(0);
    await image();
    expect(remplacements()).toBe(1);
    expect(bulle(r)?.content).toBe("Bonjour tout");
    stop();
  });

  it("réflexion, corps et sortie shell arrivés ensemble : un seul remplacement par image", async () => {
    const { api, r, remplacements, stop } = monter();
    r.messages.value[1] = {
      ...r.messages.value[1]!,
      toolSteps: [{ name: "execute_shell", status: "running", callId: "s" }],
    };
    const avant = remplacements();
    await api.handleStreamEvent({ type: "thinking_token", text: "Je réfléchis. ", n: 1 });
    await api.handleStreamEvent({
      type: "shell_output",
      name: "execute_shell",
      call_id: "s",
      chunk: "ligne 1\n",
      seq: 1,
    });
    await image();
    expect(remplacements() - avant).toBe(1);
    expect(bulle(r)?.thinking).toBe("Je réfléchis. ");
    expect(bulle(r)?.toolSteps?.[0]?.shellOut).toBe("ligne 1\n");
    stop();
  });

  it("la sortie shell d'une étape est coalescée : au plus un patch toutes les 100 ms", async () => {
    const { api, r, remplacements, stop } = monter();
    r.messages.value[1] = {
      ...r.messages.value[1]!,
      toolSteps: [{ name: "execute_shell", status: "running", callId: "s" }],
    };
    const avant = remplacements();
    for (let k = 1; k <= 12; k++) {
      await api.handleStreamEvent({
        type: "shell_output",
        name: "execute_shell",
        call_id: "s",
        chunk: `l${k}\n`,
        seq: k,
      });
      await image();
    }
    const patchs = remplacements() - avant;
    expect(patchs).toBeGreaterThanOrEqual(1);
    expect(patchs).toBeLessThanOrEqual(3);
    await image(8);
    expect(bulle(r)?.toolSteps?.[0]?.shellOut).toBe(
      Array.from({ length: 12 }, (_v, k) => `l${k + 1}\n`).join(""),
    );
    stop();
  });
});

describe("battement : arrêt au repos", () => {
  it("rien n'est demandé tant qu'aucun tampon ne reçoit de texte, ni une fois tout versé", async () => {
    const { api, stop } = monter();
    expect(file.size).toBe(0);
    await contenu(api, "Un texte assez long pour plusieurs images de suite.");
    expect(file.size).toBe(1);
    await image(40);
    expect(file.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("l'événement d'erreur puis la fin de flux laissent le battement éteint", async () => {
    const { api, stop } = monter();
    await contenu(api, "abc");
    await image(30);
    await api.handleStreamEvent({ type: "error", text: "boum" });
    await image(3);
    expect(file.size).toBe(0);
    stop();
  });
});

describe("battement : budget", () => {
  it("un battement coûteux fait sauter des images, les tampons se remplissent entre deux", async () => {
    const { api, r, remplacements, stop } = monter();
    const moteur = moteurMarkdown();
    const vrai = moteur.renderStreamingActive;
    const rendu = vi.spyOn(moteur, "renderStreamingActive").mockImplementation((t: string) => {
      vi.advanceTimersByTime(12);
      return vrai(t);
    });
    await contenu(api, "a");
    await image();
    expect(remplacements()).toBe(1);
    // 12 ms de coût moyen : une image sur trois.
    const avant = remplacements();
    for (let k = 0; k < 6; k++) {
      await contenu(api, "b");
      await image();
    }
    expect(remplacements() - avant).toBe(2);
    expect(bulle(r)?.content).toBe("abbbbbb".slice(0, (bulle(r)?.content ?? "").length));
    rendu.mockRestore();
    stop();
  });
});

describe("battement : onglet caché", () => {
  it("aucune image, une minuterie de 250 ms verse tout d'un coup, la voix reçoit le texte", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const { api, r, remplacements, stop } = monter();
    await contenu(api, "Bonjour ");
    await contenu(api, "à tous");
    expect(file.size).toBe(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(remplacements()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(remplacements()).toBe(1);
    expect(bulle(r)?.content).toBe("Bonjour à tous");
    expect(voix.onAssistantStream).toHaveBeenLastCalledWith("Bonjour à tous");
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("le retour de l'onglet annule la minuterie et reprend aux images", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const { api, r, stop } = monter();
    await contenu(api, "Texte en attente");
    expect(file.size).toBe(0);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(file.size).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(bulle(r)?.content).toBe("");
    await image();
    expect(bulle(r)?.content).toBe("Texte en attente");
    stop();
  });
});

describe("battement : vidage synchrone", () => {
  it("Stop verse tout de suite le texte en attente et éteint le battement", async () => {
    const { api, r, stop } = monter();
    await api.handleStreamEvent({ type: "thinking_token", text: "Je pense.", n: 1 });
    await contenu(api, "Début de réponse");
    api.stopGeneration();
    expect(bulle(r)?.thinking).toBe("Je pense.");
    expect(bulle(r)?.content).toContain("Début de réponse");
    expect(bulle(r)?.isStreaming).toBe(false);
    expect(file.size).toBe(0);
    stop();
  });

  it("un appel d'outil verse le texte en attente dans la narration de l'étape", async () => {
    const { api, r, stop } = monter();
    await contenu(api, "Je regarde ce fichier.");
    await api.handleStreamEvent({
      type: "tool_call",
      name: "read_file",
      call_id: "t",
      args: { path: "a.txt" },
    });
    expect(bulle(r)?.segTexts?.join("")).toContain("Je regarde ce fichier.");
    expect(bulle(r)?.content).toBe("");
    expect(file.size).toBe(0);
    stop();
  });

  it("la fin du tour verse tout le texte et éteint le battement", async () => {
    const { api, r, stop } = monter();
    await api.handleStreamEvent({ type: "thinking_token", text: "Réflexion.", n: 1 });
    await contenu(api, "Réponse complète");
    await api.handleStreamEvent({
      type: "final",
      assistant: "",
      chat_id: "c1",
      run_ids: [],
      metrics: null,
      persisted: true,
    });
    expect(bulle(r)).toMatchObject({
      content: "Réponse complète",
      thinking: "Réflexion.",
      isStreaming: false,
    });
    expect(file.size).toBe(0);
    stop();
  });
});

describe("battement : titre de la réflexion", () => {
  it("recalculé au plus toutes les 250 ms", async () => {
    const { api, stop } = monter();
    const statut = api["statusText"] as Vue.Ref<string>;
    const titres: string[] = [];
    Vue.watch(statut, (v) => titres.push(v), { flush: "sync" });
    for (let k = 0; k < 60; k++) {
      await api.handleStreamEvent({ type: "thinking_token", text: `Phrase numéro ${k} terminée. `, n: 1 });
      await image();
    }
    expect(titres.length).toBeGreaterThanOrEqual(3);
    expect(titres.length).toBeLessThanOrEqual(6);
    stop();
  });
});
