// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/coeur.test.ts — cœur du chat : surface lue par la racine, durées, marqueurs de reprise, fermeture des flux d'écriture, envoi, arrêt, continuation, conflit 409, goldens rejoués par la vue. */
import fs from "node:fs";
import path from "node:path";

import * as Vue from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../../src/features/auth/session";
import { setupChat } from "../../../src/features/chat/coeur/chat";
import type { ModulesChat } from "../../../src/features/chat/coeur/chat";
import { creerDeltasOutils } from "../../../src/features/chat/coeur/deltas-outils";
import { creerEtatChat, creerEtatFlux } from "../../../src/features/chat/coeur/etat";
import { fmtTokens } from "../../../src/features/chat/coeur/formats";
import { retirerReprisesPerimees } from "../../../src/features/chat/coeur/generation";
import type { CoeurChat, LiensChat } from "../../../src/features/chat/coeur/liens";
import type { CtxChat, MessageChat, RefsRacineChat } from "../../../src/features/chat/coeur/types";
import { construireMessages } from "../../../src/features/chat/historique/historique";
import { chronologieTour } from "../../../src/features/chat/message/chronologie";
import type { BlocFil } from "../../../src/features/chat/message/chronologie";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import { fmtElapsed, fmtElapsedMs } from "../../../src/utils/utils-purs";

type Ev = Record<string, unknown>;
type Api = Record<string, unknown> & {
  handleStreamEvent(e: Ev): Promise<void>;
  sendMessage(): Promise<void>;
  stopGeneration(): void;
  continueGeneration(): Promise<void>;
};

const RACINE = path.resolve(import.meta.dirname, "../../../..");
// Modules du chat simulés (échantillonnage, voix, images) : le cœur ne lit que ces membres.
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

function refs(messages: MessageChat[] = []): RefsRacineChat {
  return {
    user: Vue.ref(null),
    settings: Vue.ref({ enable_editor: false }),
    config: Vue.ref({ active_mcp_ids: [] }),
    messages: Vue.ref(messages),
    currentChatId: Vue.ref("c1"),
    inputMessage: Vue.ref(""),
    inputRef: Vue.ref(null),
    isStreaming: Vue.ref(false),
    currentView: Vue.ref("chat"),
    isUserScrolling: Vue.ref(false),
    features: Vue.ref({}),
  } as RefsRacineChat;
}

function ctx(toasts: string[] = []): CtxChat {
  return {
    showToast: (m: string, t?: string) => void toasts.push((t || "") + ":" + m),
    fetchAuth: async () => new Response("{}", { status: 404 }),
    openConfirm: async () => true,
    openPrompt: async () => null,
    systemAlert: Vue.ref(null),
    liveLogs: Vue.ref(null),
  } as unknown as CtxChat;
}

