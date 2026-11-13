// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/envoi-bulle.test.ts — envoi : la bulle d'attente arrive dans le bloc synchrone du message (conversation neuve comprise), son indicateur dans chaque déroulé, tour détaché, erreur précoce, Stop pendant la création du chat. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CorpsMessage from "../../../src/components/chat/message/CorpsMessage.vue";
import { GestionnaireSession } from "../../../src/features/auth/session";
import { setupChat } from "../../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../../src/features/chat/coeur/chat";
import { statusPhase } from "../../../src/features/chat/coeur/formats";
import { bulleAssistant } from "../../../src/features/chat/coeur/generation";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";
import type { ContexteMessage, MessageAffiche } from "../../../src/features/chat/message/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";
import { CLE_PREFERENCES_CHAT, DEROULES } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";

type Ev = Record<string, unknown>;
type Api = Record<string, unknown> & {
  sendMessage(): Promise<void>;
  stopGeneration(): void;
  startNewChat(): Promise<void>;
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

function refs(messages: MessageChat[], chatId: string): RefsRacineChat {
  return {
    user: Vue.ref(null),
    settings: Vue.ref({ enable_editor: false }),
    config: Vue.ref({ active_mcp_ids: [] }),
    messages: Vue.ref(messages),
    currentChatId: Vue.ref(chatId),
    inputMessage: Vue.ref(""),
    inputRef: Vue.ref(null),
    isStreaming: Vue.ref(false),
    currentView: Vue.ref("chat"),
    isUserScrolling: Vue.ref(false),
    features: Vue.ref({}),
  } as RefsRacineChat;
}

interface Creation {
  appels: number;
  finir(id: string | null): void;
}

/** Contexte dont la création du chat reste en attente jusqu'à `finir` ; `null` la refuse. */
function ctxCreation(toasts: string[] = []): { c: CtxChat; creation: Creation } {
  let fin: (r: Response) => void = () => undefined;
  const creation: Creation = {
    appels: 0,
    finir: (id) =>
      fin(id ? new Response(JSON.stringify({ id }), { status: 200 }) : new Response("{}", { status: 500 })),
  };
  const c = {
    showToast: (m: string, t?: string) => void toasts.push((t || "") + ":" + m),
    fetchAuth: (u: string) => {
      if (u !== "/api/saved/chats/new") return Promise.resolve(new Response("{}", { status: 404 }));
      creation.appels++;
      return new Promise<Response>((res) => (fin = res));
    },
    openConfirm: async () => true,
    openPrompt: async () => null,
    systemAlert: Vue.ref(null),
    liveLogs: Vue.ref(null),
  } as unknown as CtxChat;
  return { c, creation };
}

function monter(r: RefsRacineChat, c: CtxChat): { api: Api; scope: Vue.EffectScope } {
  const scope = Vue.effectScope();
  const api = scope.run(() => setupChat(new GestionnaireSession(), r, c, MODULES)) as unknown as Api;
  return { api, scope };
}

function reponseNdjson(evs: readonly Ev[], signal?: AbortSignal, ouvert = false): Response {
  const lignes = evs.map((e) => JSON.stringify(e) + "\n");
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(ctl) {
        signal?.addEventListener("abort", () => ctl.error(new DOMException("Aborted", "AbortError")));
      },
      pull(ctl) {
        if (i < lignes.length) ctl.enqueue(new TextEncoder().encode(lignes[i++] ?? ""));
        else if (!ouvert) ctl.close();
        else return new Promise<void>(() => undefined);
        return undefined;
      },
    }),
    { status: 200 },
  );
}

const FINAL: Ev = {
  type: "final",
  assistant: "Bonjour",
  chat_id: "n1",
  title: "Salut",
  run_ids: [],
  metrics: null,
  persisted: true,
};

/** Requêtes du flux : corps lus, réponse = le tour complet. */
function fluxCourt(corps: Ev[]): void {
  vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) => {
    corps.push(JSON.parse(init.body) as Ev);
    return reponseNdjson([{ type: "content_token", text: "Bon", n: 1 }, FINAL], init.signal);
  });
}

async function jusqua(fini: () => boolean): Promise<void> {
  for (let k = 0; k < 400 && !fini(); k++) await vi.advanceTimersByTimeAsync(25);
}

