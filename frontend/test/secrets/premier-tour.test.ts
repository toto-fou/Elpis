// SPDX-License-Identifier: MIT
/** frontend/test/secrets/premier-tour.test.ts — cœur du chat et secrets attachés : sélection d'un chat neuf envoyée avec son premier tour (`secrets`), absente des tours suivants, puces relues du serveur ; chat chargé avec ses secrets ; nouveau chat sans puce. */
import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupChat } from "../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../src/features/chat/coeur/chat";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../src/features/chat/coeur/types";
import type { SecretsChat } from "../../src/features/secrets/chat";
import { fauxServeur, json, secret } from "./aides";

type Api = Record<string, unknown> & {
  sendMessage(): Promise<void>;
  loadChat(id: string): Promise<void>;
  startNewChat(): Promise<void>;
  secretsChat: SecretsChat;
};

const COMPTE = [secret(1, { name: "intranet-admin" }), secret(2, { name: "proxy", kind: "http-auth" })];

function modules(api: ReturnType<typeof fauxServeur>["api"]): ModulesChat {
  return {
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
    secrets: () => api,
  } as unknown as ModulesChat;
}

function refs(chat: string | null): RefsRacineChat {
  return {
    user: Vue.ref({ username: "alice" }),
    settings: Vue.ref({ enable_editor: false }),
    config: Vue.ref({ active_mcp_ids: [] }),
    messages: Vue.ref<MessageChat[]>([]),
    currentChatId: Vue.ref(chat),
    inputMessage: Vue.ref(""),
    inputRef: Vue.ref(null),
    isStreaming: Vue.ref(false),
    currentView: Vue.ref("chat"),
    isUserScrolling: Vue.ref(false),
    features: Vue.ref({}),
  } as RefsRacineChat;
}

function ctx(chats: Record<string, unknown> = {}): CtxChat {
  return {
    showToast: () => undefined,
    fetchAuth: async (url: string) => {
      if (url.startsWith("/api/saved/chats/new")) return new Response(JSON.stringify({ id: "n1" }));
      const id = /^\/api\/saved\/chats\/([^/?]+)$/u.exec(url)?.[1];
      if (id && chats[id]) return new Response(JSON.stringify(chats[id]));
      return new Response("{}", { status: 404 });
    },
    openConfirm: async () => true,
    openPrompt: async () => null,
    systemAlert: Vue.ref(null),
    liveLogs: Vue.ref(null),
  } as unknown as CtxChat;
}

function flux(signal: AbortSignal, chatId: unknown): Response {
  const lignes = [
    { type: "content_token", text: "Ok", n: 1 },
    { type: "final", assistant: "Ok", chat_id: chatId, run_ids: [], metrics: null, persisted: true },
  ].map((e) => JSON.stringify(e) + "\n");
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(ctl) {
        signal?.addEventListener("abort", () => ctl.error(new DOMException("Aborted", "AbortError")));
      },
      pull(ctl) {
        if (i < lignes.length) ctl.enqueue(new TextEncoder().encode(lignes[i++] ?? ""));
        else ctl.close();
      },
    }),
    { status: 200 },
  );
}

async function jusqua(fini: () => boolean): Promise<void> {
  for (let k = 0; k < 400 && !fini(); k++) await vi.advanceTimersByTimeAsync(25);
}

function monter(chat: string | null, chats: Record<string, unknown> = {}) {
  const serveur = fauxServeur((url, methode, corps) => {
    if (url === "/api/secrets") return json({ secrets: COMPTE });
    const ids = methode === "PUT" ? (corps as { ids: number[] }).ids : [1];
    return json({ secrets: COMPTE.filter((s) => ids.includes(s.id)) });
  });
  const r = refs(chat);
  const scope = Vue.effectScope();
  const api = scope.run(() =>
    setupChat(new GestionnaireSession(), r, ctx(chats), modules(serveur.api)),
  ) as unknown as Api;
  return { api, r, scope, appels: serveur.appels };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("secrets et tours", () => {
  it("chat neuf : la sélection part avec le premier tour (`secrets`), pas avec les suivants ; puces relues", async () => {
    const corps: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) => {
      const c = JSON.parse(init.body) as Record<string, unknown>;
      corps.push(c);
      return flux(init.signal, c["chat_id"]);
    });
    const { api, r, scope, appels } = monter(null);
    expect(await api.secretsChat.commande.lancer("attach intranet-admin")).toMatchObject({ ok: true });
    expect(appels.map((a) => a.methode)).toEqual(["GET"]);
    r.inputMessage.value = "Connecte-toi à l'intranet";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    expect(r.currentChatId.value).toBe("n1");
    expect(corps[0]).toMatchObject({ chat_id: "n1", secrets: [1] });
    expect(appels.at(-1)).toMatchObject({ url: "/api/chats/n1/secrets", methode: "GET" });
    expect(api.secretsChat.enAttente()).toBeNull();
    r.inputMessage.value = "Et maintenant ?";
    fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    expect(corps).toHaveLength(2);
    expect(corps[1]).not.toHaveProperty("secrets");
    scope.stop();
  });

  it("chat existant : aucun `secrets` dans le tour (l'attache passe par PUT)", async () => {
    const corps: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) => {
      const c = JSON.parse(init.body) as Record<string, unknown>;
      corps.push(c);
      return flux(init.signal, c["chat_id"]);
    });
    const { api, r, scope, appels } = monter("c1");
    await api.secretsChat.commande.lancer("attach proxy");
    expect(appels.at(-1)).toEqual({ url: "/api/chats/c1/secrets", methode: "PUT", corps: { ids: [2] } });
    r.inputMessage.value = "Bonjour";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    expect(corps[0]).not.toHaveProperty("secrets");
    scope.stop();
  });

  it("chat chargé : ses secrets attachés deviennent des puces ; nouveau chat : plus aucune", async () => {
    const { api, scope, appels } = monter(null, {
      c7: { id: "c7", title: "Intranet", messages: [], secrets: [1] },
    });
    await api.loadChat("c7");
    await jusqua(() => api.secretsChat.attaches.value.length > 0);
    expect(appels.some((a) => a.url === "/api/chats/c7/secrets")).toBe(true);
    expect((api["secretsAttaches"] as Vue.Ref<{ name: string }[]>).value.map((s) => s.name)).toEqual([
      "intranet-admin",
    ]);
    await api.startNewChat();
    expect(api.secretsChat.attaches.value).toEqual([]);
    scope.stop();
  });
});
