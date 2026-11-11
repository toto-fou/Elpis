// SPDX-License-Identifier: MIT
/** apps/core/test/llm/fournisseurs/llama.test.ts — llama.cpp : parité des payloads (goldens Python), flux SSE rejoués (vecteurs et HTTP), capacités, inventaire, sessions reprenables. */
import "../environnement-fournisseurs";

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@elpis/commun";

import type { DecoupeurPensee, SseStreamResult } from "../../../src/llm/fournisseurs/llamacpp";
import { lireVecteurs } from "../../vecteurs-moteur";
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

interface VecteursFournisseurs {
  llama: {
    filets: { entree: unknown[]; ancre: unknown[]; fusion: unknown[] }[];
    erreurs_sse: ({ entree: unknown } & Erreur)[];
    ancre: string;
  };
  llama_flux: {
    nom: string;
    lignes: string[];
    erreur: Erreur | null;
    evenements: unknown[];
    resultat: Dict;
  }[];
  capacites: {
    builds: { brut: unknown; build: number }[];
    proprietes: {
      connu: boolean;
      build: number;
      routeur: boolean;
      proprietes: Record<string, boolean>;
      description: string;
    }[];
    bases: { url: string; base: string }[];
  };
  inventaires: { corps: unknown; illisible: boolean; statut: number; statuts: Record<string, string> }[];
  telechargements: ({ entree: unknown; fraction: number | null } | { entree: unknown; erreur: string })[];
  sessions: { chat: unknown; usage: string; id: string }[];
}

const V = lireVecteurs<VecteursFournisseurs>("moteur-fournisseurs");
const GOLDENS = new URL("../../../../../tests/goldens/", import.meta.url);
let m: Moteur;
let s: FauxServeur;

/** Le découpeur minimal du générateur Python : balises entières dans un morceau. */
class Decoupeur implements DecoupeurPensee {
  inThink = false;

  feed(morceau: string): [string, string][] {
    const sortie: [string, string][] = [];
    let reste = morceau;
    while (reste) {
      const balise = this.inThink ? "</think>" : "<think>";
      const i = reste.indexOf(balise);
      const genre = this.inThink ? "thinking" : "content";
      if (i < 0) {
        sortie.push([genre, reste]);
        break;
      }
      if (i > 0) sortie.push([genre, reste.slice(0, i)]);
      reste = reste.slice(i + balise.length);
      this.inThink = !this.inThink;
    }
    return sortie;
  }

  flush(): [string, string][] {
    return [];
  }
}

beforeAll(async () => {
  s = await FauxServeur.demarrer();
  m = await moteurFrais(urlLlama(s.url));
});

afterAll(async () => {
  await m.fermer();
  await s.arreter();
});

beforeEach(() => {
  s.requetes.length = 0;
  for (const r of ["GET /props", "GET /slots", "GET /metrics", "GET /v1/models", "GET /health"])
    s.route(r, (_q, rep) => {
      rep.writeHead(404);
      rep.end();
    });
  m.caps.invalidate();
  m.modeles.invalidateContextSizeCache();
  m.modeles.invalidateTotalSlotsCache();
  m.modeles.poserSlotsOccupes(null, 0);
  m.inventaire.viderInventaires();
  m.sante.loadedModelCache.ts = 0;
  m.inventaire.poserClientSse(
    (t) => new m.client.ClientHttp({ delais: m.client.delais(t, { connect: 5, read: t }) }),
  );
});

function erreurDe(e: unknown): Erreur {
  const x = e as Error & { response?: { statusCode: number; text: string } };
  const sortie: Erreur = { type: x.name, message: x.message };
  if (x.response) {
    sortie.statut = x.response.statusCode;
    sortie.corps = x.response.text;
  }
  return sortie;
}

function resultatDe(r: SseStreamResult): Dict {
  return {
    content: r.content(),
    thinking: r.thinking(),
    outils: r.builtToolCalls(),
    usage: r.usage,
    timings: r.timings,
    finish_reason: r.finishReason,
    in_think: r.inThink,
    pre_emis: r.streamPreEmittedThinking,
    reroute: r.reroutedThinkChars,
    completion_id: r.completionId,
    progression: r.promptProgress,
  };
}