function monter(r: RefsRacineChat, c: CtxChat = ctx()): { api: Api; scope: Vue.EffectScope } {
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

async function jusqua(fini: () => boolean): Promise<void> {
  for (let k = 0; k < 400 && !fini(); k++) await vi.advanceTimersByTimeAsync(25);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("surface", () => {
  it("les clés lues par la racine sur le chat (m.chat.x et ses alias) existent", () => {
    const dossier = path.join(RACINE, "frontend/src/app/racine");
    const lues = new Set<string>();
    for (const f of fs.readdirSync(dossier).filter((n) => n.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dossier, f), "utf8");
      const alias = [...src.matchAll(/const (\w+) = (?:s\.modules|m)\.chat;/g)].map((x) => x[1] ?? "");
      for (const nom of ["m\\.chat", "s\\.modules\\.chat", ...alias]) {
        for (const x of src.matchAll(new RegExp(`\\b${nom}\\??\\.([A-Za-z_]\\w*)`, "g")))
          lues.add(x[1] ?? "");
      }
    }
    const { api, scope } = monter(refs());
    const absentes = [...lues].filter((k) => !(k in api));
    scope.stop();
    expect(absentes).toEqual([]);
    expect(lues.size).toBeGreaterThan(50);
  });

  it("durées : la surface délègue aux utilitaires (aucune copie à faire dériver)", () => {
    const { api, scope } = monter(refs());
    expect(api["fmtElapsed"]).toBe(fmtElapsed);
    expect(api["fmtElapsedMs"]).toBe(fmtElapsedMs);
    const outil = api["fmtToolMs"] as (ms: number) => string;
    expect([outil(200), outil(50), outil(1250), outil(42000)]).toEqual(["0,2 s", "< 0,1 s", "1,2 s", "42 s"]);
    expect((api["fmtElapsed"] as (s: number) => string)(7503)).toBe("2 h 05 min");
    scope.stop();
  });
});

describe("recherche dans la conversation", () => {
  it("le compte de résultats suit les bulles affichées : réveils et réponses regroupés comptent une fois", async () => {
    const r = refs([
      { role: "user", content: "Lance pytest" },
      { role: "assistant", content: "pytest lancé" },
      { role: "user", origin: "job_wake", content: "[Automatic wake-up] pytest exit 0" },
      { role: "assistant", content: "pytest est vert" },
      { role: "user", content: "Et ensuite ?" },
    ]);
    const { api, scope } = monter(r);
    (api["messageSearchActive"] as Vue.Ref<boolean>).value = true;
    (api["messageSearch"] as Vue.Ref<string>).value = "pytest";
    await vi.advanceTimersByTimeAsync(300);
    expect((api["messageSearchCount"] as Vue.Ref<number>).value).toBe(2);
    (api["messageSearch"] as Vue.Ref<string>).value = "ensuite";
    await vi.advanceTimersByTimeAsync(300);
    expect((api["messageSearchCount"] as Vue.Ref<number>).value).toBe(1);
    scope.stop();
  });
});

describe("marqueurs de reprise", () => {
  const fil = (): MessageChat[] =>
    [
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "R1",
        isTruncated: true,
        toolLoopTruncated: true,
        toolLoopStats: { iterations: 3 },
      },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "R2", isTruncated: true },
      { role: "notice", content: "" },
    ].map((m) => Object.freeze({ ...m }));

  it("purge : objets gelés remplacés, bulle gardée intacte", () => {
    const m = fil();
    const avant = m.slice();
    retirerReprisesPerimees(m, 3);
    expect(m[1]).not.toBe(avant[1]);
    expect(m[1]).toMatchObject({ isTruncated: false, toolLoopTruncated: false, toolLoopStats: null });
    expect(m[3]).toBe(avant[3]);
    expect(m[0]).toBe(avant[0]);
    retirerReprisesPerimees(m, -1);
    expect(m[3]?.isTruncated).toBe(false);
  });

  it("Continuer : reprend la dernière bulle (après un notice), purge l'ancienne, part en continuation", async () => {
    const corps: Ev[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) => {
      corps.push(JSON.parse(init.body) as Ev);
      return reponseNdjson(
        [
          {
            type: "final",
            assistant: "R2 suite",
            chat_id: "c1",
            run_ids: [],
            metrics: null,
            persisted: true,
          },
        ],
        init.signal,
      );
    });
    const r = refs(fil());
    const { api, scope } = monter(r);
    let fini = false;
    void api.continueGeneration().then(() => (fini = true));
    await jusqua(() => fini);
    expect(corps).toHaveLength(1);
    expect(corps[0]?.["is_continue"]).toBe(true);
    const m = r.messages.value;
    expect(m[1]).toMatchObject({ isTruncated: false, toolLoopTruncated: false, toolLoopStats: null });
    expect(m[3]).toMatchObject({ isStreaming: false, content: "R2 suite" });
    scope.stop();
  });

  it("Continuer pendant une génération, ou sur une bulle complète : rien ne part", async () => {
    const appels: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      appels.push(u);
      return new Response("{}", { status: 500 });
    });
    const r = refs(fil());
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    await api.continueGeneration();
    r.isStreaming.value = false;
    r.messages.value = [
      { role: "user", content: "Q" },
      { role: "assistant", content: "complète" },
    ];
    await api.continueGeneration();
    expect(appels).toEqual([]);
    scope.stop();
  });
});

describe("flux d'écriture dans l'éditeur", () => {
  function deltas(fermes: string[]) {
    const r = refs();
    r.settings.value = { enable_editor: true };
    const c = {
      ...ctx(),
      streamOpenForWrite: async () => true,
      streamWriteChunk: () => undefined,
      streamFinalize: (p: string, o: { success: boolean }) => void fermes.push(p + ":" + String(o.success)),
      models: {},
    } as unknown as CtxChat;
    const l = { relPath: (p: string) => p, prefetchSandboxFile: async () => "" } as unknown as LiensChat;
    const coeur: CoeurChat = { r, ctx: c, e: creerEtatChat(), f: creerEtatFlux(), md: moteurMarkdown(), l };
    return creerDeltasOutils(coeur);
  }

  async function ouvrir(d: ReturnType<typeof deltas>, chat: string, chemin: string): Promise<void> {
    await d.handleToolCallDelta(
      {
        type: "tool_call_delta",
        iter: 0,
        index: 0,
        name_delta: "write_file",
        args_delta: '{"path":"' + chemin + '","content":"x',
      },
      chat,
      false,
    );
  }

  it("fermer les flux d'une conversation ne touche pas aux autres ; les flux sans conversation sont fermés par tout appelant", async () => {
    const fermes: string[] = [];
    const d = deltas(fermes);
    await ouvrir(d, "c1", "a.py");
    await ouvrir(d, "c2", "b.py");
    await ouvrir(d, "local", "c.py");
    await ouvrir(d, "__nouveau", "d.py");
    d.closeToolStreamsFor("c1");
    expect(fermes.sort()).toEqual(["a.py:false", "c.py:false", "d.py:false"]);
    fermes.length = 0;
    d.closeToolStreamsFor(null);
    expect(fermes).toEqual(["b.py:false"]);
  });

  it("ids comparés en chaîne ; un flux jamais ouvert est purgé sans retour arrière", async () => {
    const fermes: string[] = [];
    const d = deltas(fermes);
    await ouvrir(d, "12", "a.py");
    await d.handleToolCallDelta(
      { type: "tool_call_delta", iter: 0, index: 1, name_delta: "read_file", args_delta: "{" },
      "12",
      false,
    );
    d.closeToolStreamsFor("12");
    expect(fermes).toEqual(["a.py:false"]);
  });
});