const roles = (r: RefsRacineChat): string[] => r.messages.value.map((m) => m.role);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bulle d'attente au moment de l'envoi", () => {
  it("conversation existante : message et bulle dans le même bloc synchrone, indicateur déjà là", () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    const r = refs([], "c1");
    const { api, scope } = monter(r, ctxCreation().c);
    r.inputMessage.value = "Salut";
    void api.sendMessage();
    expect(roles(r)).toEqual(["user", "assistant"]);
    const bulle = r.messages.value[1];
    expect(bulle).toMatchObject({ isStreaming: true, content: "", _statusLine: "Réflexion…" });
    expect(statusPhase(bulle)).toEqual({ kind: "think", label: "Réflexion…" });
    expect(r.isStreaming.value).toBe(true);
    scope.stop();
  });

  it("conversation neuve : message, bulle et indicateur avant la fin de la création, une seule bulle ensuite", async () => {
    const corps: Ev[] = [];
    fluxCourt(corps);
    const { c, creation } = ctxCreation();
    const r = refs([], "");
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Salut";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    expect(creation.appels).toBe(1);
    expect(r.currentChatId.value).toBe("");
    expect(roles(r)).toEqual(["user", "assistant"]);
    expect(r.messages.value[1]).toMatchObject({ isStreaming: true, _statusLine: "Réflexion…" });
    expect(corps).toEqual([]);
    creation.finir("n1");
    await jusqua(() => fini);
    expect(roles(r)).toEqual(["user", "assistant"]);
    expect(r.messages.value[1]).toMatchObject({ content: "Bonjour", isStreaming: false });
    expect(corps).toHaveLength(1);
    expect(corps[0]).toMatchObject({ chat_id: "n1", is_continue: false });
    expect((corps[0]?.["messages"] as { role: string }[]).map((m) => m.role)).toEqual(["user"]);
    expect(r.currentChatId.value).toBe("n1");
    expect(r.isStreaming.value).toBe(false);
    scope.stop();
  });

  it("conversation non enregistrée : l'avertissement reste, l'envoi part en conversation provisoire, une seule bulle", async () => {
    const corps: Ev[] = [];
    fluxCourt(corps);
    const toasts: string[] = [];
    const { c, creation } = ctxCreation(toasts);
    const r = refs([], "");
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Salut";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    expect(roles(r)).toEqual(["user", "assistant"]);
    creation.finir(null);
    await jusqua(() => fini);
    expect(toasts.some((t) => t.startsWith("warning:Conversation non enregistrée"))).toBe(true);
    expect(corps).toHaveLength(1);
    expect(corps[0]).toMatchObject({ chat_id: "" });
    expect(roles(r)).toEqual(["user", "assistant"]);
    expect(r.messages.value[1]).toMatchObject({ content: "Bonjour", isStreaming: false });
    scope.stop();
  });

  it("mode Images, conversation neuve : bulle d'image et progression initiale avant la création, sans statut de réflexion", () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    const { c, creation } = ctxCreation();
    const r = refs([{ role: "user", content: "Un chat", image_request: { size: "512x512", n: 2 } }], "");
    const { api, scope } = monter(r, c);
    void (api["generateResponse"] as () => Promise<void>)();
    expect(creation.appels).toBe(1);
    expect(roles(r)).toEqual(["user", "assistant"]);
    expect(r.messages.value[1]).toMatchObject({
      isStreaming: true,
      _imageTurn: true,
      _imageProgress: { state: "queued", n: 2 },
      _statusLine: "",
    });
    expect(statusPhase(r.messages.value[1])).toBeNull();
    scope.stop();
  });

  it("continuation : aucune bulle de plus", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) =>
      reponseNdjson([{ type: "content_token", text: " suite", n: 1 }, FINAL], init.signal),
    );
    const r = refs(
      [
        { role: "user", content: "Q" },
        { role: "assistant", content: "R", isTruncated: true },
      ],
      "c1",
    );
    const { api, scope } = monter(r, ctxCreation().c);
    let fini = false;
    void (api["continueGeneration"] as () => Promise<void>)().then(() => (fini = true));
    expect(roles(r)).toEqual(["user", "assistant"]);
    await jusqua(() => fini);
    expect(roles(r)).toEqual(["user", "assistant"]);
    scope.stop();
  });
});

describe("tour détaché pendant la création", () => {
  it("la bulle reste dans le tableau capturé, l'écran suivant n'est pas touché, le tour part", async () => {
    const corps: Ev[] = [];
    fluxCourt(corps);
    const { c, creation } = ctxCreation();
    const r = refs([], "");
    const { api, scope } = monter(r, c);
    const capture = r.messages.value;
    r.inputMessage.value = "Salut";
    void api.sendMessage();
    expect(capture.map((m) => m.role)).toEqual(["user", "assistant"]);
    await api.startNewChat();
    expect(r.messages.value).not.toBe(capture);
    expect(r.messages.value).toEqual([]);
    expect(r.isStreaming.value).toBe(false);
    creation.finir("n1");
    await vi.advanceTimersByTimeAsync(500);
    expect(corps).toHaveLength(1);
    expect(corps[0]).toMatchObject({ chat_id: "n1" });
    expect((corps[0]?.["messages"] as { role: string }[]).map((m) => m.role)).toEqual(["user"]);
    expect(r.messages.value).toEqual([]);
    expect(capture.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.currentChatId.value).toBeNull();
    expect(r.isStreaming.value).toBe(false);
    expect((api["statusText"] as Vue.Ref<string>).value).toBe("");
    scope.stop();
  });
});

