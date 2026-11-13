// SPDX-License-Identifier: MIT
/** frontend/test/chat/historique/historique.test.ts — historique : reconstruction d'une conversation (system, réflexion, multimodal, outils, compactions, gel), jetons de chargement et de session, suppression, actions groupées ; recherche différée. */
import * as Vue from "vue";
import { ref } from "vue";
import type { Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerHistoriqueChat } from "../../../src/features/chat/historique/historique";
import type {
  DepsHistorique,
  Message,
  RefsHistorique,
  ResumeChat,
} from "../../../src/features/chat/historique/historique";
import {
  chatEnOuverture,
  DELAI_PRECHARGE_MS,
  GARDEES_CARACTERES_MAX,
  GARDEES_MAX,
  conversationGardee,
  garderConversation,
  oublierConversation,
  oublierPrecharge,
  precharger,
} from "../../../src/features/chat/historique/ouverture";
import {
  creerRechercheChat,
  DELAI_RECHERCHE_MS,
  DELAI_SURLIGNAGE_MS,
  fusionnerResultats,
  titreCorrespond,
} from "../../../src/features/chat/historique/recherche";

afterEach(() => {
  vi.useRealTimers();
  chatEnOuverture.value = null;
  oublierPrecharge();
  oublierConversation();
});

const json = (corps: unknown, statut = 200): Response =>
  new Response(JSON.stringify(corps), { status: statut, headers: { "content-type": "application/json" } });

interface Options {
  courant?: string | null;
  fetch?: (url: string, init?: Record<string, unknown>) => Promise<Response | null>;
  deps?: Partial<DepsHistorique>;
  session?: { generation: number };
  confirmer?: boolean;
}

function monter(payload: unknown, o: Options = {}) {
  const journal: string[] = [];
  const toasts: {
    message: string;
    options?: { onAction?: () => void; onExpire?: () => void | Promise<void> };
  }[] = [];
  const confirmations: unknown[][] = [];
  const refs = {
    messages: ref<readonly Message[]>([]),
    currentChatId: ref<string | null>(o.courant ?? null),
    currentChatTitle: ref(""),
    currentView: ref("accueil"),
    isStreaming: ref(false),
    isUserScrolling: ref(false),
    chats: ref<ResumeChat[]>([
      { id: "c1", title: "A" },
      { id: "c2", title: "B" },
    ]),
    inputRef: ref<HTMLTextAreaElement | null>(null),
    attachedFiles: ref<unknown[]>([]),
    user: ref<unknown>({ id: 1 }),
  } satisfies RefsHistorique;
  const fetchAuth = async (url: string, init?: Record<string, unknown>): Promise<Response | null> => {
    journal.push(((init?.method as string) || "GET") + " " + url);
    if (o.fetch) return o.fetch(url, init);
    if (url.includes("generation-status")) return json({ generation_running: false });
    return json(payload);
  };
  const noop = (): void => {};
  const deps: DepsHistorique = {
    detachFromStream: () => journal.push("detach"),
    stopRunForChat: (id: string) => journal.push("stop " + id),
    _parseFileBlocks: (c: unknown) => ({ files: undefined, displayContent: c }),
    scrollToBottom: noop,
    _revokeAllWebShotBlobs: noop,
    _vsReset: noop,
    _vsInitTail: noop,
    loadAvailableModels: noop,
    ...o.deps,
  };
  const api = creerHistoriqueChat(
    Vue,
    refs,
    {
      fetchAuth,
      showToast: (message, _type, options) => toasts.push({ message, options }),
      openConfirm: (...args) => {
        confirmations.push(args);
        return Promise.resolve(o.confirmer !== false);
      },
      openPrompt: () => Promise.resolve(null),
      showSidebar: ref(true),
    },
    deps,
    o.session ?? null,
  );
  return { api, refs, journal, toasts, confirmations };
}

const conv = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "chat-1",
  title: "Essai",
  messages,
  ...extra,
});

async function charger(messages: unknown[], extra: Record<string, unknown> = {}): Promise<Message[]> {
  const { api, refs } = monter(conv(messages, extra));
  await api.loadChat("chat-1");
  return [...refs.messages.value];
}

