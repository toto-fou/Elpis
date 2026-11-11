// SPDX-License-Identifier: MIT
/** apps/core/test/llm/fournisseurs/distants.test.ts — fournisseurs distants : OpenAI-compatible, Anthropic (flux SSE servis en HTTP, reprises), découverte des modèles d'un connecteur. */
import "../environnement-fournisseurs";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { lireVecteurs } from "../../vecteurs-moteur";
import { corpsAnthropicTs } from "./ecart-anthropic";
import { sortieAssainieTs } from "./ecart-dialecte-etendu";
import { attendre, FauxServeur, portFerme } from "../faux-serveur";
import { moteurFrais, urlLlama } from "../moteur-frais";
import type { Moteur } from "../moteur-frais";

type Dict = Record<string, unknown>;

interface Erreur {
  type: string;
  message: string;
  statut?: number;
  corps?: string;
}

interface VecteursDistants {
  openai: {
    cibles: { cible: Dict; chat: string; modeles: string; en_tetes: Dict; natif: boolean }[];
    assainis: { cible: Dict; entree: Dict; sortie: Dict }[];
    raisonnement: { modele: unknown; oui: boolean }[];
    distant: { entree: unknown; sortie: Dict }[];
  };
  anthropic: {
    racines: { base: string; racine: string; messages: string }[];
    en_tetes: Dict;
    urls_data: { url: unknown; lu: [string, string] | null }[];
    traductions: { historique: unknown[]; avec_outils: boolean; systeme: string; messages: Dict[] }[];
    outils: { entree: unknown[] | null; sortie: Dict[] }[];
    corps: {
      cible: Dict;
      outils: unknown[] | null;
      surcharge: unknown;
      pense: boolean;
      modele: string | null;
      corps: Dict;
    }[];
    versions: { id: string | null; version: [number, number] | null; reflexion: (Dict | null)[] }[];
    usages: { entree: Dict; sortie: Dict }[];
    fins: { stop: unknown; outils: boolean; fin: string }[];
  };
  anthropic_flux: {
    nom: string;
    lignes: string[];
    statut: number;
    corps: string;
    resultat?: Dict;
    erreur?: Erreur;
    evenements: unknown[];
    appel: [string, string, Dict, Dict];
  }[];
  decouverte: (
    | {
        ligne: Dict;
        reponse: [number, unknown] | null;
        panne: string | null;
        modeles: Dict;
        test: Dict;
        appel: [string, string, Dict, number];
      }
    | { gratuits: { fournisseur: string | null; ids: string[]; gratuits: string[]; decore: Dict }[] }
  )[];
}

const V = lireVecteurs<VecteursDistants>("moteur-fournisseurs");
let m: Moteur;
let s: FauxServeur;

beforeAll(async () => {
  s = await FauxServeur.demarrer();
  m = await moteurFrais(urlLlama("http://127.0.0.1:1"));
});

afterAll(async () => {
  await m.fermer();
  await s.arreter();
});

afterEach(() => {
  vi.restoreAllMocks();
  s.requetes.length = 0;
});

function cibleDe(spec: Dict) {
  return new m.cible.LlmTarget({
    isDefault: spec["is_default"] as boolean | undefined,
    providerType: spec["provider_type"] as string | undefined,
    baseUrl: spec["base_url"] as string | undefined,
    apiKey: spec["api_key"] as string | undefined,
    model: spec["model"] as string | undefined,
    wire: spec["wire"] as string | undefined,
  });
}

function erreurDe(e: unknown): Erreur {
  const x = e as Error & { response?: { statusCode: number; text: string } };
  const sortie: Erreur = { type: x.name, message: x.message };
  if (x.response) {
    sortie.statut = x.response.statusCode;
    sortie.corps = x.response.text;
  }
  return sortie;
}