describe("appel d'outil en génération", () => {
  it("statut « Appel d'outil » : nom de l'outil, puis taille des arguments reçus dès 1000 caractères", async () => {
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    const statuts: unknown[] = [];
    for (const [nom, args] of [
      ["write_file", '{"content":"'],
      ["", "x".repeat(987)],
      ["", "x"],
      ["", "x".repeat(1500)],
    ] as const) {
      await api.handleStreamEvent({
        type: "tool_call_delta",
        iter: 0,
        index: 0,
        name_delta: nom,
        args_delta: args,
      });
      statuts.push(r.messages.value[1]?._statusLine);
    }
    expect(statuts).toEqual([
      "Appel d'outil · write_file…",
      "Appel d'outil · write_file…",
      `Appel d'outil · write_file (${fmtTokens(1000)} caractères)…`,
      `Appel d'outil · write_file (${fmtTokens(2500)} caractères)…`,
    ]);
    scope.stop();
  });
});

describe("tour complet", () => {
  it("envoi : message utilisateur, flux lu, bulle finalisée, purge des marqueurs avant la nouvelle bulle", async () => {
    let corps: Ev | null = null;
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) => {
      corps = JSON.parse(init.body) as Ev;
      return reponseNdjson(
        [
          { type: "content_token", text: "Bon", n: 1 },
          { type: "content_token", text: "jour", n: 1 },
          {
            type: "final",
            assistant: "Bonjour",
            chat_id: "c1",
            title: "Salutations",
            run_ids: [],
            metrics: null,
            persisted: true,
          },
        ],
        init.signal,
      );
    });
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "R", isTruncated: true },
    ]);
    const { api, scope } = monter(r);
    r.inputMessage.value = "Salut";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    const m = r.messages.value;
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(m[1]?.isTruncated).toBe(false);
    expect(m[3]).toMatchObject({ content: "Bonjour", isStreaming: false });
    expect(r.isStreaming.value).toBe(false);
    expect((api["currentChatTitle"] as Vue.Ref<string>).value).toBe("Salutations");
    expect(corps).toMatchObject({ is_continue: false, chat_id: "c1", resumable: true });
    scope.stop();
  });

  it("titre du modèle : la liste et l'en-tête suivent dès l'événement, avant le final", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) =>
      reponseNdjson([{ type: "title", chat_id: "c1", title: "Titre du modèle" }], init.signal, true),
    );
    const r = refs([]);
    const { api, scope } = monter(r);
    const chats = api["chats"] as Vue.Ref<{ id: string; title: string }[]>;
    chats.value = [
      { id: "c1", title: "Bonjour" },
      { id: "c2", title: "Autre" },
    ];
    r.inputMessage.value = "Bonjour";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    const titre = api["currentChatTitle"] as Vue.Ref<string>;
    await jusqua(() => titre.value === "Titre du modèle");
    expect(r.isStreaming.value).toBe(true);
    expect(chats.value.map((c) => c.title)).toEqual(["Titre du modèle", "Autre"]);
    api.stopGeneration();
    await jusqua(() => fini);
    scope.stop();
  });

  it("chat créé par le tour sans titre reçu : la liste est relue une fois de plus après la fin", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) =>
      reponseNdjson(
        [{ type: "final", assistant: "Bonjour", chat_id: "n1", run_ids: [], metrics: null, persisted: true }],
        init.signal,
      ),
    );
    let lectures = 0;
    const c = ctx();
    c.fetchAuth = (async (url: string) => {
      if (url.startsWith("/api/saved/chats/new")) return new Response(JSON.stringify({ id: "n1" }));
      if (url.startsWith("/api/saved/chats?")) lectures++;
      return new Response("{}", { status: 404 });
    }) as CtxChat["fetchAuth"];
    const r = refs([]);
    r.currentChatId.value = null;
    r.user.value = { username: "alice" };
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Bonjour";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    await vi.advanceTimersByTimeAsync(100);
    const avant = lectures;
    await vi.advanceTimersByTimeAsync(5000);
    expect(lectures).toBe(avant + 1);
    scope.stop();
  });

  it("envoi : la réflexion des réponses précédentes reste affichée et part avec elles pour être enregistrée", async () => {
    let corps: { messages?: Ev[] } | null = null;
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) => {
      corps = JSON.parse(init.body) as { messages?: Ev[] };
      return reponseNdjson(
        [{ type: "final", assistant: "Ok", chat_id: "c1", run_ids: [], metrics: null, persisted: true }],
        init.signal,
      );
    });
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "R", thinking: "je compare deux pistes", thinkingOpen: true },
    ]);
    const { api, scope } = monter(r);
    r.inputMessage.value = "Et ensuite ?";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    expect(r.messages.value[1]).toMatchObject({ thinking: "je compare deux pistes", thinkingOpen: true });
    const envoyes = (corps as { messages?: Ev[] } | null)?.messages ?? [];
    expect(envoyes[1]).toMatchObject({ role: "assistant", thinking: "je compare deux pistes" });
    expect(envoyes[0]?.["thinking"]).toBeUndefined();
    scope.stop();
  });

  it("sous-agent fini : le bloc du harnais de l'étape finale est validé et gardé sur le run, un bloc illisible est écarté", async () => {
    const bilan = {
      status: "budget_exhausted",
      tool_calls: 95,
      tool_calls_total: 95,
      iterations: 95,
      resumed: false,
      duration_s: 12.5,
      files_changed: [],
      git: { commits: [] },
      errors: 0,
      read_only: true,
      report_chars: 10,
    };
    const fin = (cid: string, harness: unknown) => ({
      type: "task_step",
      child_id: cid,
      call_id: cid === "k1" ? "t1" : "t2",
      agent: "explore",
      status: "final",
      state: "incomplete",
      steps_total: 95,
      context_tokens: 10,
      input_tokens: 5,
      output_tokens: 5,
      duration_ms: 12500,
      transcript: [],
      result: "rapport",
      harness,
    });
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) =>
      reponseNdjson(
        [
          { type: "tool_call", name: "task", call_id: "t1", args: { subagent_type: "explore" } },
          { type: "tool_call", name: "task", call_id: "t2", args: { subagent_type: "explore" } },
          {
            type: "task_step",
            child_id: "k1",
            call_id: "t1",
            agent: "explore",
            status: "spawned",
            resumed: false,
            depth: 0,
          },
          {
            type: "task_step",
            child_id: "k2",
            call_id: "t2",
            agent: "explore",
            status: "spawned",
            resumed: false,
            depth: 0,
          },
          {
            type: "task_step",
            child_id: "k2",
            call_id: "t2",
            agent: "explore",
            status: "tick",
            tokens: 900,
            input_tokens: 3000,
            output_tokens: 40,
            cache_tokens: 2500,
            think_tokens: 0,
          },
          fin("k1", bilan),
          fin("k2", { status: "done" }),
          { type: "final", assistant: "Fini", chat_id: "c1" },
        ],
        init.signal,
      ),
    );
    const r = refs([{ role: "user", content: "Q" }]);
    const { api, scope } = monter(r);
    r.inputMessage.value = "Cherche";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    const runs = r.messages.value[r.messages.value.length - 1]?.taskRuns ?? [];
    expect(runs.map((x) => x.id)).toEqual(["k1", "k2"]);
    expect(runs[0]?.harness).toEqual(bilan);
    expect(runs[1]?.harness).toBeUndefined();
    expect(runs[0]).toMatchObject({ tokens: 10, input_tokens: 5, output_tokens: 5 });
    expect(runs[1]).toMatchObject({
      tokens: 900,
      input_tokens: 3000,
      output_tokens: 40,
      cache_tokens: 2500,
    });
    scope.stop();
  });

  it("sous-agents parallèles dans le désordre et refus avant lancement : chaque étape sur la ligne de son appel, Arrêter vise le bon enfant", async () => {
    const annulations: unknown[] = [];
    const c = ctx();
    c.fetchAuth = async (u: string, init?: RequestInit) => {
      if (u === "/api/chat/task-cancel") annulations.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r, c);
    const etape = (callId: string, cid: string, agent: string, e: Ev): Ev => ({
      type: "task_step",
      child_id: cid,
      call_id: callId,
      agent,
      ...e,
    });
    const final = (state: string, harness: unknown): Ev => ({
      status: "final",
      state,
      steps_total: 0,
      context_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
      transcript: [],
      result: "",
      harness,
    });
    const bilanRefus = {
      status: "unavailable",
      tool_calls: 0,
      tool_calls_total: 0,
      iterations: 0,
      resumed: false,
      duration_s: 0,
      files_changed: [],
      git: { commits: [] },
      errors: 0,
      read_only: false,
      report_chars: 0,
    };
    const appel = (id: string, type: string, description: string): Ev => ({
      type: "tool_call",
      name: "task",
      call_id: id,
      args: { subagent_type: type, description, prompt: "p" },
    });
    for (const e of [appel("a", "web", "A"), appel("b", "explore", "B"), appel("c", "web", "C")])
      await api.handleStreamEvent(e);
    const lignes = (): NonNullable<MessageChat["taskRuns"]> => r.messages.value[1]?.taskRuns ?? [];
    const cancelTaskRun = api["cancelTaskRun"] as (run: unknown) => Promise<void>;
    await cancelTaskRun(lignes()[0]);
    for (const e of [
      etape("b", "k2", "explore", { status: "spawned", resumed: false, depth: 0 }),
      etape("c", "", "web", final("failed", bilanRefus)),
      etape("b", "k2", "explore", { status: "text", text: "lu" }),
      etape("b", "k2", "explore", { status: "parent", text: "Regarde b aussi." }),
      etape("a", "k1", "web", { status: "spawned", resumed: false, depth: 0 }),
      etape("b", "k2", "explore", final("completed", { ...bilanRefus, status: "done", reason: undefined })),
    ])
      await api.handleStreamEvent(e);
    const [web, explore, refuse] = lignes();
    expect([web?.label, web?.id, web?.state]).toEqual(["A", "k1", "running"]);
    expect([explore?.label, explore?.id, explore?.state]).toEqual(["B", "k2", "completed"]);
    expect(explore?.transcript).toEqual([{ text: "lu" }, { parent: "Regarde b aussi." }]);
    expect([refuse?.label, refuse?.id, refuse?.state, refuse?.harness?.status]).toEqual([
      "C",
      null,
      "failed",
      "unavailable",
    ]);
    expect(refuse?.harness?.status).toBe("unavailable");
    expect(web?.startedAt).toBeUndefined();
    await api.handleStreamEvent(
      etape("a", "k1", "web", {
        status: "tick",
        started: true,
        tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      }),
    );
    expect(typeof lignes()[0]?.startedAt).toBe("number");
    await vi.advanceTimersByTimeAsync(10);
    expect(annulations).toEqual([{ child_id: "k1" }]);
    scope.stop();
  });

  it("Stop pendant les outils sans texte : la bulle garde le marqueur du serveur, les sous-agents sont annulés", async () => {
    const annulations: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) =>
      reponseNdjson(
        [
          { type: "tool_call", name: "task", call_id: "t", args: { subagent_type: "x" } },
          { type: "task_step", child_id: "k", call_id: "t", status: "spawned" },
        ],
        init.signal,
        true,
      ),
    );
    const c = ctx();
    c.fetchAuth = async (u: string, init?: RequestInit) => {
      if (u === "/api/chat/cancel") annulations.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 404 });
    };
    const r = refs([{ role: "user", content: "Q" }]);
    const { api, scope } = monter(r, c);
    r.inputMessage.value = "Agis";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await vi.advanceTimersByTimeAsync(300);
    api.stopGeneration();
    await jusqua(() => fini);
    const bulle = r.messages.value[r.messages.value.length - 1];
    expect(bulle).toMatchObject({
      content: "_(génération interrompue)_",
      isStreaming: false,
      isTruncated: true,
    });
    expect(bulle?.taskRuns?.[0]?.state).toBe("cancelled");
    expect(annulations).toEqual([{ chat_id: "c1" }]);
    expect(r.isStreaming.value).toBe(false);
    scope.stop();
  });

  it("Stop pendant une commande : l'étape est arrêtée à la durée atteinte, « tour n/max » retiré", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { body: string; signal: AbortSignal }) =>
      reponseNdjson(
        [
          { type: "iteration", n: 6, max: 25, tokens_used: 0, context_tokens: 0 },
          { type: "tool_call", name: "execute_shell", call_id: "s", args: { command: "npm test" } },
        ],
        init.signal,
        true,
      ),
    );
    const r = refs([{ role: "user", content: "Q" }]);
    const { api, scope } = monter(r);
    r.inputMessage.value = "Teste";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(18_000);
    api.stopGeneration();
    await jusqua(() => fini);
    const bulle = r.messages.value[r.messages.value.length - 1];
    expect(bulle?.toolSteps?.[0]?.status).toBe("stopped");
    expect(bulle?.toolSteps?.[0]?.durationMs).toBeGreaterThanOrEqual(18_000);
    expect(bulle?.iterBudget ?? null).toBeNull();
    scope.stop();
  });

  it("erreur pendant une commande : l'étape et le sous-agent en cours sont clos", async () => {
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    await api.handleStreamEvent({ type: "tool_call", name: "execute_shell", call_id: "s", args: {} });
    await api.handleStreamEvent({
      type: "tool_call",
      name: "task",
      call_id: "t",
      args: { subagent_type: "x" },
    });
    await api.handleStreamEvent({
      type: "error",
      text: "Serveur injoignable",
      detail: "ECONNREFUSED",
      kind: "unreachable",
    });
    const bulle = r.messages.value[1];
    expect(bulle?.toolSteps?.map((s) => s.status)).toEqual(["stopped", "stopped"]);
    expect(bulle?.taskRuns?.[0]?.state).toBe("cancelled");
    scope.stop();
  });

  it("direct : la réflexion d'une étape garde sa durée ; tool_meta du final gardé sur le message", async () => {
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    await api.handleStreamEvent({ type: "thinking_token", text: "je lis la config" });
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(3000);
    await api.handleStreamEvent({ type: "tool_call", name: "read_file", call_id: "a", args: { path: "p" } });
    const etape = r.messages.value[1]?.toolSteps?.[0];
    expect(etape?.thinking).toBe("je lis la config");
    expect(etape?.thinkingMs).toBeGreaterThanOrEqual(3000);
    expect(r.messages.value[1]?._thinkingStartedAt).toBeUndefined();
    const meta = { steps: { a: { ms: 5, think: "je lis la config", think_ms: 3000 } } };
    await api.handleStreamEvent({
      type: "tool_result",
      name: "read_file",
      call_id: "a",
      result: "{}",
      duration_ms: 5,
    });
    await api.handleStreamEvent({
      type: "final",
      assistant: "Ok",
      chat_id: "c1",
      run_ids: [],
      metrics: null,
      persisted: true,
      tool_meta: meta,
    });
    expect(r.messages.value[1]?.tool_meta).toEqual(meta);
    scope.stop();
  });

  it("direct : chaque appel garde sa réflexion à sa place, avant son texte, même quand il commence par un outil hors liste", async () => {
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    const evts: Record<string, unknown>[] = [
      { type: "thinking_token", text: "je planifie" },
      { type: "content_token", text: "Je prépare le plan." },
      { type: "tool_call", name: "todowrite", call_id: "t1", args: { todos: [] } },
      { type: "tool_result", name: "todowrite", call_id: "t1", result: "{}", duration_ms: 5 },
      { type: "tool_call", name: "chart_bar", call_id: "g", args: { title: "Budget" } },
      { type: "tool_result", name: "chart_bar", call_id: "g", result: "{}", duration_ms: 5 },
      { type: "thinking_token", text: "je coche" },
      { type: "content_token", text: "Tâches cochées." },
      { type: "tool_call", name: "todowrite", call_id: "t2", args: { todos: [] } },
      { type: "tool_result", name: "todowrite", call_id: "t2", result: "{}", duration_ms: 5 },
      { type: "thinking_token", text: "je conclus" },
    ];
    for (const e of evts) {
      await api.handleStreamEvent(e as never);
      await vi.advanceTimersByTimeAsync(1000);
    }
    const m = r.messages.value[1] as MessageChat;
    const cles = (b: BlocFil): string =>
      b.k === "reflexion" ? "R:" + b.texte : b.k === "texte" ? "T:" + b.texte : b.k;
    expect(chronologieTour(m).map(cles)).toEqual([
      "R:je planifie",
      "T:Je prépare le plan.",
      "etapes",
      "R:je coche",
      "T:Tâches cochées.",
      "R:je conclus",
    ]);
    const fin = chronologieTour(m).at(-1);
    expect(fin).toMatchObject({ k: "reflexion", vivante: true });
    expect(m.toolSteps?.[2]?.thinkingMs).toBeLessThan(3000);
    scope.stop();
  });

  it("rechargement = direct : la même liste chronologique (textes, réflexions, étapes, statuts, durées)", async () => {
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    const meta = {
      steps: {
        a: { ms: 120, think: "je lis la config", think_ms: 3000 },
        c: { state: "stopped" as const, ms: 900 },
      },
    };
    for (const e of [
      { type: "thinking_token", text: "je lis la config" },
      { type: "content_token", text: "Je lis." },
      { type: "tool_call", name: "read_file", call_id: "a", args: { path: "p.json" } },
      { type: "tool_result", name: "read_file", call_id: "a", result: "{}", duration_ms: 120 },
      { type: "tool_call", name: "execute_shell", call_id: "c", args: { command: "npm test" } },
    ])
      await api.handleStreamEvent(e);
    await vi.advanceTimersByTimeAsync(900);
    api.stopGeneration();
    const direct = r.messages.value[1] as MessageChat;
    const [recharge] = construireMessages(
      [
        {
          role: "assistant",
          content: direct.content,
          thinking: "je lis la config",
          tool_history: [
            {
              role: "assistant",
              content: "Je lis.",
              tool_calls: [{ id: "a", function: { name: "read_file", arguments: '{"path":"p.json"}' } }],
            },
            { role: "tool", tool_call_id: "a", content: "{}" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "c", function: { name: "execute_shell", arguments: '{"command":"npm test"}' } },
              ],
            },
            { role: "tool", tool_call_id: "c", content: '{"error": "interrompu par l\'utilisateur"}' },
          ],
          tool_history_delta: true,
          tool_meta: meta,
          isTruncated: true,
        },
      ],
      (c) => ({ files: undefined, displayContent: c }),
    ) as MessageChat[];
    const forme = (blocs: BlocFil[]): unknown[] =>
      blocs.map((b) =>
        b.k === "etapes"
          ? [b.cle, b.etapes.map((e) => [e.numero, e.etape.name, e.etape.status, e.etape.durationMs])]
          : b.k === "texte" || b.k === "reflexion"
            ? [b.cle, b.texte.trim()]
            : [b.cle],
      );
    expect(forme(chronologieTour(recharge as MessageChat))).toEqual(forme(chronologieTour(direct)));
    expect(forme(chronologieTour(direct))).toEqual([
      ["r:0", "je lis la config"],
      ["t:0", "Je lis."],
      [
        "e:0",
        [
          [1, "read_file", "done", 120],
          [2, "execute_shell", "stopped", 900],
        ],
      ],
    ]);
    scope.stop();
  });

  it("409 « génération en cours » : message clair, aucune nouvelle tentative, suivi du run (bulle et Stop offert)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      return new Response(JSON.stringify({ detail: "generation_running" }), { status: 409 });
    });
    const toasts: string[] = [];
    const r = refs([{ role: "user", content: "Q" }]);
    const { api, scope } = monter(r, ctx(toasts));
    r.inputMessage.value = "Encore";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await jusqua(() => fini);
    expect(n).toBe(1);
    expect(toasts.some((t) => t.includes("déjà en cours"))).toBe(true);
    expect(r.isStreaming.value).toBe(true);
    expect((api["statusText"] as Vue.Ref<string>).value).toBe("Génération en arrière-plan…");
    scope.stop();
  });
});