describe("erreur précoce", () => {
  it("exception avant la requête : la bulle est close en erreur, le garde anti double envoi relâché", async () => {
    const corps: Ev[] = [];
    fluxCourt(corps);
    const { c } = ctxCreation();
    c._lockAutoScroll = () => {
      throw new Error("verrou en échec");
    };
    const r = refs([], "c1");
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Salut";
    const echec = api.sendMessage().then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await echec).toBeInstanceOf(Error);
    expect(roles(r)).toEqual(["user", "assistant"]);
    expect(r.messages.value[1]).toMatchObject({
      isStreaming: false,
      isError: true,
      errorMessage: "verrou en échec",
      _statusLine: "",
    });
    expect(r.isStreaming.value).toBe(false);
    expect(corps).toEqual([]);
    scope.stop();
  });

  it("exception après la création du chat : même fermeture, aucune requête de flux", async () => {
    const corps: Ev[] = [];
    fluxCourt(corps);
    const { c, creation } = ctxCreation();
    c.showToast = () => {
      throw new Error("toast en échec");
    };
    const r = refs([], "");
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Salut";
    const echec = api.sendMessage().then(
      () => null,
      (err: unknown) => err,
    );
    creation.finir(null);
    await vi.advanceTimersByTimeAsync(50);
    expect(await echec).toBeInstanceOf(Error);
    expect(r.messages.value[1]).toMatchObject({ isStreaming: false, isError: true });
    expect(r.isStreaming.value).toBe(false);
    expect(corps).toEqual([]);
    scope.stop();
  });
});

describe("Stop pendant la création du chat", () => {
  it("la bulle est close, rien ne part, le chat créé reste utilisable", async () => {
    const corps: Ev[] = [];
    fluxCourt(corps);
    const { c, creation } = ctxCreation();
    const annulations: unknown[] = [];
    const base = c.fetchAuth;
    c.fetchAuth = ((u: string, init?: RequestInit) => {
      if (u === "/api/chat/cancel") annulations.push(JSON.parse(String(init?.body)));
      return base(u, init);
    }) as CtxChat["fetchAuth"];
    const r = refs([], "");
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Salut";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    expect(r.isStreaming.value).toBe(true);
    api.stopGeneration();
    expect(r.isStreaming.value).toBe(false);
    expect(r.messages.value[1]).toMatchObject({ isStreaming: false, _statusLine: "" });
    creation.finir("n1");
    await jusqua(() => fini);
    expect(corps).toEqual([]);
    expect(roles(r)).toEqual(["user", "assistant"]);
    expect(r.messages.value[1]).toMatchObject({ isStreaming: false });
    expect(r.isStreaming.value).toBe(false);
    expect((api["statusText"] as Vue.Ref<string>).value).toBe("");
    expect(annulations).toEqual([{}]);
    scope.stop();
  });
});

describe("indicateur de la bulle vide dans chaque déroulé", () => {
  let app: Vue.App | null = null;
  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  function contexte(): ContexteMessage {
    const etat = Vue.reactive({
      settings: {},
      lastAssistantIdx: 1,
      isStreaming: true,
      logoApp: "x.png",
      compressionStatus: null,
      messageSearchQ: "",
      messageSearchActive: false,
    });
    const neutres: Record<string, unknown> = {
      statusPhase,
      pipelineFor: () => ({ show: false, nTools: 0, nComp: 0, running: false, label: "", summary: "" }),
      segGroupsFor: () => [],
      effectLinesFor: () => [],
      diffFilesFor: () => [],
      hasDiffFiles: () => false,
      isDiffEditorEnabled: () => false,
      isImageMessage: () => false,
      fmtThinkingMeta: () => "",
      thinkingTokensOf: () => 0,
      cachePctOf: () => 0,
      metricsTooltip: () => "",
      fmtElapsed: (d: number) => `${d} s`,
    };
    return new Proxy(etat, {
      get(cible, cle: string) {
        if (cle in cible) return (cible as Record<string, unknown>)[cle];
        if (cle in neutres) return neutres[cle];
        return () => undefined;
      },
    }) as unknown as ContexteMessage;
  }

  it("bulle posée à l'envoi : la phase « Réflexion… » est visible avant tout événement du serveur", () => {
    for (const d of DEROULES) {
      const hote = document.createElement("div");
      document.body.appendChild(hote);
      const msg = Vue.reactive({
        ...bulleAssistant(),
        _statusLine: "Réflexion…",
      }) as unknown as MessageAffiche;
      app = Vue.createApp({ render: () => Vue.h(CorpsMessage, { entry: { idx: 1, msg }, pied: false }) });
      app.provide(CLE_PREFERENCES_CHAT, prefsDeroule(d));
      app.provide(CLE_FIL, contexte());
      app.mount(hote);
      const etat = hote.querySelector('[role="status"]');
      expect(etat?.textContent?.replace(/\s+/g, " ").trim(), d).toBe("Réflexion…");
      app.unmount();
      app = null;
      hote.remove();
    }
  });

  it("bulle vide sans statut : aucun indicateur (ce que l'envoi corrige)", () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const msg = Vue.reactive({ ...bulleAssistant() }) as unknown as MessageAffiche;
    app = Vue.createApp({ render: () => Vue.h(CorpsMessage, { entry: { idx: 1, msg }, pied: false }) });
    app.provide(CLE_PREFERENCES_CHAT, prefsDeroule("classic"));
    app.provide(CLE_FIL, contexte());
    app.mount(hote);
    expect(hote.querySelector('[role="status"]')).toBeNull();
  });
});