describe("OpenAI-compatible (vecteurs Python)", () => {
  it("URL chat et modèles, en-têtes, dialecte natif", () => {
    for (const c of V.openai.cibles) {
      const t = cibleDe(c.cible);
      const ctx = JSON.stringify(c.cible);
      expect(m.openai.chatCompletionsUrl(t), ctx).toBe(c.chat);
      expect(m.openai.modelsUrl(t), ctx).toBe(c.modeles);
      expect(m.openai.headers(t), ctx).toEqual(c.en_tetes);
      expect(m.openai.isLlamaNative(t), ctx).toBe(c.natif);
    }
  });

  it("payload assaini hors llama.cpp (champs standard, max_completion_tokens des modèles de raisonnement)", () => {
    for (const c of V.openai.assainis)
      expect(
        m.openai.sanitizePayload(structuredClone(c.entree), cibleDe(c.cible)),
        JSON.stringify(c),
      ).toEqual(sortieAssainieTs(c.cible, c.entree, c.sortie));
  });

  it("modèles de raisonnement OpenAI et sampling distant validé", () => {
    for (const c of V.openai.raisonnement)
      expect(m.openai.isOpenaiReasoningModel(c.modele), String(c.modele)).toBe(c.oui);
    for (const c of V.openai.distant)
      expect(m.openai.remoteSampling(structuredClone(c.entree)), JSON.stringify(c.entree)).toEqual(c.sortie);
  });

  it("endpoint : client dédié et Bearer pour un distant, client partagé et LLAMA_URL pour le local", () => {
    const distant = cibleDe({
      is_default: false,
      provider_type: "openai",
      base_url: "http://d:1/v1/",
      api_key: "k",
    });
    const [c1, url1, h1] = m.openai.endpoint(distant);
    expect([url1, h1]).toEqual(["http://d:1/v1/chat/completions", { Authorization: "Bearer k" }]);
    expect(c1).toBe(m.client.getLlmClient("http://d:1/v1/"));
    const [c2, url2, h2] = m.openai.endpoint(m.cible.defaultTarget());
    expect([url2, h2]).toEqual(["http://127.0.0.1:1/v1/chat/completions", {}]);
    expect(c2).toBe(m.client.getLlmClient());
  });
});