describe("progression et journaux d'un outil", () => {
  const progression = (e: Ev): Ev => ({
    type: "tool_progress",
    name: "read_file",
    progress: 1,
    total: 2,
    message: "",
    ...e,
  });
  const ligne = (e: Ev): Ev => ({ type: "tool_log", name: "read_file", level: "info", logger: "", ...e });
  const resultat = (id: string): Ev => ({
    type: "tool_result",
    name: "read_file",
    call_id: id,
    result: "{}",
    duration_ms: 1,
  });

  async function deuxLectures() {
    const r = refs([
      { role: "user", content: "Q" },
      { role: "assistant", content: "", isStreaming: true },
    ]);
    r.isStreaming.value = true;
    const { api, scope } = monter(r);
    for (const id of ["a", "b"])
      await api.handleStreamEvent({ type: "tool_call", name: "read_file", call_id: id, args: { path: id } });
    const vues = () =>
      (r.messages.value[1]?.toolSteps ?? []).map((s) => [
        s.callId,
        s.status,
        s.progressInfo?.message ?? null,
        (s.logs ?? []).map((j) => j.message),
      ]);
    return { api, scope, vues };
  }

  it("deux read_file en parallèle : rattachés par call_id, ceux de A fini ne passent jamais sous B", async () => {
    const { api, scope, vues } = await deuxLectures();
    await api.handleStreamEvent(progression({ call_id: "a", message: "pa" }));
    await api.handleStreamEvent(ligne({ call_id: "a", message: "ja" }));
    await api.handleStreamEvent(resultat("a"));
    await api.handleStreamEvent(progression({ call_id: "a", message: "tardive" }));
    await api.handleStreamEvent(ligne({ call_id: "a", message: "tardif" }));
    expect(vues()).toEqual([
      ["a", "done", "pa", ["ja"]],
      ["b", "running", null, []],
    ]);
    scope.stop();
  });

  it("sans call_id : repli sur le dernier appel en cours du même nom", async () => {
    const { api, scope, vues } = await deuxLectures();
    await api.handleStreamEvent(progression({ message: "p1" }));
    await api.handleStreamEvent(ligne({ message: "j1" }));
    await api.handleStreamEvent(resultat("b"));
    await api.handleStreamEvent(progression({ message: "p2" }));
    await api.handleStreamEvent(ligne({ message: "j2" }));
    expect(vues()).toEqual([
      ["a", "running", "p2", ["j2"]],
      ["b", "done", "p1", ["j1"]],
    ]);
    scope.stop();
  });
});