describe("historique : reconstruction d'une conversation", () => {
  it("aucun message system, entrées nulles écartées, payload sans messages accepté", async () => {
    const m = await charger([
      { role: "system", content: "x" },
      null,
      { role: "user", content: "bonjour" },
      { role: "system", content: "y" },
      { role: "assistant", content: "salut" },
    ]);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant"]);
    const { api, refs } = monter({ id: "chat-1", title: "Neuf" });
    await api.loadChat("chat-1");
    expect(refs.messages.value).toEqual([]);
    expect(refs.currentChatId.value).toBe("chat-1");
  });

  it("chaque assistant garde sa réflexion ; chaîne vide sinon", async () => {
    const m = await charger([
      { role: "assistant", content: "a1", thinking: "vieille" },
      { role: "user", content: "u", thinking: "jamais" },
      { role: "assistant", content: "a2", thinking: "récente" },
      { role: "user", content: "après" },
    ]);
    expect(m[0]?.thinking).toBe("vieille");
    expect(m[1]?.thinking).toBe("");
    expect(m[2]?.thinking).toBe("récente");
    expect((await charger([{ role: "assistant", content: "a" }]))[0]?.thinking).toBe("");
  });

  it("tour coupé en pleine réflexion : message vide conservé, raisonnement réhydraté, thinking présent prioritaire", async () => {
    const m = await charger([
      { role: "user", content: "fais" },
      { role: "assistant", content: "", thinkingTruncated: true, resume_thinking: "j'en étais là" },
    ]);
    expect(m).toHaveLength(2);
    expect(m[1]).toMatchObject({
      thinking: "j'en étais là",
      resume_thinking: "j'en étais là",
      thinkingTruncated: true,
    });
    const v = await charger([
      {
        role: "assistant",
        content: "x",
        thinking: "le vrai",
        thinkingTruncated: true,
        resume_thinking: "repli",
      },
    ]);
    expect(v[0]?.thinking).toBe("le vrai");
    expect(
      (await charger([{ role: "assistant", content: "x", thinkingTruncated: true }]))[0]?.thinkingTruncated,
    ).toBe(undefined);
  });

  it("contenu multimodal : texte et images dans l'ordre, parties malformées ignorées, images déjà présentes gardées", async () => {
    const m = await charger([
      {
        role: "user",
        content: [
          { type: "image_url" },
          { type: "image_url", image_url: {} },
          { type: "image_url", image_url: { url: "u1" } },
          { type: "image_url", image_url: { url: "u2" } },
          { type: "text", text: "regarde" },
        ],
      },
      { role: "user", content: [{ type: "image_url", image_url: { url: "u3" } }] },
      {
        role: "user",
        images: [{ dataUrl: "deja" }],
        content: [{ type: "image_url", image_url: { url: "x" } }],
      },
    ]);
    expect(m[0]).toMatchObject({ content: "regarde", images: [{ dataUrl: "u1" }, { dataUrl: "u2" }] });
    expect(m[1]?.content).toBe("");
    expect(m[2]?.images).toEqual([{ dataUrl: "deja" }]);
  });

  it("tool_history : delta réhydraté, chaînage entre tours, historique vide sans étapes, marqueurs de troncature", async () => {
    const tour1 = [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"cmd":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ];
    const tour2 = tour1.concat([
      {
        role: "assistant",
        tool_calls: [{ id: "c2", function: { name: "shell", arguments: '{"cmd":"pwd"}' } }],
      },
      { role: "tool", tool_call_id: "c2", content: "/work" },
    ]);
    const m = await charger([
      { role: "assistant", content: "un", tool_history: tour1, tool_history_delta: true },
      { role: "user", content: "encore" },
      { role: "assistant", content: "deux", tool_history: tour2 },
      { role: "assistant", content: "x", tool_history: [] },
      {
        role: "assistant",
        content: "y",
        isTruncated: true,
        toolLoopTruncated: true,
        toolLoopStats: { rounds: 12 },
        errorMessage: "plafond",
      },
    ]);
    expect(m[0]?.tool_history_delta).toBe(true);
    expect((m[0]?.toolSteps as unknown[]).length).toBe(1);
    expect((m[2]?.toolSteps as unknown[]).length).toBe(1);
    expect(m[3]?.toolSteps).toBeUndefined();
    expect(m[4]).toMatchObject({
      isTruncated: true,
      toolLoopTruncated: true,
      toolLoopStats: { rounds: 12 },
      errorMessage: "plafond",
    });
  });

  it("sous-agents : contexte à part de la consommation enregistrée, champs d'origine conservés", async () => {
    const m = await charger([
      {
        role: "assistant",
        content: "x",
        task_runs: [
          {
            agent: "a",
            context_tokens: 5000,
            input_tokens: 100,
            output_tokens: 50,
            cache_tokens: 80,
            result: "ok",
          },
          { agent: "b", input_tokens: 100, output_tokens: 50 },
          { agent: "c", context_tokens: 0, input_tokens: 7, output_tokens: 3 },
          { agent: "d" },
        ],
      },
    ]);
    const runs = m[0]?.taskRuns as { tokens?: number; agent: string; result?: string }[];
    expect(runs.map((r) => r.tokens)).toEqual([5000, undefined, undefined, undefined]);
    expect(runs[0]).toMatchObject({
      agent: "a",
      result: "ok",
      input_tokens: 100,
      output_tokens: 50,
      cache_tokens: 80,
    });
    expect(runs[1]).toMatchObject({ input_tokens: 100, output_tokens: 50 });
  });

  it("sous-agents : bloc du harnais persisté validé, bloc illisible retiré, ancien run sans bloc", async () => {
    const harness = {
      status: "done",
      tool_calls: 3,
      tool_calls_total: 3,
      iterations: 3,
      resumed: false,
      duration_s: 4,
      files_changed: [{ path: "a.ts", change: "modified" }],
      git: { commits: ["abc"] },
      errors: 0,
      read_only: false,
      report_chars: 20,
    };
    const m = await charger([
      {
        role: "assistant",
        content: "x",
        task_runs: [{ agent: "a", harness }, { agent: "b", harness: { status: "done" } }, { agent: "c" }],
      },
    ]);
    const runs = m[0]?.taskRuns as { agent: string; harness?: unknown }[];
    expect(runs[0]?.harness).toEqual(harness);
    expect(runs[1]).toMatchObject({ agent: "b" });
    expect("harness" in (runs[1] ?? {})).toBe(false);
    expect("harness" in (runs[2] ?? {})).toBe(false);
  });

  it("notices de compaction, compactions du tour replacées après leur round, aucune inventée", async () => {
    const th = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "a" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c2", content: "b" },
    ];
    const m = await charger([
      { role: "notice", content: "", ts: 1700000000, tokens_after: 4096, summary: "résumé" },
      {
        role: "assistant",
        content: "fin",
        tool_history: th,
        tool_history_delta: true,
        pruned: 3,
        compactions: [
          { round: 1, reason: "threshold", threshold: 6000, tokens_before: 8000, tokens_after: 2000 },
        ],
      },
      { role: "assistant", content: "x", compactions: [] },
    ]);
    expect(m[0]).toMatchObject({ kind: "compaction", ts: 1700000000, tokens_after: 4096, summary: "résumé" });
    const etapes = m[1]?.toolSteps as Message[];
    expect(
      etapes.map((s) => (s._kind === "compression" ? "compression" : `${String(s.name)}#${String(s.round)}`)),
    ).toEqual(["read_file#0", "compression", "read_file#1"]);
    const comp = etapes[1] as {
      status: string;
      reason: string;
      threshold: number;
      seg: number;
      stats: { ratio: number };
    };
    expect(comp).toMatchObject({ status: "done", reason: "threshold", threshold: 6000, seg: etapes[0]?.seg });
    expect(comp.stats.ratio).toBe(0.25);
    expect(m[1]?.pruned).toBe(3);
    expect(m[2]?.toolSteps).toBeUndefined();
  });

  it("tous les messages chargés sont gelés ; titre et vue posés ; fenêtre initialisée avant l'affectation", async () => {
    let tailleInit = -1;
    let affecte = -1;
    const { api, refs } = monter(
      conv(
        [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
        { title: "Ma conv" },
      ),
      {
        deps: {
          _vsInitTail: (n: number) => {
            tailleInit = n;
            affecte = refs.messages.value.length;
          },
        },
      },
    );
    await api.loadChat("chat-1");
    expect(refs.messages.value.every((m) => Object.isFrozen(m))).toBe(true);
    expect([tailleInit, affecte]).toEqual([2, 0]);
    expect(refs.currentChatTitle.value).toBe("Ma conv");
    expect(refs.currentView.value).toBe("chat");
  });

  it("todos : liste soldée non re-semée, travail ouvert re-semé", async () => {
    let recu: unknown = null;
    const setTodoList = (l: readonly unknown[]) => {
      recu = l;
    };
    const a = monter(conv([], { todos: [{ status: "completed" }, { status: "cancelled" }] }), {
      deps: { setTodoList },
    });
    await a.api.loadChat("chat-1");
    expect(recu).toEqual([]);
    const todos = [{ status: "completed" }, { status: "pending" }];
    const b = monter(conv([], { todos }), { deps: { setTodoList } });
    await b.api.loadChat("chat-1");
    expect(recu).toEqual(todos);
  });
});