async function consommer(flux: {
  aiterLines(): AsyncIterable<string>;
  aclose(): Promise<void>;
}): Promise<{ resultat: Dict; erreur: Erreur | null; evenements: unknown[] }> {
  const evenements: unknown[] = [];
  const puits = new m.llamacpp.SseStreamResult();
  let erreur: Erreur | null = null;
  try {
    await m.llamacpp.consumeLlamaSse(flux, {
      tagSplitter: new Decoupeur(),
      reqId: "r1",
      userId: "u",
      onThinkingToken: (t) => void evenements.push(["pense", t]),
      onContentToken: (t) => void evenements.push(["contenu", t]),
      onToolCallDelta: (i, n, a) => void evenements.push(["outil", i, n, a]),
      onPromptProgress: (p) => void evenements.push(["progres", p]),
      sink: puits,
    });
  } catch (e) {
    erreur = erreurDe(e);
  }
  return { resultat: resultatDe(puits), erreur, evenements };
}

/** Flux SSE d'un delta `tool_calls` par ligne. */
function fluxOutils(deltas: Dict[]): { aiterLines(): AsyncIterable<string>; aclose(): Promise<void> } {
  const lignes = deltas.map(
    (tc) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] })}`,
  );
  return {
    async *aiterLines() {
      yield* lignes;
    },
    aclose: () => Promise.resolve(),
  };
}

describe("parité des payloads avec les goldens Python", () => {
  const cas: [string, { modele?: string; chat: string | null; pense: boolean }][] = [
    ["classic", { chat: null, pense: false }],
    ["native_2iter", { chat: "golden-chat", pense: false }],
    ["thinking_tools", { chat: "golden-chat", pense: true }],
    ["compression_carrier", { chat: "golden-chat", pense: false }],
    ["fold_fs", { chat: "golden-chat", pense: false }],
  ];
  for (const [nom, o] of cas) {
    it(`payload_${nom} : identique au golden après canonicalJson (clés triées, comme le harnais Python)`, async () => {
      s.json("GET /props", {});
      const fichier = readFileSync(new URL(`payload_${nom}.json`, GOLDENS), "utf-8");
      const goldens = (JSON.parse(fichier) as { sortie: Dict[] }).sortie;
      for (const golden of goldens) {
        const p = await m.llamacpp.buildLlamaPayload(structuredClone(golden["messages"]) as unknown[], {
          targetModel: golden["model"] as string,
          userId: golden["user"],
          samplingParams: {},
          llamaNative: true,
          localLlamacpp: true,
          thinkingMode: o.pense,
          chatId: o.chat,
        });
        if ("tools" in golden)
          Object.assign(p, { tools: golden["tools"], tool_choice: golden["tool_choice"] });
        expect(canonicalJson(m.openai.sanitizePayload(p, { providerType: "llamacpp", model: "" }))).toBe(
          canonicalJson(golden),
        );
      }
    });
  }

  it("variantes : build ancien lu (pas de champs récents), cible OpenAI (squelette nu), slot épinglé, budget de réflexion (llama.cpp seul), suite d'un raisonnement", async () => {
    s.json("GET /props", {
      build_info: "b6120-x",
      total_slots: 4,
      default_generation_settings: { n_ctx: 8192 },
    });
    m.modeles.setCachedTotalSlots(4);
    const base = {
      targetModel: "m",
      userId: 7,
      samplingParams: { temperature: 0.2 },
      chatId: "c",
      thinkingMode: false,
    };
    const ancien = await m.llamacpp.buildLlamaPayload([{ role: "user", content: "x" }], {
      ...base,
      llamaNative: true,
      localLlamacpp: true,
    });
    expect(ancien).not.toHaveProperty("return_progress");
    expect(ancien).not.toHaveProperty("sse_ping_interval");
    expect(ancien["id_slot"]).toBe(m.constantes.resolveSlotId("c", 4, new Set()));
    const attendu: Dict = { max_tokens: 0 };
    m.constantes.clampGenerationBudget(attendu, { temperature: 0.2 }, false, 8192);
    expect(ancien["max_tokens"]).toBe(attendu["max_tokens"]);
    expect(ancien).not.toHaveProperty("thinking_budget_tokens");
    const borne = await m.llamacpp.buildLlamaPayload([{ role: "user", content: "x" }], {
      ...base,
      llamaNative: true,
      localLlamacpp: true,
      reasoningBudget: 64,
    });
    expect(borne["thinking_budget_tokens"]).toBe(64);
    const distant = await m.llamacpp.buildLlamaPayload([{ role: "user", content: "x" }], {
      ...base,
      llamaNative: false,
      localLlamacpp: false,
      reasoningBudget: 64,
    });
    expect(distant).toEqual({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      user: "7",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
    });
    const suite = await m.llamacpp.buildLlamaPayload(
      [
        { role: "user", content: "x" },
        { role: "assistant", content: " ", reasoning_content: "je" },
      ],
      { ...base, llamaNative: true, localLlamacpp: false },
    );
    expect(suite).toMatchObject({ continue_final_message: true, add_generation_prompt: false });
    await expect(
      m.llamacpp.buildLlamaPayload(
        [
          { role: "user", content: "x" },
          { role: "assistant", content: [1], reasoning_content: "r" },
        ],
        {
          ...base,
          llamaNative: true,
          localLlamacpp: false,
        },
      ),
    ).rejects.toMatchObject({ type: "AttributeError" });
  });
});

describe("vecteurs Python : formes pures", () => {
  it("filets du gabarit : ancre user posée après les system, assistants finaux fusionnés", () => {
    expect(m.llamacpp.STRICT_TEMPLATE_ANCHOR).toBe(V.llama.ancre);
    for (const c of V.llama.filets) {
      expect(m.llamacpp.ensureUserQuery(structuredClone(c.entree)), JSON.stringify(c.entree)).toEqual(
        c.ancre,
      );
      expect(m.llamacpp.coalesceTrailingAssistants(structuredClone(c.entree))).toEqual(c.fusion);
    }
  });

  it("événement d'erreur SSE → ProviderError (statut, corps, message)", () => {
    for (const c of V.llama.erreurs_sse) {
      const { entree, ...attendu } = c;
      expect(erreurDe(m.llamacpp.sseError(structuredClone(entree))), JSON.stringify(entree)).toEqual(attendu);
    }
    expect(m.llamacpp.sseError({ type: "constructor" }).response.statusCode).toBe(500);
    expect(m.llamacpp.sseError({ code: "toString" }).response.statusCode).toBe(500);
    expect(m.llamacpp.sseError({ code: "٤٢٩" }).response.statusCode).toBe(429);
    expect(() => m.llamacpp.sseError({ code: "²" })).toThrow(expect.objectContaining({ type: "ValueError" }));
  });

  it("capacités : numéro de build, propriétés selon la preuve, racine du serveur", () => {
    for (const c of V.capacites.builds)
      expect(m.caps.parseBuild(c.brut), JSON.stringify(c.brut)).toBe(c.build);
    const noms: Record<string, keyof InstanceType<typeof m.caps.EngineCaps>> = {
      resumable_stream: "resumableStream",
      reasoning_control: "reasoningControl",
      payload_return_progress: "payloadReturnProgress",
      payload_sse_ping: "payloadSsePing",
      payload_reasoning_control: "payloadReasoningControl",
      models_api: "modelsApi",
      models_sse: "modelsSse",
      autoload_param: "autoloadParam",
    };
    for (const c of V.capacites.proprietes) {
      const caps = new m.caps.EngineCaps({ known: c.connu, build: c.build, isRouter: c.routeur });
      for (const [py, ts] of Object.entries(noms))
        expect(caps[ts], `${py} ${JSON.stringify(c)}`).toBe(c.proprietes[py]);
      expect(caps.describe()).toBe(c.description);
    }
    for (const c of V.capacites.bases) expect(m.caps.baseServeur(c.url)).toBe(c.base);
  });

  it("progression de téléchargement en fraction", () => {
    for (const c of V.telechargements) {
      if ("erreur" in c) expect(() => m.inventaire.downloadPct(c.entree)).toThrow();
      else expect(m.inventaire.downloadPct(c.entree), JSON.stringify(c.entree)).toBe(c.fraction);
    }
  });

  it("identifiant de session reprenable : HMAC du secret d'instance (demi-paire remplacée)", () => {
    for (const c of V.sessions)
      expect(m.flux.conversationId("u", c.chat, c.usage), JSON.stringify(c)).toBe(c.id);
    expect(m.flux.headersWithConv({ a: "1" }, "")).toEqual({ a: "1" });
    expect(m.flux.headersWithConv(null, "abc")).toEqual({ "X-Conversation-Id": "abc" });
  });
});

describe("flux SSE de llama-server", () => {
  it("vecteurs rejoués ligne à ligne : événements, résultat partiel et erreur identiques à Python", async () => {
    for (const c of V.llama_flux) {
      const lignes = c.lignes;
      const r = await consommer({
        async *aiterLines() {
          yield* lignes;
        },
        aclose: () => Promise.resolve(),
      });
      expect(r.erreur, c.nom).toEqual(c.erreur);
      expect(r.evenements, c.nom).toEqual(c.evenements);
      expect(r.resultat, c.nom).toEqual(c.resultat);
    }
  });

  it("mêmes vecteurs servis en SSE par HTTP (lignes vides, morceaux arbitraires) : même résultat", async () => {
    const client = new m.client.ClientHttp();
    try {
      for (const c of V.llama_flux) {
        s.route("POST /v1/chat/completions", async (_q, rep) => {
          rep.writeHead(200, { "content-type": "text/event-stream" });
          const texte = c.lignes.map((l) => `${l}\r\n\r\n`).join("");
          for (let i = 0; i < texte.length; i += 7) rep.write(texte.slice(i, i + 7));
          rep.end();
        });
        const flux = await client.stream("POST", `${s.url}/v1/chat/completions`, { json: {} });
        try {
          const r = await consommer(flux);
          expect(r.erreur, c.nom).toEqual(c.erreur);
          expect(r.evenements, c.nom).toEqual(c.evenements);
          expect(r.resultat, c.nom).toEqual(c.resultat);
        } finally {
          await flux.aclose();
        }
      }
    } finally {
      await client.aclose();
    }
  });

  it("annulation en cours de flux : connexion fermée (le serveur la voit), CancelledError, partiel gardé", async () => {
    s.sse(
      "POST /v1/chat/completions",
      ['data: {"choices":[{"delta":{"content":"a"}}]}', 'data: {"choices":[{"delta":{"content":"b"}}]}'],
      {
        delaiMs: 60,
        ouvert: true,
      },
    );
    const client = new m.client.ClientHttp();
    const flux = await client.stream("POST", `${s.url}/v1/chat/completions`, { json: {} });
    const puits = new m.llamacpp.SseStreamResult();
    let stop = false;
    await expect(
      m.llamacpp.consumeLlamaSse(flux, {
        tagSplitter: new Decoupeur(),
        reqId: "r",
        userId: "u",
        isCancelled: () => stop,
        onContentToken: () => {
          stop = true;
        },
        sink: puits,
      }),
    ).rejects.toBeInstanceOf(m.client.CancelledError);
    expect(puits.content()).toBe("a");
    await new Promise((ok) => setTimeout(ok, 50));
    expect(s.deconnexions).toBe(1);
    await client.aclose();
  });

  it("fin de flux : appel versé au suivi des exécutions quand il est posé", async () => {
    const vus: unknown[] = [];
    m.ports.installerExecutions({ ajouterAppelLlm: (t) => void vus.push(t) });
    try {
      await consommer({
        async *aiterLines() {
          yield 'data: {"choices":[],"timings":{"cache_n":2}}';
        },
        aclose: () => Promise.resolve(),
      });
      expect(vus).toEqual([{ cache_n: 2 }]);
    } finally {
      m.ports.installerExecutions(null);
    }
  });

  it("SGLang réutilise l'index 0 avec un nouvel id et un nom : deux appels distincts, aux bons noms et arguments", async () => {
    const r = await consommer(
      fluxOutils([
        { index: 0, id: "call_a", function: { name: "read_file", arguments: "" } },
        { index: 0, function: { arguments: '{"path":"a.txt"}' } },
        { index: 0, id: "call_b", function: { name: "list_dir", arguments: "" } },
        { index: 0, function: { arguments: '{"path":"."}' } },
      ]),
    );
    expect(r.resultat["outils"]).toEqual([
      { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      { id: "call_b", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
    ]);
    expect(r.evenements).toEqual([
      ["outil", 0, "read_file", ""],
      ["outil", 0, "", '{"path":"a.txt"}'],
      ["outil", 1, "list_dir", ""],
      ["outil", 1, "", '{"path":"."}'],
    ]);
  });

  it("id répété à chaque delta ou donné au seul premier (llama.cpp, vLLM) : un appel par index, comme avant", async () => {
    for (const repete of [true, false]) {
      const id = (v: string): Dict => (repete ? { id: v } : {});
      const r = await consommer(
        fluxOutils([
          { index: 0, id: "call_a", function: { name: "read_file", arguments: "" } },
          { index: 0, ...id("call_a"), function: { arguments: '{"pa' } },
          { index: 0, ...id("call_a"), function: { arguments: 'th":"a"}' } },
          { index: 1, id: "call_b", function: { name: "list_dir", arguments: "" } },
          { index: 1, ...id("call_b"), function: { arguments: "{}" } },
        ]),
      );
      expect(r.resultat["outils"], String(repete)).toEqual([
        { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
        { id: "call_b", type: "function", function: { name: "list_dir", arguments: "{}" } },
      ]);
      expect(
        r.evenements.map((e) => (e as unknown[])[1]),
        String(repete),
      ).toEqual([0, 0, 0, 1, 1]);
    }
  });

  it("tool_call_delta porte le numéro d'Elpis (ordre d'ouverture), pas l'index du moteur", async () => {
    const r = await consommer(
      fluxOutils([
        { index: 3, id: "call_x", function: { name: "list_dir", arguments: "{}" } },
        { index: 1, id: "call_y", function: { name: "read_file", arguments: '{"path":"a"}' } },
      ]),
    );
    expect(r.evenements).toEqual([
      ["outil", 0, "list_dir", "{}"],
      ["outil", 1, "read_file", '{"path":"a"}'],
    ]);
    expect((r.resultat["outils"] as Dict[]).map((t) => t["id"])).toEqual(["call_x", "call_y"]);
  });
});

describe("modèles d'un routeur llama.cpp", () => {
  function routeur(): void {
    s.json("GET /props", { build_info: "b10545-abc", role: "router" });
  }

  it("inventaire (vecteurs Python) : statuts, échec = vide mémorisé 3 s", async () => {
    for (const c of V.inventaires) {
      if (c.illisible) s.texte("GET /v1/models", "pas du json{", c.statut);
      else s.json("GET /v1/models", c.corps, c.statut);
      const st = await m.inventaire.modelStatuses("", true);
      expect(Object.fromEntries(st), `${c.statut} ${JSON.stringify(c.corps)}`).toEqual(c.statuts);
    }
    s.json("GET /v1/models", { data: [{ id: "a", status: { value: "loaded" } }] });
    await m.inventaire.modelStatuses("", true);
    s.json("GET /v1/models", { data: [] });
    expect(Object.fromEntries(await m.inventaire.modelStatuses())).toEqual({ a: "loaded" });
    expect(await m.inventaire.isLoaded("a")).toBe(true);
    expect(await m.inventaire.isLoaded("b")).toBe(false);
    expect(await m.inventaire.isLoaded("")).toBeNull();
    m.inventaire.invalidateStatuses();
    expect(await m.inventaire.isLoaded("a")).toBeNull();
  });

  it("connecteur : son propre cache et sa clé ; hors llama.cpp = vide sans requête", async () => {
    const autre = await FauxServeur.demarrer();
    try {
      autre.json("GET /v1/models", { data: [{ id: "z", status: "loaded" }] });
      const eng = new m.moteurs.EngineRef({
        key: "conn:6",
        baseRoot: autre.url,
        headers: [["Authorization", "Bearer k6"]],
      });
      const st = await m.moteurs.useEngine(eng, () => m.inventaire.modelStatuses());
      expect(Object.fromEntries(st)).toEqual({ z: "loaded" });
      expect(autre.requetes[0]?.entetes["authorization"]).toBe("Bearer k6");
      expect(m.inventaire.cachesAutres.get("conn:6")?.data.get("z")).toBe("loaded");
      const openai = new m.moteurs.EngineRef({ key: "conn:7", baseRoot: autre.url, providerType: "openai" });
      expect((await m.inventaire.modelStatuses("", true, { engine: openai })).size).toBe(0);
      expect(autre.requetes).toHaveLength(1);
    } finally {
      await autre.arreter();
    }
  });

  it("charger / décharger : seulement avec l'API de modèles (routeur prouvé), corps {model}", async () => {
    expect(await m.inventaire.loadModel("q")).toBe(false);
    expect(s.sur("/models/load")).toHaveLength(0);
    routeur();
    m.caps.invalidate();
    s.json("POST /models/load", { success: true });
    s.texte("POST /models/unload", "non", 400);
    expect(await m.inventaire.loadModel("q")).toBe(true);
    expect(s.sur("/models/load")[0]?.json()).toEqual({ model: "q" });
    expect(await m.inventaire.unloadModel("q")).toBe(false);
  });

  it("suivi réel d'un chargement sur /models/sse : progression, chargé, échec, flux indisponible", async () => {
    routeur();
    s.json("GET /v1/models", { data: [{ id: "q", status: { value: "unloaded" } }] });
    const evenements = (statut: string) => [
      'data: {"model": "autre", "event": "status_change", "data": {"status": "loaded"}}',
      'data: {"model": "q", "event": "download_progress", "data": {"progress": {"u": {"done": 1, "total": 4}}}}',
      'data: {"model": "q", "event": "status_change", "data": {"status": "loading", "progress": {"value": 0.5, "stages": ["a", "b"], "current": "b"}}}',
      "data: pas du json",
      `data: {"model": "q", "event": "model_status", "data": {"status": "${statut}"}}`,
    ];
    s.sse("GET /models/sse", evenements("loaded"), { ouvert: true });
    const progression: unknown[] = [];
    expect(await m.inventaire.watchLoad("q", "", (e, p, l) => void progression.push([e, p, l]))).toBe(true);
    expect(progression).toEqual([
      ["download", 25, ["download"]],
      ["b", 50, ["a", "b"]],
    ]);
    s.sse("GET /models/sse", evenements("failed"));
    expect(await m.inventaire.watchLoad("q")).toBe(false);
    s.sse("GET /models/sse", []);
    expect(await m.inventaire.watchLoad("q")).toBeNull();
    s.texte("GET /models/sse", "non", 404);
    expect(await m.inventaire.watchLoad("q")).toBeNull();
    s.json("GET /v1/models", { data: [{ id: "q", status: { value: "loaded" } }] });
    s.sse("GET /models/sse", [], { ouvert: true });
    const clients: InstanceType<typeof m.client.ClientHttp>[] = [];
    m.inventaire.poserClientSse((t) => {
      const c = new m.client.ClientHttp({ delais: m.client.delais(t, { connect: 5, read: t }) });
      clients.push(c);
      return c;
    });
    const avant = s.deconnexions;
    expect(await m.inventaire.watchLoad("q")).toBe(true);
    expect(clients.map((c) => c.isClosed)).toEqual([true]);
    await attendre(30);
    expect(s.deconnexions).toBe(avant + 1);
    expect(await m.inventaire.watchLoad("")).toBeNull();
  });

  it("suivi annulable ; sans preuve de /models/sse, aucun suivi", async () => {
    expect(await m.inventaire.watchLoad("q")).toBeNull();
    expect(s.sur("/models/sse")).toHaveLength(0);
    routeur();
    m.caps.invalidate();
    s.json("GET /v1/models", { data: [] });
    s.sse("GET /models/sse", [], { ouvert: true });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await expect(m.inventaire.watchLoad("q", "", null, { signal: ctl.signal })).rejects.toBeInstanceOf(
      m.client.CancelledError,
    );
  });
});

describe("flux reprenable : recherche, reprise, arrêt, fin du raisonnement", () => {
  it("lookup, reprise depuis un octet, DELETE (404 = déjà fini), reasoning_end", async () => {
    s.json("POST /v1/streams/lookup", [{ conversation_id: "c1", bytes: 10 }, { conversation_id: "" }, "x"]);
    const client = new m.client.ClientHttp();
    try {
      const vivants = await m.flux.lookupStreams(client, `${s.url}/`, ["c1", "c2"], "q", {
        headers: { "X-A": "1" },
      });
      expect([...vivants.entries()]).toEqual([["c1", { conversation_id: "c1", bytes: 10 }]]);
      expect(s.sur("/v1/streams/lookup")[0]?.json()).toEqual({ conversation_ids: ["c1", "c2"], model: "q" });
      expect(s.sur("/v1/streams/lookup")[0]?.entetes["x-a"]).toBe("1");
      expect((await m.flux.lookupStreams(client, s.url, [])).size).toBe(0);
      s.sse("GET /v1/stream", ["data: rejoue"]);
      const reprise = await m.flux.resumeRequest(client, s.url, "c1", "q x", 12.9);
      const lignes: string[] = [];
      for await (const l of reprise.aiterLines()) lignes.push(l);
      expect(lignes).toEqual(["data: rejoue", ""]);
      expect(s.sur("/v1/stream")[0]?.chemin).toBe("/v1/stream?conv_id=c1&from=12&model=q+x");
      for (const [statut, ok] of [
        [200, true],
        [204, true],
        [404, true],
        [500, false],
      ] as const) {
        s.texte("DELETE /v1/stream", "", statut);
        expect(await m.flux.cancelStream(client, s.url, "c1", "q"), String(statut)).toBe(ok);
      }
      expect(await m.flux.cancelStream(client, s.url, "")).toBe(false);
      s.json("POST /v1/chat/completions/control", { success: true });
      expect(await m.flux.endReasoning(client, s.url, "cmpl-1", "q")).toBe(true);
      expect(s.sur("/v1/chat/completions/control")[0]?.json()).toEqual({
        id: "cmpl-1",
        action: "reasoning_end",
        model: "q",
      });
      s.json("POST /v1/chat/completions/control", { success: false });
      expect(await m.flux.endReasoning(client, s.url, "cmpl-1")).toBe(false);
      expect(await m.flux.endReasoning(client, s.url, "")).toBe(false);
      const mort = `http://127.0.0.1:${await portFerme()}`;
      expect((await m.flux.lookupStreams(client, mort, ["c"])).size).toBe(0);
      expect(await m.flux.cancelStream(client, mort, "c")).toBe(false);
      expect(await m.flux.endReasoning(client, mort, "c")).toBe(false);
    } finally {
      await client.aclose();
    }
  });

  it("reprise sans délai explicite (null) : les délais du client s'appliquent, jamais « sans limite »", async () => {
    s.route("GET /v1/stream", () => new Promise(() => undefined));
    const client = new m.client.ClientHttp({ delais: m.client.delais(0.3) });
    try {
      await expect(m.flux.resumeRequest(client, s.url, "c1", "", 0, null)).rejects.toBeInstanceOf(
        m.client.ReadTimeout,
      );
    } finally {
      await client.aclose();
    }
  });

  it("signe de vie : par (serveur, modèle)", () => {
    m.flux.noteAliveSignal("q");
    expect(m.flux.hasAliveSignal("q")).toBe(true);
    const eng = new m.moteurs.EngineRef({ key: "conn:8", baseRoot: "http://x" });
    expect(m.moteurs.useEngine(eng, () => m.flux.hasAliveSignal("q"))).toBe(false);
    m.moteurs.useEngine(eng, () => m.flux.noteAliveSignal("q"));
    expect([...m.flux.ALIVE_SIGNAL.keys()]).toEqual(["q", "conn:8|q"]);
    m.flux.noteAliveSignal("");
    expect(m.flux.ALIVE_SIGNAL.size).toBe(2);
  });
});