// Flux NDJSON piloté par le test : chaque événement part à la demande.
function fluxPilote(): {
  reponse: (signal: AbortSignal) => Response;
  envoyer: (e: Ev) => void;
  fermer: () => void;
} {
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  return {
    reponse: (signal) => {
      signal.addEventListener("abort", () => ctl?.error(new DOMException("Aborted", "AbortError")));
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) }), { status: 200 });
    },
    envoyer: (e) => ctl?.enqueue(new TextEncoder().encode(JSON.stringify(e) + "\n")),
    fermer: () => ctl?.close(),
  };
}

describe("jauge de contexte", () => {
  it("occupation réelle au-delà de la fenêtre : jauge en direct, instantané du message et contexte restauré", async () => {
    const flux = fluxPilote();
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) => flux.reponse(init.signal));
    const r = refs();
    const { api, scope } = monter(r);
    const sante = api["llmHealth"] as Vue.Ref<unknown>;
    const direct = api["liveGen"] as Vue.Ref<{ ctxLabel: string; pct: number } | null>;
    sante.value = {
      status: "ok",
      server_reachable: true,
      props: { n_ctx: 1000 },
      kv_cache: { used: 0, total: 0, pct: 0 },
    };
    r.inputMessage.value = "Q";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await vi.advanceTimersByTimeAsync(50);
    flux.envoyer({ type: "kv_cache", used: 1500, total: 1000, pct: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(direct.value).toMatchObject({ ctxLabel: `${fmtTokens(1500)} / ${fmtTokens(1000)}`, pct: 100 });
    flux.envoyer({ type: "final", assistant: "R", chat_id: "c1", run_ids: [], metrics: {}, persisted: true });
    flux.fermer();
    await jusqua(() => fini);
    expect(r.messages.value[1]?.metrics).toMatchObject({ kv_cache: { used: 1500, total: 1000, pct: 100 } });
    (api["applyChatCtxUsage"] as (u: unknown, id: unknown) => void)(
      { used: 1500, total: 1000, pct: 100 },
      "c1",
    );
    await Vue.nextTick();
    expect((api["ctxUsage"] as Vue.Ref<unknown>).value).toEqual({
      used: 1500,
      total: 1000,
      pct: 100,
      persisted: true,
    });
    scope.stop();
  });

  it("préremplissage : la jauge garde la taille renvoyée par le moteur, sans suivre l'entrée lue", async () => {
    const flux = fluxPilote();
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) => flux.reponse(init.signal));
    const r = refs();
    const { api, scope } = monter(r);
    const direct = api["liveGen"] as Vue.Ref<{ pct: number; part: number } | null>;
    (api["llmHealth"] as Vue.Ref<unknown>).value = {
      status: "ok",
      server_reachable: true,
      props: { n_ctx: 10000 },
      kv_cache: { used: 0, total: 0, pct: 0 },
    };
    r.inputMessage.value = "Q";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await vi.advanceTimersByTimeAsync(50);
    const parts: number[] = [];
    for (const lu of [500, 2000, 4000]) {
      flux.envoyer({ type: "prompt_progress", total: 4000, processed: lu, cache: 0, time_ms: 100, iter: 0 });
      await vi.advanceTimersByTimeAsync(250);
      parts.push(direct.value?.part ?? -1);
    }
    expect(parts).toEqual([0, 0, 0]);
    flux.envoyer({ type: "kv_cache", used: 4000, total: 10000, pct: 40 });
    await vi.advanceTimersByTimeAsync(250);
    expect(direct.value).toMatchObject({ pct: 40, part: 0.4 });
    flux.envoyer({ type: "final", assistant: "R", chat_id: "c1", run_ids: [], metrics: {}, persisted: true });
    flux.fermer();
    await jusqua(() => fini);
    scope.stop();
  });

  it("part en génération : ajoutée au dernier prompt mesuré, gardée pour l'appel que kv_cache mesure", async () => {
    const flux = fluxPilote();
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) => flux.reponse(init.signal));
    const r = refs();
    const { api, scope } = monter(r);
    const direct = api["liveGen"] as Vue.Ref<{ ctxLabel: string; pct: number } | null>;
    (api["llmHealth"] as Vue.Ref<unknown>).value = {
      status: "ok",
      server_reachable: true,
      props: { n_ctx: 262144 },
      kv_cache: { used: 0, total: 0, pct: 0 },
    };
    r.inputMessage.value = "Q";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await vi.advanceTimersByTimeAsync(50);
    const apres = async (e: Ev): Promise<unknown> => {
      flux.envoyer(e);
      await vi.advanceTimersByTimeAsync(250);
      return direct.value;
    };
    expect(await apres({ type: "kv_cache", used: 131072, total: 262144, pct: 50 })).toMatchObject({
      ctxLabel: `${fmtTokens(131072)} / ${fmtTokens(262144)}`,
      pct: 50,
    });
    expect(await apres({ type: "thinking_token", text: "…", n: 49000 })).toMatchObject({
      ctxLabel: `${fmtTokens(131072)} + ${fmtTokens(49000)} / ${fmtTokens(262144)}`,
      pct: 69,
    });
    expect(await apres({ type: "kv_cache", used: 131500, total: 262144, pct: 50 })).toMatchObject({
      ctxLabel: `${fmtTokens(131500)} + ${fmtTokens(49000)} / ${fmtTokens(262144)}`,
      pct: 69,
    });
    expect(await apres({ type: "content_token", text: "x", n: 1000 })).toMatchObject({
      ctxLabel: `${fmtTokens(131500)} + ${fmtTokens(50000)} / ${fmtTokens(262144)}`,
    });
    expect(await apres({ type: "kv_cache", used: 182000, total: 262144, pct: 69 })).toMatchObject({
      ctxLabel: `${fmtTokens(182000)} + ${fmtTokens(1000)} / ${fmtTokens(262144)}`,
      pct: 70,
    });
    flux.envoyer({ type: "final", assistant: "x", chat_id: "c1", run_ids: [], metrics: {}, persisted: true });
    flux.fermer();
    await jusqua(() => fini);
    scope.stop();
  });

  it("capacité du cache KV : fenêtre pour llama.cpp seulement (pool partagé chez vLLM et SGLang)", async () => {
    let type = "vllm";
    const c = ctx();
    c.fetchAuth = (async (u: string) =>
      u === "/api/llm/models"
        ? new Response(
            JSON.stringify({
              moteur: { type },
              models: ["m"],
              kv_cache: { used: 800, total: 1600 },
              props: {},
            }),
            { status: 200 },
          )
        : new Response("{}", { status: 404 })) as CtxChat["fetchAuth"];
    const flux = fluxPilote();
    vi.stubGlobal("fetch", async (_u: string, init: { signal: AbortSignal }) => flux.reponse(init.signal));
    const r = refs();
    const { api, scope } = monter(r, c);
    const sante = api["llmHealth"] as Vue.Ref<{ kvEstFenetre?: boolean } | null>;
    const charger = api["loadAvailableModels"] as () => Promise<void>;
    const vus: Record<string, boolean | undefined> = {};
    for (type of ["sglang", "llamacpp", "vllm"]) {
      await charger();
      vus[type] = sante.value?.kvEstFenetre;
    }
    expect(vus).toEqual({ sglang: false, llamacpp: true, vllm: false });
    r.inputMessage.value = "Q";
    let fini = false;
    void api.sendMessage().then(() => (fini = true));
    await vi.advanceTimersByTimeAsync(250);
    expect((api["liveGen"] as Vue.Ref<{ ctxLabel: string } | null>).value?.ctxLabel).toBe("");
    flux.envoyer({ type: "final", assistant: "x", chat_id: "c1", run_ids: [], metrics: {}, persisted: true });
    flux.fermer();
    await jusqua(() => fini);
    scope.stop();
  });
});