describe("Anthropic : traduction et corps (vecteurs Python)", () => {
  it("racine, URL des messages, en-têtes, URL data:", () => {
    for (const c of V.anthropic.racines) {
      const t = cibleDe({ is_default: false, base_url: c.base });
      expect(m.anthropic.apiRoot(t)).toBe(c.racine);
      expect(m.anthropic.messagesUrl(t)).toBe(c.messages);
    }
    expect(m.anthropic.buildHeaders({ apiKey: "sk-a" })).toEqual(V.anthropic.en_tetes);
    for (const c of V.anthropic.urls_data)
      expect(m.anthropic.parseDataUrl(c.url), String(c.url)).toEqual(c.lu);
  });

  it("historique OpenAI → system + messages Anthropic (avec et sans outils), outils", () => {
    for (const c of V.anthropic.traductions)
      expect(
        m.anthropic.toAnthropicMessages(structuredClone(c.historique), { withTools: c.avec_outils }),
        JSON.stringify(c.historique).slice(0, 80),
      ).toEqual([c.systeme, c.messages]);
    for (const c of V.anthropic.outils) expect(m.anthropic.toAnthropicTools(c.entree)).toEqual(c.sortie);
  });

  it("corps /v1/messages : modèle, plafond, outils, réflexion selon la version", () => {
    const historique = V.anthropic.traductions[2]?.historique ?? [];
    for (const c of V.anthropic.corps) {
      const t = cibleDe({ is_default: false, wire: "anthropic", provider_type: "anthropic", ...c.cible });
      const corps = m.anthropic.buildBody(t, structuredClone(historique), {
        toolsPayload: c.outils,
        samplingOverride: structuredClone(c.surcharge),
        thinkingMode: c.pense,
        model: c.modele,
        stream: true,
      });
      const attendu = corpsAnthropicTs(c.pense, c.corps, m.anthropic.thinkingConfig);
      expect(corps, JSON.stringify({ ...c, corps: undefined })).toEqual(attendu);
    }
    for (const c of V.anthropic.versions) {
      expect(m.anthropic.claudeVersion(c.id), String(c.id)).toEqual(c.version);
      expect([8192, 2000, 2048, 16000].map((mt) => m.anthropic.thinkingConfig(c.id ?? "", mt))).toEqual(
        c.reflexion,
      );
    }
    for (const c of V.anthropic.usages) expect(m.anthropic.normalizeUsage(c.entree)).toEqual(c.sortie);
    for (const c of V.anthropic.fins)
      expect(m.anthropic.finishFromStopReason(c.stop, { hasToolCalls: c.outils }), JSON.stringify(c)).toBe(
        c.fin,
      );
  });

  it("réflexion avec outils : adaptative résumée dès 4.6 (et pour un modèle inconnu), jamais le budget fixe", () => {
    const t = cibleDe({ is_default: false, wire: "anthropic", provider_type: "anthropic" });
    const outils = [{ type: "function", function: { name: "f" } }];
    const reflexion = (modele: string, pense = true): unknown =>
      m.anthropic.buildBody(t, [{ role: "user", content: "q" }], {
        toolsPayload: outils,
        thinkingMode: pense,
        model: modele,
      })["thinking"];
    const adaptative = { type: "adaptive", display: "summarized" };
    expect(reflexion("claude-sonnet-4-6")).toEqual(adaptative);
    expect(reflexion("claude-opus-5-5")).toEqual(adaptative);
    expect(reflexion("claude-fable-5-1")).toEqual(adaptative);
    expect(reflexion("claude-opus-4-1")).toBeUndefined();
    expect(reflexion("claude-opus-5-5", false)).toBeUndefined();
  });

  it("effort : niveaux selon le modèle, `output_config.effort` seulement si le modèle l'accepte", () => {
    const tous = ["low", "medium", "high", "xhigh", "max"];
    const table: [string, string[]][] = [
      ["claude-opus-5-5", tous],
      ["claude-sonnet-5-5", tous],
      ["claude-haiku-5-5", tous],
      ["claude-fable-5-1", tous],
      ["claude-mythos-5-1", tous],
      ["anthropic/claude-opus-4-7", tous],
      ["claude-opus-4-8", tous],
      ["claude-opus-4-6", ["low", "medium", "high", "max"]],
      ["claude-sonnet-4-6", ["low", "medium", "high", "max"]],
      ["claude-opus-4-5-20251101", ["low", "medium", "high"]],
      ["claude-sonnet-4-5-20250929", []],
      ["claude-haiku-4-5", []],
      ["claude-opus-4-1", []],
      ["claude-3-7-sonnet-latest", []],
      ["my-claude", []],
    ];
    for (const [id, attendu] of table) expect(m.anthropic.effortsClaude(id), id).toEqual(attendu);
    const t = cibleDe({ is_default: false, wire: "anthropic", provider_type: "anthropic" });
    const effort = (modele: string, valeur: unknown, outils = false): unknown =>
      m.anthropic.buildBody(t, [{ role: "user", content: "q" }], {
        toolsPayload: outils ? [{ type: "function", function: { name: "f" } }] : null,
        samplingOverride: { reasoning_effort: valeur, max_tokens: 100 },
        model: modele,
      })["output_config"];
    expect(effort("claude-opus-5-5", "max")).toEqual({ effort: "max" });
    expect(effort("claude-opus-5-5", "low", true)).toEqual({ effort: "low" });
    expect(effort("claude-opus-4-6", "xhigh")).toBeUndefined();
    expect(effort("claude-haiku-4-5", "high")).toBeUndefined();
    expect(effort("claude-opus-5-5", "minimal")).toBeUndefined();
    expect(effort("claude-opus-5-5", null)).toBeUndefined();
  });

  it("points de cache sur demande : fin du système, dernier bloc marquable de la conversation", () => {
    const t = cibleDe({ is_default: false, wire: "anthropic", provider_type: "anthropic" });
    const ephemere = { type: "ephemeral" };
    const historique = [
      { role: "system", content: "S" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
        _anthropic_thinking: [{ type: "thinking", thinking: "p", signature: "x" }],
      },
      { role: "tool", tool_call_id: "t1", content: "r" },
    ];
    const outils = [{ type: "function", function: { name: "f" } }];
    const corps = m.anthropic.buildBody(t, historique, { toolsPayload: outils, cache: true });
    expect(corps["system"]).toEqual([{ type: "text", text: "S", cache_control: ephemere }]);
    const msgs = corps["messages"] as Dict[];
    expect(msgs.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "r", cache_control: ephemere }],
    });
    expect(JSON.stringify(msgs.slice(0, -1))).not.toContain("cache_control");
    expect(JSON.stringify(m.anthropic.buildBody(t, historique, { toolsPayload: outils }))).not.toContain(
      "cache_control",
    );
    const fin: Dict = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "thinking", thinking: "", signature: "s" },
          ],
        },
      ],
    };
    m.anthropic.poserPointsCache(fin);
    expect(fin).toEqual({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "a", cache_control: ephemere },
            { type: "thinking", thinking: "", signature: "s" },
          ],
        },
      ],
    });
  });
});