describe("historique : garde-fous de chargement", () => {
  it("seul le dernier chargement demandé écrit (réponse lente jetée)", async () => {
    let liberer: () => void = () => {};
    const attente = new Promise<void>((r) => {
      liberer = r;
    });
    const { api, refs } = monter(null, {
      fetch: async (url) => {
        if (url.includes("generation-status")) return json({});
        if (url.endsWith("/lent")) {
          await attente;
          return json(conv([{ role: "user", content: "LENT" }], { id: "lent" }));
        }
        return json(conv([{ role: "user", content: "RAPIDE" }], { id: "rapide" }));
      },
    });
    const premier = api.loadChat("lent");
    await api.loadChat("rapide");
    liberer();
    await premier;
    expect(refs.currentChatId.value).toBe("rapide");
    expect(refs.messages.value[0]?.content).toBe("RAPIDE");
  });

  it("une session changée pendant le chargement (déconnexion) n'écrit rien", async () => {
    const session = { generation: 3 };
    const { api, refs } = monter(null, {
      session,
      fetch: (url) => {
        if (url.includes("generation-status")) return Promise.resolve(json({}));
        session.generation = 4;
        return Promise.resolve(json(conv([{ role: "user", content: "fuite" }])));
      },
    });
    await api.loadChat("chat-1");
    expect(refs.currentChatId.value).toBeNull();
    expect(refs.messages.value).toEqual([]);
  });

  it("conversation courante : aucun aller-retour sans force, relue avec force, puis rattachement au run en cours", async () => {
    const attach = vi.fn();
    const a = monter(conv([{ role: "user", content: "a" }]), { courant: "chat-1" });
    await a.api.loadChat("chat-1");
    expect(a.journal).toEqual([]);
    const b = monter(null, {
      courant: "chat-1",
      deps: { attachRun: attach },
      fetch: (url) =>
        Promise.resolve(
          url.includes("generation-status")
            ? json({ generation_running: true, resumable: true, run_id: "r1" })
            : json(conv([{ role: "user", content: "a" }])),
        ),
    });
    await b.api.loadChat("chat-1", { force: true });
    await vi.waitFor(() =>
      expect(attach).toHaveBeenCalledWith("chat-1", expect.objectContaining({ run_id: "r1" })),
    );
    expect(b.journal).toContain("GET /api/saved/chats/chat-1");
    expect(b.journal.indexOf("detach")).toBeLessThan(b.journal.indexOf("GET /api/saved/chats/chat-1"));
  });

  it("questionnaire : gardé à la relecture de la même conversation, réinitialisé vers une autre", async () => {
    const reset = vi.fn();
    const a = monter(conv([{ role: "user", content: "a" }]), {
      courant: "chat-1",
      deps: { resetAskUser: reset },
    });
    await a.api.loadChat("chat-1", { force: true });
    expect(reset).not.toHaveBeenCalled();
    await a.api.loadChat("chat-2");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("une réponse en échec garde les messages affichés et prévient", async () => {
    const { api, refs, toasts } = monter(null, { fetch: () => Promise.resolve(json({}, 500)) });
    refs.messages.value = [Object.freeze({ role: "user", content: "déjà là" })];
    await api.loadChat("autre");
    expect(refs.messages.value[0]?.content).toBe("déjà là");
    expect(toasts[0]?.message).toContain("erreur 500");
  });

  it("nouveau chat : vide la conversation, invalide un chargement en vol, purge l'instantané de session", async () => {
    let liberer: () => void = () => {};
    const attente = new Promise<void>((r) => {
      liberer = r;
    });
    const purge = vi.fn();
    const { api, refs } = monter(null, {
      fetch: async () => {
        await attente;
        return json(conv([{ role: "user", content: "tard" }]));
      },
    });
    const enVol = api.loadChat("chat-1");
    const historique = creerHistoriqueChat(
      Vue,
      refs,
      {
        fetchAuth: () => Promise.resolve(null),
        showToast: () => {},
        openConfirm: () => Promise.resolve(true),
        openPrompt: () => Promise.resolve(null),
        showSidebar: ref(true),
        clearSavedSession: purge,
      },
      {
        detachFromStream: () => {},
        _parseFileBlocks: () => ({}),
        scrollToBottom: () => {},
        _revokeAllWebShotBlobs: () => {},
        _vsReset: () => {},
        _vsInitTail: () => {},
        loadAvailableModels: () => {},
      },
    );
    await historique.startNewChat();
    await api.startNewChat();
    liberer();
    await enVol;
    expect(refs.messages.value).toEqual([]);
    expect(refs.currentChatId.value).toBeNull();
    expect(purge).toHaveBeenCalledOnce();
  });
});

describe("historique : ouverture d'une autre conversation", () => {
  const attendre = () => {
    let liberer: () => void = () => {};
    const attente = new Promise<void>((r) => {
      liberer = r;
    });
    return { attente, liberer };
  };
  const ancien = Object.freeze({ role: "user", content: "ancien fil" });

  it("la ligne est marquée aussitôt, le chat affiché ne change qu'à la réponse, le marqueur tombe ensuite", async () => {
    const { attente, liberer } = attendre();
    const { api, refs } = monter(null, {
      courant: "ancien",
      fetch: async (url) => {
        if (url.includes("generation-status")) return json({});
        await attente;
        return json(conv([{ role: "user", content: "nouveau fil" }], { id: "nouveau" }));
      },
    });
    refs.messages.value = [ancien];
    const ouverture = api.loadChat("nouveau");
    expect(chatEnOuverture.value).toBe("nouveau");
    expect(refs.currentChatId.value).toBe("ancien");
    expect(refs.messages.value[0]?.content).toBe("ancien fil");
    liberer();
    await ouverture;
    expect(chatEnOuverture.value).toBeNull();
    expect(refs.currentChatId.value).toBe("nouveau");
    expect(refs.messages.value[0]?.content).toBe("nouveau fil");
  });

  it("le rendu (blobs, fenêtre, graphiques) n'est remis à zéro qu'à l'échange, avant la fenêtre du nouveau fil", async () => {
    const { attente, liberer } = attendre();
    const ordre: string[] = [];
    const { api, refs } = monter(null, {
      courant: "ancien",
      deps: {
        detachFromStream: () => ordre.push("detach"),
        _revokeAllWebShotBlobs: () => ordre.push("blobs"),
        _vsReset: () => ordre.push("reset"),
        _vsInitTail: () => ordre.push("fenetre"),
        clearChartInstances: () => ordre.push("graphiques"),
      },
      fetch: async (url) => {
        ordre.push(url.includes("generation-status") ? "statut" : "requete");
        if (url.includes("generation-status")) return json({});
        await attente;
        return json(conv([{ role: "user", content: "x" }], { id: "nouveau" }));
      },
    });
    refs.messages.value = [ancien];
    const ouverture = api.loadChat("nouveau");
    await Promise.resolve();
    expect(ordre).toEqual(["detach", "requete"]);
    liberer();
    await ouverture;
    expect(ordre.slice(0, 7)).toEqual([
      "detach",
      "requete",
      "detach",
      "blobs",
      "reset",
      "graphiques",
      "fenetre",
    ]);
  });

  it("réponse en échec ou chat disparu : le fil affiché reste en place, rien n'est remis à zéro, le marqueur tombe", async () => {
    for (const statut of [404, 500]) {
      const reset = vi.fn();
      const blobs = vi.fn();
      const { api, refs, toasts } = monter(null, {
        courant: "ancien",
        deps: { _vsReset: reset, _revokeAllWebShotBlobs: blobs },
        fetch: () => Promise.resolve(json({}, statut)),
      });
      refs.messages.value = [ancien];
      const ouverture = api.loadChat("autre");
      expect(chatEnOuverture.value).toBe("autre");
      await ouverture;
      expect(chatEnOuverture.value).toBeNull();
      expect(refs.currentChatId.value).toBe("ancien");
      expect(refs.messages.value[0]?.content).toBe("ancien fil");
      expect(reset).not.toHaveBeenCalled();
      expect(blobs).not.toHaveBeenCalled();
      expect(toasts).toHaveLength(1);
    }
  });

  it("deux ouvertures de suite : le marqueur suit la dernière, la réponse lente ne l'efface pas ni ne gagne", async () => {
    const { attente, liberer } = attendre();
    const { api, refs } = monter(null, {
      courant: "ancien",
      fetch: async (url) => {
        if (url.includes("generation-status")) return json({});
        if (url.endsWith("/lent")) {
          await attente;
          return json(conv([{ role: "user", content: "LENT" }], { id: "lent" }));
        }
        return json(conv([{ role: "user", content: "RAPIDE" }], { id: "rapide" }));
      },
    });
    const premier = api.loadChat("lent");
    const second = api.loadChat("rapide");
    expect(chatEnOuverture.value).toBe("rapide");
    await second;
    expect(chatEnOuverture.value).toBeNull();
    liberer();
    await premier;
    expect(refs.currentChatId.value).toBe("rapide");
    expect(refs.messages.value[0]?.content).toBe("RAPIDE");
  });

  it("retour sur le chat affiché pendant l'ouverture d'un autre : l'ouverture est abandonnée", async () => {
    const { attente, liberer } = attendre();
    const { api, refs } = monter(null, {
      courant: "ancien",
      fetch: async (url) => {
        if (url.includes("generation-status")) return json({});
        await attente;
        return json(conv([{ role: "user", content: "tard" }], { id: "autre" }));
      },
    });
    refs.messages.value = [ancien];
    const ouverture = api.loadChat("autre");
    await api.loadChat("ancien");
    expect(chatEnOuverture.value).toBeNull();
    liberer();
    await ouverture;
    expect(refs.currentChatId.value).toBe("ancien");
    expect(refs.messages.value[0]?.content).toBe("ancien fil");
  });

  it("nouveau chat pendant l'ouverture : le marqueur tombe et la réponse tardive n'écrit rien", async () => {
    const { attente, liberer } = attendre();
    const { api, refs } = monter(null, {
      courant: "ancien",
      fetch: async () => {
        await attente;
        return json(conv([{ role: "user", content: "tard" }], { id: "autre" }));
      },
    });
    const ouverture = api.loadChat("autre");
    await api.startNewChat();
    expect(chatEnOuverture.value).toBeNull();
    liberer();
    await ouverture;
    expect(refs.currentChatId.value).toBeNull();
    expect(refs.messages.value).toEqual([]);
  });

  it("relecture du chat affiché (force) : pas de marqueur, remise à zéro immédiate comme avant", async () => {
    const ordre: string[] = [];
    const { api, refs } = monter(conv([{ role: "user", content: "a" }]), {
      courant: "chat-1",
      deps: { _vsReset: () => ordre.push("reset") },
      fetch: async (url) => {
        ordre.push("requete");
        return json(url.includes("generation-status") ? {} : conv([{ role: "user", content: "a" }]));
      },
    });
    const relecture = api.loadChat("chat-1", { force: true });
    expect(chatEnOuverture.value).toBeNull();
    expect(ordre[0]).toBe("reset");
    await relecture;
    expect(refs.currentChatId.value).toBe("chat-1");
  });

  it("session changée pendant l'ouverture : rien n'est remis à zéro, le marqueur tombe", async () => {
    const session = { generation: 1 };
    const reset = vi.fn();
    const { api, refs } = monter(null, {
      session,
      courant: "ancien",
      deps: { _vsReset: reset },
      fetch: () => {
        session.generation = 2;
        return Promise.resolve(json(conv([{ role: "user", content: "fuite" }])));
      },
    });
    refs.messages.value = [ancien];
    await api.loadChat("autre");
    expect(chatEnOuverture.value).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(refs.messages.value[0]?.content).toBe("ancien fil");
  });
});

describe("historique : lecture lancée à l'appui", () => {
  it("le clic reprend la lecture de l'appui : une seule requête par ouverture", async () => {
    const { api, journal, refs } = monter(conv([{ role: "user", content: "x" }], { id: "c2" }), {
      courant: "c1",
    });
    const fetchAuth = async (url: string): Promise<Response> => {
      journal.push("GET " + url);
      return json(conv([{ role: "user", content: "x" }], { id: "c2" }));
    };
    precharger(fetchAuth, "c2", 0);
    await api.loadChat("c2");
    expect(journal.filter((j) => j === "GET /api/saved/chats/c2")).toHaveLength(1);
    expect(refs.currentChatId.value).toBe("c2");
  });

  it("la lecture n'est reprise qu'une fois, et seulement pour la même conversation", async () => {
    const { api, journal } = monter(conv([], { id: "c2" }), { courant: "c1" });
    const fetchAuth = async (url: string): Promise<Response> => {
      journal.push("préchargé " + url);
      return json(conv([], { id: "c2" }));
    };
    precharger(fetchAuth, "c3", 0);
    await api.loadChat("c2");
    expect(journal).toContain("GET /api/saved/chats/c2");
    await api.loadChat("c3", { force: true });
    expect(journal.filter((j) => j.startsWith("GET /api/saved/chats/c3"))).toHaveLength(0);
    await api.loadChat("c3", { force: true });
    expect(journal.filter((j) => j.startsWith("GET /api/saved/chats/c3"))).toHaveLength(1);
  });

  it("appui relâché ailleurs ou clic trop tardif : la lecture est jetée au bout de deux secondes", async () => {
    vi.useFakeTimers();
    const { api, journal } = monter(conv([], { id: "c2" }), { courant: "c1" });
    const corps = { cancel: vi.fn(() => Promise.resolve()) };
    const fetchAuth = (): Promise<Response> => Promise.resolve({ body: corps } as unknown as Response);
    precharger(fetchAuth, "c2", 0);
    await vi.advanceTimersByTimeAsync(DELAI_PRECHARGE_MS + 1);
    expect(corps.cancel).toHaveBeenCalledOnce();
    const ouverture = api.loadChat("c2");
    await vi.advanceTimersByTimeAsync(0);
    await ouverture;
    expect(journal).toContain("GET /api/saved/chats/c2");
  });

  it("session différente : la lecture d'une autre session n'est pas reprise", async () => {
    const { api, journal } = monter(conv([], { id: "c2" }), { courant: "c1", session: { generation: 5 } });
    precharger(async () => json(conv([{ role: "user", content: "autre compte" }], { id: "c2" })), "c2", 4);
    await api.loadChat("c2");
    expect(journal).toContain("GET /api/saved/chats/c2");
  });

  it("lecture en échec : l'échec est vu par le clic qui la reprend, pas par un rejet non traité", async () => {
    const { api, toasts } = monter(null, { courant: "c1" });
    precharger(() => Promise.reject(new Error("réseau")), "c2", 0);
    await api.loadChat("c2");
    expect(toasts[0]?.message).toContain("illisible");
  });
});

describe("historique : lectures gardées (retour sans attente)", () => {
  /** Serveur de test : contenu par conversation, réponses retenues à la demande. */
  function serveur(contenus: Record<string, unknown>) {
    const retenues: (() => void)[] = [];
    let retenir = false;
    const fetch = async (url: string): Promise<Response> => {
      if (url.includes("generation-status")) return json({});
      const id = url.split("/").pop() ?? "";
      if (retenir) await new Promise<void>((r) => retenues.push(r));
      const c = contenus[id];
      return c === undefined ? json({}, 404) : json(c);
    };
    return {
      fetch,
      retenir: (v: boolean) => (retenir = v),
      liberer: () => retenues.splice(0).forEach((r) => r()),
    };
  }
  const A = conv([{ role: "user", content: "fil A" }], { id: "c1", title: "A", updated_at: 10 });
  const B = conv([{ role: "user", content: "fil B" }], { id: "c2", title: "B", updated_at: 20 });

  async function ouvrirPuisQuitter(o: Options = {}) {
    const srv = serveur({ c1: A, c2: B });
    const fenetre = vi.fn();
    const modeles = vi.fn();
    const m = monter(null, {
      fetch: srv.fetch,
      ...o,
      deps: { _vsInitTail: fenetre, loadAvailableModels: modeles, ...o.deps },
    });
    m.refs.chats.value = [
      { id: "c1", title: "A", updated_at: 10 },
      { id: "c2", title: "B", updated_at: 20 },
    ];
    await m.api.loadChat("c1");
    await m.api.loadChat("c2");
    fenetre.mockClear();
    return { ...m, srv, fenetre, modeles };
  }

  it("retour sur la précédente : fil affiché avant la réponse, rien n'est reposé si elle est identique, aucune relecture des modèles", async () => {
    const { api, refs, srv, fenetre, modeles, journal } = await ouvrirPuisQuitter();
    srv.retenir(true);
    const retour = api.loadChat("c1");
    expect(refs.currentChatId.value).toBe("c1");
    expect(refs.currentChatTitle.value).toBe("A");
    expect(refs.messages.value[0]?.content).toBe("fil A");
    expect(chatEnOuverture.value).toBeNull();
    const affiches = refs.messages.value;
    srv.liberer();
    await retour;
    expect(refs.messages.value).toBe(affiches);
    expect(fenetre).toHaveBeenCalledTimes(1);
    expect(journal.filter((l) => l === "GET /api/saved/chats/c1")).toHaveLength(2);
    await vi.waitFor(() => expect(journal).toContain("GET /api/chat/c1/generation-status"));
    await api.startNewChat();
    expect(modeles).not.toHaveBeenCalled();
  });

  it("réponse différente (autre onglet) : le fil affiché est remplacé par celui du serveur", async () => {
    const contenus: Record<string, unknown> = { c1: A, c2: B };
    const srv = serveur(contenus);
    const { api, refs } = monter(null, { fetch: srv.fetch });
    await api.loadChat("c1");
    await api.loadChat("c2");
    contenus.c1 = conv([{ role: "user", content: "fil A modifié" }], {
      id: "c1",
      title: "A",
      updated_at: 10,
    });
    srv.retenir(true);
    const retour = api.loadChat("c1");
    expect(refs.messages.value[0]?.content).toBe("fil A");
    srv.liberer();
    await retour;
    expect(refs.messages.value[0]?.content).toBe("fil A modifié");
  });

  it("fil touché avant de partir (envoi, édition) ou flux en cours : pas d'aperçu au retour", async () => {
    for (const toucher of ["ajout", "remplacement", "flux"] as const) {
      const srv = serveur({ c1: A, c2: B });
      const { api, refs } = monter(null, { fetch: srv.fetch });
      await api.loadChat("c1");
      const liste = refs.messages.value as Message[];
      if (toucher === "ajout") liste.push({ role: "user", content: "nouveau" });
      if (toucher === "remplacement") liste.splice(0, 1, Object.freeze({ role: "user", content: "édité" }));
      if (toucher === "flux") refs.isStreaming.value = true;
      await api.loadChat("c2");
      refs.isStreaming.value = false;
      srv.retenir(true);
      const retour = api.loadChat("c1");
      expect(chatEnOuverture.value).toBe("c1");
      expect(refs.currentChatId.value).toBe("c2");
      srv.liberer();
      await retour;
      expect(refs.currentChatId.value).toBe("c1");
    }
  });

  it("date de la liste plus récente, renommage, suppression, autre session ou déconnexion : la lecture gardée n'est pas reprise", async () => {
    const cas: ((m: Awaited<ReturnType<typeof ouvrirPuisQuitter>>) => Promise<void> | void)[] = [
      (m) => {
        m.refs.chats.value = [{ id: "c1", title: "A", updated_at: 11 }];
      },
      async (m) => {
        await m.api._doRenameChat("c1", "A2");
      },
      async (m) => {
        await m.api.deleteChat("c1");
        m.toasts[0]?.options?.onAction?.();
      },
      (m) => {
        m.refs.user.value = null;
      },
    ];
    for (const preparer of cas) {
      const m = await ouvrirPuisQuitter();
      await preparer(m);
      m.srv.retenir(true);
      const retour = m.api.loadChat("c1");
      expect(m.refs.currentChatId.value).toBe("c2");
      m.srv.liberer();
      await retour;
    }
    const session = { generation: 1 };
    const m = await ouvrirPuisQuitter({ session });
    session.generation = 2;
    m.srv.retenir(true);
    const retour = m.api.loadChat("c1");
    expect(m.refs.currentChatId.value).toBe("c2");
    m.srv.liberer();
    await retour;
    expect(m.refs.currentChatId.value).toBe("c1");
  });

  it("conversation supprimée ailleurs pendant l'aperçu : message, nouveau chat, liste relue", async () => {
    const contenus: Record<string, unknown> = { c1: A, c2: B };
    const srv = serveur(contenus);
    const { api, refs, toasts, journal } = monter(null, { fetch: srv.fetch });
    await api.loadChat("c1");
    await api.loadChat("c2");
    delete contenus.c1;
    await api.loadChat("c1");
    expect(toasts.map((t) => t.message)).toEqual(["Cette conversation n’existe plus."]);
    expect(refs.currentChatId.value).toBeNull();
    expect(refs.messages.value).toEqual([]);
    expect(journal).toContain("GET /api/saved/chats?archived=0");
  });

  it("envoi parti depuis l'aperçu avant la réponse : le fil n'est pas remplacé ; réponse lente d'un aperçu quitté jetée", async () => {
    const contenus: Record<string, unknown> = { c1: A, c2: B };
    const srv = serveur(contenus);
    const { api, refs } = monter(null, { fetch: srv.fetch });
    await api.loadChat("c1");
    await api.loadChat("c2");
    contenus.c1 = conv([{ role: "user", content: "autre version" }], {
      id: "c1",
      title: "A",
      updated_at: 10,
    });
    srv.retenir(true);
    const retour = api.loadChat("c1");
    refs.isStreaming.value = true;
    srv.liberer();
    await retour;
    expect(refs.messages.value[0]?.content).toBe("fil A");
    srv.retenir(false);
    refs.isStreaming.value = false;
    // Course : aperçu de c1 puis aussitôt de c2 ; la réponse lente de c1 n'écrit rien.
    await api.loadChat("c2");
    await api.loadChat("c1");
    await api.loadChat("c2");
    srv.retenir(true);
    const lent = api.loadChat("c1");
    expect(refs.messages.value[0]?.content).toBe("autre version");
    const vite = api.loadChat("c2");
    expect(refs.currentChatId.value).toBe("c2");
    srv.liberer();
    await Promise.all([lent, vite]);
    expect(refs.currentChatId.value).toBe("c2");
    expect(refs.messages.value[0]?.content).toBe("fil B");
  });

  it("retour sur un aperçu pendant l'ouverture d'une autre : l'aperçu est relu du serveur et la génération sondée", async () => {
    const contenus: Record<string, unknown> = {
      c1: A,
      c2: B,
      c3: conv([{ role: "user", content: "fil C" }], { id: "c3" }),
    };
    const srv = serveur(contenus);
    const { api, refs, journal } = monter(null, { fetch: srv.fetch });
    refs.chats.value = [
      { id: "c1", title: "A", updated_at: 10 },
      { id: "c2", title: "B", updated_at: 20 },
    ];
    await api.loadChat("c1");
    await api.loadChat("c2");
    // Autre onglet : A a reçu une réponse sans que la liste locale le sache.
    contenus.c1 = conv(
      [
        { role: "user", content: "fil A" },
        { role: "assistant", content: "réponse venue d'ailleurs" },
      ],
      { id: "c1", title: "A", updated_at: 10 },
    );
    srv.retenir(true);
    const apercu = api.loadChat("c1");
    expect(refs.messages.value).toHaveLength(1);
    const autre = api.loadChat("c3");
    const retour = api.loadChat("c1");
    srv.retenir(false);
    srv.liberer();
    await Promise.all([apercu, autre, retour]);
    await vi.waitFor(() =>
      expect(journal.filter((l) => l === "GET /api/chat/c1/generation-status").length).toBeGreaterThan(1),
    );
    expect(refs.currentChatId.value).toBe("c1");
    expect(refs.messages.value).toHaveLength(2);
  });

  it("bornes : cinq conversations au plus, taille totale plafonnée, une lecture trop grande n'est pas gardée", () => {
    for (let i = 0; i < GARDEES_MAX + 2; i++) garderConversation("k" + i, 0, "x", 1);
    expect(conversationGardee("k0", 0, null)).toBeNull();
    expect(conversationGardee("k1", 0, null)).toBeNull();
    expect(conversationGardee("k2", 0, 1)).toBe("x");
    oublierConversation();
    const moitie = "y".repeat(GARDEES_CARACTERES_MAX / 2);
    garderConversation("a", 0, moitie, 1);
    garderConversation("b", 0, moitie, 1);
    garderConversation("c", 0, "z", 1);
    expect(conversationGardee("a", 0, null)).toBeNull();
    expect(conversationGardee("b", 0, null)).toBe(moitie);
    garderConversation("geant", 0, "g".repeat(GARDEES_CARACTERES_MAX + 1), 1);
    expect(conversationGardee("geant", 0, null)).toBeNull();
    garderConversation("autre", 1, "s", 1);
    expect(conversationGardee("b", 0, null)).toBeNull();
  });
});

describe("historique : suppression et actions groupées", () => {
  it("chat courant en génération : run arrêté avant le retrait, DELETE seulement à l'expiration du toast", async () => {
    const { api, refs, journal, toasts } = monter(null, {
      courant: "c1",
      fetch: () => Promise.resolve(json({})),
    });
    await api.deleteChat("c1");
    expect(journal[0]).toBe("stop c1");
    expect(journal.indexOf("detach")).toBeGreaterThan(0);
    expect(refs.chats.value.map((c) => c.id)).toEqual(["c2"]);
    expect(refs.currentChatId.value).toBeNull();
    expect(journal.some((l) => l.startsWith("DELETE"))).toBe(false);
    await toasts[0]?.options?.onExpire?.();
    expect(journal).toContain("DELETE /api/saved/chats/c1");
  });

  it("chat non courant : son run est arrêté, le courant n'est pas détaché ; annuler restaure sans requête", async () => {
    const { api, refs, journal, toasts } = monter(null, { courant: "c1" });
    await api.deleteChat("c2");
    expect(journal).toEqual(["stop c2"]);
    expect(refs.currentChatId.value).toBe("c1");
    toasts[0]?.options?.onAction?.();
    expect(refs.chats.value.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("supprimer : la confirmation s'ouvre sans attendre les tâches de fond, leur nombre prend la place du message", async () => {
    const reponses: ((n: number) => void)[] = [];
    const { api, confirmations } = monter(null, {
      confirmer: false,
      deps: { compterJobsActifs: () => new Promise<number>((r) => reponses.push(r)) },
    });
    void api.deleteChat("c1");
    expect(confirmations[0]?.slice(0, 4)).toEqual([
      "Supprimer la conversation ?",
      "Vous pourrez l’annuler quelques secondes.",
      true,
      "Supprimer",
    ]);
    reponses[0]?.(2);
    expect(await confirmations[0]?.[5]).toBe("2 tâches de fond seront arrêtées.");
    api.toggleChatSelectMode();
    api.toggleChatSelect("c1");
    void api.bulkDeleteChats();
    expect(confirmations[1]?.[1]).toBe("Cette action est irréversible.");
    reponses[1]?.(1);
    expect(await confirmations[1]?.[5]).toBe("Irréversible : 1 tâche de fond sera arrêtée.");
    void api.deleteChat("c2");
    reponses[2]?.(0);
    expect(await confirmations[2]?.[5]).toBe("");
  });

  it("confirmation refusée : rien n'est arrêté ni retiré ; sans stopRunForChat la suppression marche encore", async () => {
    const a = monter(null, { courant: "c1", confirmer: false });
    await a.api.deleteChat("c1");
    expect(a.journal).toEqual([]);
    expect(a.refs.chats.value).toHaveLength(2);
    const b = monter(null, { courant: "c2", deps: { stopRunForChat: null } });
    await b.api.deleteChat("c2");
    expect(b.refs.chats.value.map((c) => c.id)).toEqual(["c1"]);
  });

  it("archiver : sans question, retrait aussitôt, « Annuler » désarchive et remet la conversation à sa place", async () => {
    // Une confirmation refusée bloquerait l'archivage : il passe quand même, donc sans question.
    const { api, refs, journal, toasts } = monter(null, {
      courant: "c2",
      confirmer: false,
      fetch: () => Promise.resolve(json({})),
    });
    await api.archiveChat("c1");
    expect(journal).toContain("POST /api/saved/chats/c1/archive");
    expect(refs.chats.value.map((c) => c.id)).toEqual(["c2"]);
    expect(toasts[0]?.message).toBe("« A » archivée");
    toasts[0]?.options?.onAction?.();
    await vi.waitFor(() => expect(refs.chats.value.map((c) => c.id)).toEqual(["c1", "c2"]));
    expect(journal).toContain("POST /api/saved/chats/c1/unarchive");
  });

  it("archiver : la ligne part avant la réponse ; « Annuler » attend l'archivage avant de désarchiver", async () => {
    let repondre: (r: Response) => void = () => {};
    const { api, refs, journal, toasts } = monter(null, {
      fetch: (url) =>
        url.endsWith("/archive") ? new Promise<Response>((r) => (repondre = r)) : Promise.resolve(json({})),
    });
    const archivage = api.archiveChat("c2");
    expect(refs.chats.value.map((c) => c.id)).toEqual(["c1"]);
    expect(toasts[0]?.message).toBe("« B » archivée");
    toasts[0]?.options?.onAction?.();
    await Promise.resolve();
    expect(journal.some((l) => l.endsWith("/unarchive"))).toBe(false);
    repondre(json({}));
    await archivage;
    await vi.waitFor(() => expect(refs.chats.value.map((c) => c.id)).toEqual(["c1", "c2"]));
    expect(journal.indexOf("POST /api/saved/chats/c2/archive")).toBeLessThan(
      journal.indexOf("POST /api/saved/chats/c2/unarchive"),
    );
  });

  it("archiver refusé par le serveur : la ligne revient à sa place, la conversation courante est rouverte, message d'erreur", async () => {
    for (const echec of [() => Promise.resolve(json({}, 500)), () => Promise.reject(new Error("réseau"))]) {
      const { api, refs, journal, toasts } = monter(conv([{ role: "user", content: "x" }], { id: "c1" }), {
        courant: "c1",
        fetch: (url) =>
          url.endsWith("/archive")
            ? echec()
            : Promise.resolve(
                json(
                  url.includes("generation-status")
                    ? {}
                    : conv([{ role: "user", content: "x" }], { id: "c1" }),
                ),
              ),
      });
      await api.archiveChat("c1");
      expect(refs.chats.value.map((c) => c.id)).toEqual(["c1", "c2"]);
      expect(toasts.map((t) => t.message)).toEqual(["« A » archivée", "Archivage impossible"]);
      await vi.waitFor(() => expect(refs.currentChatId.value).toBe("c1"));
      expect(journal).toContain("GET /api/saved/chats/c1");
      // « Annuler » après un refus : rien à défaire, aucune requête.
      toasts[0]?.options?.onAction?.();
      await Promise.resolve();
      expect(journal.some((l) => l.endsWith("/unarchive"))).toBe(false);
    }
  });

  it("renommer : titre posé avant la réponse, ancien titre et message d'erreur si le serveur refuse", async () => {
    let repondre: (r: Response) => void = () => {};
    const { api, refs, toasts } = monter(null, {
      courant: "c1",
      fetch: () => new Promise<Response>((r) => (repondre = r)),
    });
    refs.currentChatTitle.value = "A";
    const ok = api._doRenameChat("c1", "  Nouveau  ");
    expect(refs.chats.value[0]?.title).toBe("Nouveau");
    expect(refs.currentChatTitle.value).toBe("Nouveau");
    repondre(json({}));
    expect(await ok).toBe(true);
    expect(refs.chats.value[0]?.title).toBe("Nouveau");
    const refus = api._doRenameChat("c1", "Refusé");
    expect(refs.currentChatTitle.value).toBe("Refusé");
    repondre(json({}, 500));
    expect(await refus).toBe(false);
    expect(refs.chats.value[0]?.title).toBe("Nouveau");
    expect(refs.currentChatTitle.value).toBe("Nouveau");
    expect(toasts.map((t) => t.message)).toEqual(["Renommage impossible"]);
  });

  it("renommer : un refus tardif n'écrase pas un titre posé entre-temps", async () => {
    const reponses: ((r: Response) => void)[] = [];
    const { api, refs } = monter(null, { fetch: () => new Promise<Response>((r) => reponses.push(r)) });
    const premier = api._doRenameChat("c2", "Un");
    const second = api._doRenameChat("c2", "Deux");
    reponses[0]?.(json({}, 500));
    await premier;
    expect(refs.chats.value[1]?.title).toBe("Deux");
    reponses[1]?.(json({}));
    expect(await second).toBe(true);
  });

  it("archiver une sélection : sans question, toast « Annuler » qui désarchive chaque conversation", async () => {
    const { api, refs, journal, toasts } = monter(null, {
      confirmer: false,
      fetch: (url) => Promise.resolve(json(url.includes("archive-batch") ? { archived: 2 } : {})),
    });
    api.toggleChatSelectMode();
    api.toggleChatSelect("c1");
    api.toggleChatSelect("c2");
    await api.bulkArchiveChats();
    expect(refs.chats.value).toEqual([]);
    expect(toasts[0]?.message).toBe("2 conversation(s) archivée(s)");
    toasts[0]?.options?.onAction?.();
    await vi.waitFor(() => expect(refs.chats.value.map((c) => c.id).sort()).toEqual(["c1", "c2"]));
    expect(journal.filter((l) => l.endsWith("/unarchive"))).toHaveLength(2);
  });

  it("échec d'une action groupée : la liste est relue du serveur", async () => {
    const { api, refs, journal } = monter(null, {
      fetch: (url) =>
        Promise.resolve(
          url.includes("archive-batch")
            ? json({}, 500)
            : json({
                items: [
                  { id: "c1", title: "A" },
                  { id: "c2", title: "B" },
                ],
              }),
        ),
    });
    api.toggleChatSelectMode();
    api.toggleChatSelect("c1");
    await api.bulkArchiveChats();
    await vi.waitFor(() => expect(refs.chats.value).toHaveLength(2));
    expect(journal).toContain("GET /api/saved/chats?archived=0");
    expect(api.chatSelectMode.value).toBe(false);
  });
});

describe("recherche", () => {
  const monterRecherche = (fetchAuth: (url: string) => Promise<Response | null>) =>
    creerRechercheChat(Vue, null, { fetchAuth });

  it("surlignage différé, effacement immédiat, fermeture qui vide", async () => {
    vi.useFakeTimers();
    const r = monterRecherche(() => Promise.resolve(null));
    r.messageSearchActive.value = true;
    r.messageSearch.value = "abc";
    await vi.advanceTimersByTimeAsync(DELAI_SURLIGNAGE_MS - 10);
    expect(r.messageSearchQ.value).toBe("");
    await vi.advanceTimersByTimeAsync(20);
    expect(r.messageSearchQ.value).toBe("abc");
    r.messageSearch.value = "  ";
    await vi.advanceTimersByTimeAsync(0);
    expect(r.messageSearchQ.value).toBe("");
    r.messageSearch.value = "xyz";
    r.resetMessageSearch();
    await vi.advanceTimersByTimeAsync(DELAI_SURLIGNAGE_MS * 2);
    expect(r.messageSearchQ.value).toBe("");
  });

  it("historique : seule la dernière requête s'applique et éteint l'indicateur ; annuler invalide la requête en vol", async () => {
    vi.useFakeTimers();
    const reponses = new Map<string, (r: Response) => void>();
    const r = monterRecherche(
      (url) =>
        new Promise<Response>((resoudre) => {
          reponses.set(decodeURIComponent(url.split("q=")[1] ?? ""), resoudre);
        }),
    );
    const chercher = async (q: string): Promise<void> => {
      (r.chatSearch as Ref<string | null>).value = q;
      await vi.advanceTimersByTimeAsync(DELAI_RECHERCHE_MS + 1);
    };
    const rapide = { id: "b", title: "Rapide" };
    await chercher("lent");
    await chercher("rapide");
    reponses.get("rapide")?.(json({ items: [rapide] }));
    await vi.advanceTimersByTimeAsync(0);
    reponses.get("lent")?.(json({ items: [{ id: "a", title: "Lent" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.chatSearchResults.value).toEqual([rapide]);
    expect(r.isSearchingChats.value).toBe(false);
    await chercher("rapid");
    r.cancelPendingSearch();
    expect(r.isSearchingChats.value).toBe(false);
    reponses.get("rapid")?.(json({ items: [{ id: "z", title: "Rapidité" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.chatSearchResults.value).toEqual([rapide]);
    r.closeChatSearch();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.chatSearchResults.value).toEqual([]);
    expect(r.searchOpen.value).toBe(false);
  });

  it("historique : entre deux frappes, la réponse précédente reste pour ce qui correspond encore, sans attendre le serveur", async () => {
    vi.useFakeTimers();
    const reponses = new Map<string, (r: Response) => void>();
    const r = monterRecherche(
      (url) =>
        new Promise<Response>((resoudre) => {
          reponses.set(decodeURIComponent(url.split("q=")[1] ?? ""), resoudre);
        }),
    );
    const saisie = r.chatSearch as Ref<string | null>;
    saisie.value = "con";
    await vi.advanceTimersByTimeAsync(DELAI_RECHERCHE_MS + 1);
    const items = [
      { id: "1", title: "Conversation 1" },
      { id: "2", title: "Conversation 2" },
      { id: "3", title: "Contrat" },
    ];
    reponses.get("con")?.(json({ items }));
    await vi.advanceTimersByTimeAsync(0);
    saisie.value = "CONVERSATION ";
    await vi.advanceTimersByTimeAsync(0);
    expect(r.chatSearchResults.value.map((x) => x.id)).toEqual(["1", "2"]);
    expect(r.isSearchingChats.value).toBe(true);
    saisie.value = "zut";
    await vi.advanceTimersByTimeAsync(0);
    expect(r.chatSearchResults.value).toEqual([]);
  });

  it("fusion : titres du volet d'abord et dans leur ordre, puis ceux du serveur à la suite, sans doublon", () => {
    const volet = [
      { id: "1", title: "Court 10" },
      { id: "2", title: "Long" },
      { id: "3", title: "court 1" },
    ];
    expect(fusionnerResultats("Court 1", volet, []).map((x) => x.id)).toEqual(["1", "3"]);
    const serveur = [
      { id: "3", title: "court 1" },
      { id: "9", title: "Court 1 ancien" },
      { id: "1", title: "Court 10" },
    ];
    expect(fusionnerResultats(" court 1", volet, serveur).map((x) => x.id)).toEqual(["1", "3", "9"]);
    expect(fusionnerResultats("  ", volet, [])).toEqual([]);
    expect(titreCorrespond(undefined, "a")).toBe(false);
  });
});