describe("goldens du flux rejoués par la vue", () => {
  const fichiers = import.meta.glob<Record<string, unknown>>(["../../../../tests/goldens/flux_*.json"], {
    eager: true,
    import: "default",
  });
  for (const [f, g] of Object.entries(fichiers)) {
    const evs = ((g["evenements"] ?? g["flux"] ?? []) as Ev[]).map((e): Ev => {
      const { cles: _c, ahead: _a, ok: _o, id, mode: _m, ...reste } = e;
      return {
        ...reste,
        ...(e["type"] === "tool_call" || e["type"] === "tool_result" ? { call_id: id ?? "" } : {}),
      };
    });
    const final = evs.find((e) => e["type"] === "final");
    if (!final) continue;
    it(f.replace(/^.*\//, ""), async () => {
      const r = refs([
        { role: "user", content: "Q" },
        { role: "assistant", content: "", isStreaming: true },
      ]);
      r.isStreaming.value = true;
      const { api, scope } = monter(r);
      for (const e of evs) await api.handleStreamEvent(e);
      await vi.advanceTimersByTimeAsync(2000);
      const bulle = r.messages.value[1];
      expect(bulle?.isStreaming).toBe(false);
      expect(r.isStreaming.value).toBe(false);
      const attendu = final["assistant"];
      if (typeof attendu === "string" && attendu) expect(bulle?.content).toBe(attendu);
      scope.stop();
    });
  }
});