describe("Anthropic : flux SSE servis par un faux serveur", () => {
  function servir(statut: number, lignes: readonly string[], corps: string): void {
    s.route("POST /v1/messages", (_q, rep) => {
      if (statut >= 400) {
        rep.writeHead(statut, {
          "content-type": "application/json",
          ...(statut === 429 ? { "retry-after": "3" } : {}),
        });
        rep.end(corps);
        return;
      }
      rep.writeHead(200, { "content-type": "text/event-stream" });
      rep.end(lignes.map((l) => `${l}\n\n`).join(""));
    });
  }

  it("vecteurs rejoués : résultat, événements, erreurs et requête identiques à Python", async () => {
    const cible = { baseUrl: s.url, apiKey: "k", model: "" };
    for (const c of V.anthropic_flux) {
      servir(c.statut, c.lignes, c.corps);
      s.requetes.length = 0;
      const evenements: unknown[] = [];
      let resultat: Dict | undefined;
      let erreur: Erreur | undefined;
      let brute: unknown;
      try {
        resultat = await m.anthropic.consumeStream(
          cible,
          { model: "claude-depart" },
          {
            onContentToken: (t) => void evenements.push(["contenu", t]),
            onThinkingToken: (t) => void evenements.push(["pense", t]),
            onToolCallDelta: (i, n, a) => void evenements.push(["outil", i, n, a]),
          },
        );
      } catch (e) {
        brute = e;
        erreur = erreurDe(e);
      }
      expect(resultat, c.nom).toEqual(c.resultat);
      expect(erreur, c.nom).toEqual(c.erreur);
      expect(evenements, c.nom).toEqual(c.evenements);
      const requete = s.sur("/v1/messages")[0];
      expect(requete?.json(), c.nom).toEqual(c.appel[2]);
      for (const [k, v] of Object.entries(c.appel[3]))
        expect(requete?.entetes[k.toLowerCase()], `${c.nom} ${k}`).toBe(v);
      expect(new URL(c.appel[1]).pathname).toBe("/v1/messages");
      if (c.statut === 429) expect(m.reprises.retryAfterSeconds(brute)).toBe(3);
    }
  });

  it("chemin classique : reprise d'une panne transitoire tant que rien n'a été streamé, puis méta du tour", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let tour = 0;
    s.route("POST /v1/messages", (_q, rep) => {
      if (tour++ === 0) {
        rep.writeHead(529, { "content-type": "application/json" });
        rep.end('{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}');
        return;
      }
      rep.writeHead(200, { "content-type": "text/event-stream" });
      rep.end(
        [
          'data: {"type": "message_start", "message": {"model": "claude-x", "usage": {"input_tokens": 3}}}',
          'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}}',
          'data: {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "ok"}}',
          'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}',
        ].join("\n") + "\n",
      );
    });
    const jetons: string[] = [];
    const cible = { baseUrl: s.url, apiKey: "k", model: "claude-sonnet-4-6" };
    const connecteur = new m.cible.LlmTarget({
      isDefault: false,
      wire: "anthropic",
      providerType: "anthropic",
    });
    const [pense, contenu, meta] = await m.cible.useLlmTarget(connecteur, () =>
      m.anthropic.anthropicChatStream([{ role: "user", content: "x" }], {
        target: cible,
        onContentToken: (t) => void jetons.push(t),
      }),
    );
    expect([pense, contenu, jetons, tour]).toEqual(["hmm", "ok", ["ok"], 2]);
    expect(meta).toEqual({
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      timings: {},
      model: "claude-x",
      thinking: "hmm",
      finish_reason: "stop",
      truncated: false,
      truncated_in_think: false,
      thinking_tokens: 1,
      thinking_tokens_estimated: true,
    });
    expect(s.sur("/v1/messages")[1]?.json()).toMatchObject({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      stream: true,
    });
  });

  it("chemin classique : refus définitif (4xx) = message actionnable sans nouvelle tentative", async () => {
    s.json(
      "POST /v1/messages",
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
      400,
    );
    const [pense, contenu, meta] = await m.anthropic.anthropicChatStream([{ role: "user", content: "x" }], {
      target: { baseUrl: s.url, apiKey: "k", model: "" },
    });
    expect(pense).toBe("");
    expect(contenu).toMatch(/^⚠ Erreur LLM : La conversation dépasse la fenêtre de contexte/);
    expect(meta).toEqual({ usage: {}, timings: {}, error: true });
    expect(s.sur("/v1/messages")).toHaveLength(1);
  });

  it("chemin outils : appels OpenAI, blocs de réflexion signés gardés, finish_reason ; annulation propagée", async () => {
    s.sse("POST /v1/messages", [
      'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}}',
      'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "p"}}',
      'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "S"}}',
      'data: {"type": "content_block_stop", "index": 0}',
      'data: {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tu", "name": "f"}}',
      'data: {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{}"}}',
      'data: {"type": "content_block_stop", "index": 1}',
      'data: {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}',
    ]);
    const cible = { baseUrl: s.url, apiKey: "k", model: "" };
    const r = await m.anthropic.anthropicChatWithToolsStream(
      [{ role: "user", content: "x" }],
      [{ type: "function", function: { name: "f" } }],
      {
        target: cible,
      },
    );
    expect(r["choices"]).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "p",
          tool_calls: [{ id: "tu", type: "function", function: { name: "f", arguments: "{}" } }],
          _anthropic_thinking: [{ type: "thinking", thinking: "p", signature: "S" }],
        },
        finish_reason: "tool_calls",
      },
    ]);
    expect(s.sur("/v1/messages")[0]?.json()).toMatchObject({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] },
      ],
    });
    s.sse(
      "POST /v1/messages",
      [
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "a"}}',
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "b"}}',
        'data: {"type": "message_stop"}',
      ],
      { delaiMs: 80, ouvert: true },
    );
    let stop = false;
    const avant = s.deconnexions;
    await expect(
      m.anthropic.anthropicChatStream([{ role: "user", content: "x" }], {
        target: cible,
        isCancelled: () => stop,
        onContentToken: () => {
          stop = true;
        },
      }),
    ).rejects.toBeInstanceOf(m.client.CancelledError);
    const ctl = new AbortController();
    await expect(
      m.anthropic.anthropicChatStream([{ role: "user", content: "x" }], {
        target: cible,
        signal: ctl.signal,
        onContentToken: () => ctl.abort(),
      }),
    ).rejects.toBeInstanceOf(m.client.CancelledError);
    await attendre(50);
    expect(s.deconnexions).toBe(avant + 2);
  });

  it("chemin outils : un refus 400 lié à la réflexion est rejoué une fois sans réflexion ni blocs", async () => {
    let tour = 0;
    s.route("POST /v1/messages", (_q, rep) => {
      if (tour++ === 0) {
        rep.writeHead(400, { "content-type": "application/json" });
        rep.end(
          '{"type": "error", "error": {"type": "invalid_request_error", "message": "messages.1.content.0: Invalid `signature` in `thinking` block."}}',
        );
        return;
      }
      rep.writeHead(200, { "content-type": "text/event-stream" });
      rep.end(
        'data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}}\n\n' +
          'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n\n',
      );
    });
    const historique = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
        _anthropic_thinking: [{ type: "thinking", thinking: "p", signature: "x" }],
      },
      { role: "tool", tool_call_id: "t1", content: "r" },
    ];
    const outils = [{ type: "function", function: { name: "f" } }];
    const cible = { baseUrl: s.url, apiKey: "k", model: "claude-opus-5-5" };
    const r = await m.anthropic.anthropicChatWithToolsStream(historique, outils, {
      target: cible,
      thinkingMode: true,
    });
    expect((r["choices"] as Dict[])[0]?.["message"]).toEqual({ role: "assistant", content: "ok" });
    const [premiere, seconde] = s.sur("/v1/messages").map((q) => q.json() as Dict);
    expect(premiere?.["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(JSON.stringify(premiere?.["messages"])).toContain('"type":"thinking"');
    expect(seconde?.["thinking"]).toBeUndefined();
    expect(JSON.stringify(seconde?.["messages"])).not.toContain('"type":"thinking"');
    s.json(
      "POST /v1/messages",
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
      400,
    );
    s.requetes.length = 0;
    await expect(
      m.anthropic.anthropicChatWithToolsStream(historique, outils, { target: cible, thinkingMode: true }),
    ).rejects.toMatchObject({ response: { statusCode: 400 } });
    expect(s.sur("/v1/messages")).toHaveLength(1);
  });

  it("clés héritées d'Object.prototype : type d'erreur inconnu = 500, `__proto__` reste une clé d'usage", async () => {
    const cible = { baseUrl: s.url, apiKey: "k", model: "" };
    s.sse("POST /v1/messages", ['data: {"type": "error", "error": {"type": "constructor", "message": "x"}}']);
    await expect(m.anthropic.consumeStream(cible, { model: "c" }, {})).rejects.toMatchObject({
      message: "Anthropic stream error (constructor): x",
      response: { statusCode: 500 },
    });
    s.sse("POST /v1/messages", [
      'data: {"type": "message_start", "message": {"usage": {"__proto__": {"output_tokens": 9}, "input_tokens": 1}}}',
      'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}',
    ]);
    const r = await m.anthropic.consumeStream(cible, { model: "c" }, {});
    expect(r["usage"]).toEqual({
      prompt_tokens: 1,
      completion_tokens: 0,
      total_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});

describe("découverte des modèles d'un connecteur (vecteurs Python)", () => {
  type CasDecouverte = Extract<VecteursDistants["decouverte"][number], { ligne: Dict }>;

  async function rejouer(c: CasDecouverte, base: string, timeout: number): Promise<void> {
    const brute = String(c.ligne["base_url"] ?? "");
    const origine = brute ? new URL(brute).origin : "";
    const ligne = { ...c.ligne, base_url: brute ? base + brute.slice(origine.length) : base };
    const ctx = `${JSON.stringify(c.ligne)} ${JSON.stringify(c.reponse)} ${String(c.panne)}`;
    expect(await m.decouverte.fetchModels(ligne, { timeout }), ctx).toEqual(c.modeles);
    expect(await m.decouverte.testConnector(ligne, { timeout }), ctx).toEqual(c.test);
  }

  it("modèles, replis (saisie manuelle, catalogue Anthropic), test de connexion, requête", async () => {
    const ferme = `http://127.0.0.1:${await portFerme()}`;
    const lents: CasDecouverte[] = [];
    for (const c of V.decouverte) {
      if ("gratuits" in c) {
        for (const g of c.gratuits) {
          expect(m.decouverte.freeModels(g.fournisseur, g.ids)).toEqual(g.gratuits);
          expect(m.decouverte.decorate({ provider_type: g.fournisseur }, g.ids)).toEqual(g.decore);
        }
        continue;
      }
      if (c.panne === "ReadTimeout") {
        lents.push(c);
        continue;
      }
      if (c.panne === "ConnectError") {
        await rejouer(c, ferme, 4.0);
        continue;
      }
      const chemin = new URL(c.appel[1]).pathname;
      const [statut, corps] = c.reponse ?? [0, null];
      if (corps === null) s.texte(`GET ${chemin}`, "", statut);
      else s.json(`GET ${chemin}`, corps, statut);
      s.requetes.length = 0;
      await rejouer(c, s.url, 4.0);
      const r = s.requetes[0];
      expect(r?.methode).toBe("GET");
      expect(r?.url.pathname).toBe(chemin);
      for (const [k, v] of Object.entries(c.appel[2])) expect(r?.entetes[k.toLowerCase()], k).toBe(v);
    }
    for (const c of lents) s.route(`GET ${new URL(c.appel[1]).pathname}`, () => new Promise(() => undefined));
    expect(lents).toHaveLength(4);
    await Promise.all(lents.map((c) => rejouer(c, s.url, 0.2)));
  });
});
