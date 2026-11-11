// SPDX-License-Identifier: MIT
/** apps/core/test/llm/parametres.test.ts — cascade de sampling (vecteurs Python exhaustifs) et caches de capacités du modèle sur un faux llama-server. */
import "./environnement-fournisseurs";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decoder, lireVecteurs, rejouer } from "../vecteurs-moteur";
import { FauxServeur } from "./faux-serveur";
import { moteurFrais, urlLlama } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

type Dict = Record<string, unknown>;

const maintenantReel = performance.now.bind(performance);

/** Horloge monotone du moteur décalée de `secondes` par rapport au temps réel. */
function plusTard(secondes: number): void {
  vi.spyOn(performance, "now").mockImplementation(() => maintenantReel() + secondes * 1000);
}

interface VecteursParametres {
  constantes: {
    ALLOWED_SAMPLING_KEYS: string[];
    HARDCODED_FALLBACK: Dict;
    TASK_PROFILES: Record<string, Dict>;
    REASONING_EFFORT_KNOWN_VALUES: string[];
  };
  surcharges: ({ entree: unknown; sortie: Dict } | { entree: unknown; erreur: string })[];
  extractions: { props: unknown; extrait: Dict }[];
  cascade: { props: Dict; tache: string; surcharge: unknown; effectif: Dict }[];
  normalisations: { entree: Dict; sortie: Dict }[];
  detections: {
    props: unknown;
    gabarit: unknown;
    effort: string[];
    conserve: boolean;
    pense: Record<string, boolean>;
  }[];
  kwargs: { entree: unknown; effort: string | null; conserve: boolean | null }[];
  degradees: { modele: string | null; tache: string; vue: Dict }[];
}

const V = lireVecteurs<VecteursParametres>("moteur-parametres");
let m: Moteur;
let s: FauxServeur;

beforeAll(async () => {
  s = await FauxServeur.demarrer();
  m = await moteurFrais(urlLlama(s.url));
});

afterAll(async () => {
  await m.fermer();
  await s.arreter();
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  s.requetes.length = 0;
  for (const r of ["GET /props", "GET /metrics", "GET /v1/models"])
    s.route(r, (_q, rep) => {
      rep.writeHead(404);
      rep.end();
    });
  m.caps.invalidate();
  m.parametres.invalidateParamsCache();
});

describe("vecteurs Python", () => {
  it("constantes de la cascade", () => {
    expect([...m.parametres.ALLOWED_SAMPLING_KEYS].sort()).toEqual(V.constantes.ALLOWED_SAMPLING_KEYS);
    expect(m.parametres.HARDCODED_FALLBACK).toEqual(V.constantes.HARDCODED_FALLBACK);
    expect(m.parametres.TASK_PROFILES).toEqual(V.constantes.TASK_PROFILES);
    expect(m.parametres.REASONING_EFFORT_KNOWN_VALUES).toEqual(V.constantes.REASONING_EFFORT_KNOWN_VALUES);
  });

  it("surcharge assainie clé par clé (bornes, textes, booléens, chiffres Unicode, clés hostiles)", () => {
    for (const c of V.surcharges) {
      const ctx = JSON.stringify(c.entree);
      if ("erreur" in c)
        rejouer(() => m.parametres.sanitizeOverride(structuredClone(c.entree)), { erreur: c.erreur }, ctx);
      else expect(m.parametres.sanitizeOverride(structuredClone(c.entree)), ctx).toEqual(decoder(c.sortie));
    }
  });

  it("extraction du sampling de /props sous toutes ses formes", () => {
    for (const c of V.extractions)
      expect(m.parametres.extractSamplingFromProps(c.props), JSON.stringify(c.props)).toEqual(c.extrait);
  });

  it("cascade props < profil de tâche < surcharge (repli prudent sans /props), sentinelles -1 normalisées", async () => {
    for (const c of V.cascade) {
      m.parametres.propsCache.clear();
      m.parametres.propsCache.set("m", structuredClone(c.props));
      const effectif = await m.parametres.resolveSampling("m", c.tache, structuredClone(c.surcharge));
      expect(effectif, JSON.stringify({ ...c, effectif: undefined })).toEqual(c.effectif);
    }
    for (const c of V.normalisations)
      expect(m.parametres.normalizeLastNSentinels({ ...c.entree })).toEqual(c.sortie);
  });

  it("détections : gabarit, reasoning_effort, preserve_reasoning, raisonnement par gabarit ou par nom", () => {
    for (const c of V.detections) {
      const ctx = JSON.stringify(c.props);
      if (typeof c.gabarit === "object" && c.gabarit !== null)
        rejouer(() => m.parametres.propsChatTemplate(c.props), c.gabarit as { erreur: string }, ctx);
      else expect(m.parametres.propsChatTemplate(c.props), ctx).toBe(c.gabarit);
      expect(m.parametres.detectReasoningEffortFromProps(c.props), ctx).toEqual(c.effort);
      expect(m.parametres.detectPreserveReasoningFromProps(c.props), ctx).toBe(c.conserve);
      for (const [nom, pense] of Object.entries(c.pense))
        expect(
          m.parametres.detectThinkingFromProps(c.props, nom === "None" ? null : nom),
          `${ctx} ${nom}`,
        ).toBe(pense);
    }
  });

  it("kwargs de gabarit assainis (reasoning_effort, preserve_reasoning) et vue dégradée du panneau", () => {
    for (const c of V.kwargs) {
      expect(m.parametres.sanitizeReasoningEffort(c.entree), JSON.stringify(c.entree)).toBe(c.effort);
      expect(m.parametres.sanitizePreserveReasoning(c.entree), JSON.stringify(c.entree)).toBe(c.conserve);
    }
    for (const c of V.degradees) {
      const { ignored_keys, engine_label, ...vue } = m.parametres.describeEffectiveParamsDegraded(
        c.modele,
        c.tache,
      );
      expect(vue).toEqual(c.vue);
      expect([Array.isArray(ignored_keys), typeof engine_label]).toEqual([true, "string"]);
    }
  });
});

describe("réglages ignorés par le moteur", () => {
  it("llama.cpp : aucun ; vLLM et SGLang : budget de réflexion ; standard : échantillonnage étendu aussi", () => {
    const ignores = (t: string): unknown => m.parametres.reglagesIgnores(t)["ignored_keys"];
    expect(ignores("llamacpp")).toEqual([]);
    expect(ignores("vllm")).toEqual(["thinking_budget_tokens"]);
    expect(ignores("sglang")).toEqual(["thinking_budget_tokens"]);
    expect(ignores("generic")).toEqual(["top_k", "min_p", "repeat_penalty", "thinking_budget_tokens"]);
    expect(m.parametres.reglagesIgnores("vllm")["engine_label"]).toBe("vLLM");
  });

  it("connecteur Anthropic : réflexion pilotable par l'interrupteur, effort du modèle, pas de budget", () => {
    const vue = m.parametres.describeEffectiveParamsDegraded("claude-opus-5-5", "chat", "anthropic");
    expect(vue["supports_thinking"]).toBe(true);
    expect(vue["supports_reasoning_effort"]).toBe(true);
    expect(vue["reasoning_effort_values"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(vue["ignored_keys"]).toContain("thinking_budget_tokens");
    const sansEffort = m.parametres.describeEffectiveParamsDegraded("claude-haiku-4-5", "chat", "anthropic");
    expect([sansEffort["supports_thinking"], sansEffort["supports_reasoning_effort"]]).toEqual([true, false]);
    expect(sansEffort["reasoning_effort_values"]).toEqual([]);
    expect(
      m.parametres.describeEffectiveParamsDegraded("gpt-x", "chat", "openai")["supports_thinking"],
    ).toBeNull();
  });
});

describe("caches sur le faux llama-server", () => {
  const gabarit =
    "{% if enable_thinking %}<think>{% endif %} reasoning_effort in ['low', 'high'] preserve_thinking";

  it("props : /props?model=X (charge le modèle) puis /props, cache 300 s ; injoignable = {} non retenu", async () => {
    s.json("GET /props", { default_generation_settings: { params: { temperature: 0.4, n_predict: 9 } } });
    expect(await m.parametres.getCachedProps("q")).toEqual({ temperature: 0.4 });
    expect(await m.parametres.getCachedProps("q")).toEqual({ temperature: 0.4 });
    expect(s.sur("/props").map((r) => r.chemin)).toEqual(["/props?model=q"]);
    s.texte("GET /props", "panne", 500);
    expect(await m.parametres.getCachedProps("r")).toEqual({});
    expect(m.parametres.propsCache.has("r")).toBe(false);
    const openai = new m.moteurs.EngineRef({ key: "conn:1", baseRoot: s.url, providerType: "openai" });
    expect(await m.moteurs.useEngine(openai, () => m.parametres.getCachedProps("q"))).toEqual({});
  });

  it("props BRUTES partagées 10 s, lecture en vol attendue et non répétée, routeur sans modèle chargé = {}", async () => {
    s.route("GET /props", async (_q, rep) => {
      await new Promise((ok) => setTimeout(ok, 30));
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ chat_template: gabarit }));
    });
    const [a, b] = await Promise.all([m.parametres.fetchRawProps("q"), m.parametres.fetchRawProps("q")]);
    expect(a).toBe(b);
    expect(await m.parametres.fetchRawProps("q")).toBe(a);
    expect(s.sur("/props")).toHaveLength(1);
    s.json("GET /props", { role: "router" });
    expect(await m.parametres.fetchRawProps("autre")).toEqual({});
    expect(await m.parametres.fetchRawProps("autre", { autoload: false })).toEqual({});
    expect(s.sur("/props").at(-1)?.chemin).toBe("/props?model=autre&autoload=false");
  });

  it("capacités du gabarit : raisonnement, efforts, preserve_reasoning ; en cache par (serveur, modèle)", async () => {
    s.json("GET /props", { chat_template: gabarit });
    expect(await m.parametres.getThinkingSupport("q")).toBe(true);
    expect(await m.parametres.getReasoningEffortValues("q")).toEqual(["low", "high"]);
    expect(await m.parametres.getPreserveReasoningSupport("q")).toBe(true);
    expect(s.sur("/props")).toHaveLength(1);
    s.json("GET /props", { chat_template: "rien" });
    expect(await m.parametres.getThinkingSupport("q")).toBe(true);
    expect(m.parametres.thinkingCache.get("q")).toBe(true);
    const eng = new m.moteurs.EngineRef({ key: "conn:2", baseRoot: s.url });
    expect(await m.moteurs.useEngine(eng, () => m.parametres.getThinkingSupport("q"))).toBe(false);
    expect(m.parametres.thinkingCache.get("conn:2|q")).toBe(false);
    m.parametres.invalidateParamsCache("q");
    expect(m.parametres.thinkingCache.size).toBe(0);
  });

  it("charge utile : effort retenu seulement s'il est accepté, preserve_reasoning seulement si le gabarit l'honore", async () => {
    s.json("GET /props", { chat_template: gabarit });
    const o = {
      targetModel: "q",
      userId: "u",
      samplingParams: {},
      llamaNative: true,
      localLlamacpp: true,
      thinkingMode: true,
      chatId: null,
    };
    const p1 = await m.llamacpp.buildLlamaPayload([{ role: "user", content: "x" }], {
      ...o,
      reasoningEffort: "high",
      preserveReasoning: false,
    });
    expect(p1["chat_template_kwargs"]).toEqual({
      enable_thinking: true,
      reasoning_effort: "high",
      preserve_reasoning: false,
    });
    const p2 = await m.llamacpp.buildLlamaPayload([{ role: "user", content: "x" }], {
      ...o,
      reasoningEffort: "xhigh",
    });
    expect(p2["chat_template_kwargs"]).toEqual({ enable_thinking: true });
  });

  it("continue_final_message : inconnu, noté, expiré ; invalidation par modèle, globale et au changement de modèle", async () => {
    expect(m.parametres.continueFinalSupport("q")).toBeNull();
    m.parametres.noteContinueFinalSupport("q", true);
    plusTard(299);
    expect(m.parametres.continueFinalSupport("q")).toBe(true);
    plusTard(301);
    expect(m.parametres.continueFinalSupport("q")).toBeNull();
    vi.restoreAllMocks();
    m.parametres.noteContinueFinalSupport("q", false);
    expect(m.parametres.continueFinalSupport("q")).toBe(false);
    m.parametres.propsCache.set("q", { temperature: 1 });
    m.parametres.propsCache.set("conn:3|q", { temperature: 1 });
    m.parametres.propsCache.set("", { temperature: 1 });
    m.parametres.propsCache.set("autre", { temperature: 1 });
    m.parametres.invalidateParamsCache("q");
    expect([...m.parametres.propsCache.keys()]).toEqual(["autre"]);
    expect(m.parametres.continueFinalSupport("q")).toBeNull();
    expect(m.modeles.invalidateAllModelCaches()["llm_params_entries_cleared"]).toBe(1);
    m.parametres.propsCache.set("x", {});
    const registre = await import("../../src/llm/registre-caches");
    registre.viderAuChangement();
    expect(m.parametres.propsCache.size).toBe(0);
  });

  it("durées de vie : props 300 s, props brutes partagées 10 s, capacités du gabarit 300 s", async () => {
    s.json("GET /props", {
      default_generation_settings: { params: { temperature: 0.4 } },
      chat_template: gabarit,
    });
    const lectures = () => s.sur("/props").length;
    await m.parametres.getCachedProps("q");
    await m.parametres.getThinkingSupport("t");
    expect(lectures()).toBe(2);
    plusTard(9);
    await m.parametres.fetchRawProps("t");
    expect(lectures()).toBe(2);
    plusTard(11);
    await m.parametres.getThinkingSupport("t");
    await m.parametres.getCachedProps("q");
    expect(lectures()).toBe(2);
    await m.parametres.fetchRawProps("t");
    expect(lectures()).toBe(3);
    plusTard(299);
    await m.parametres.getCachedProps("q");
    expect(lectures()).toBe(3);
    plusTard(301);
    await m.parametres.getCachedProps("q");
    expect(lectures()).toBe(4);
    await m.parametres.getReasoningEffortValues("t");
    expect(lectures()).toBe(5);
  });

  it("capacités du moteur : build lu gardé 300 s, sonde sans build relue après 10 s", async () => {
    s.json("GET /props", { build_info: "b10545-x", role: "router" });
    expect((await m.caps.engineCaps()).isRouter).toBe(true);
    plusTard(299);
    await m.caps.engineCaps();
    expect(s.sur("/props")).toHaveLength(1);
    plusTard(301);
    await m.caps.engineCaps();
    expect(s.sur("/props")).toHaveLength(2);
    vi.restoreAllMocks();
    m.caps.invalidate();
    s.json("GET /props", {});
    expect((await m.caps.engineCaps()).known).toBe(false);
    plusTard(9);
    await m.caps.engineCaps();
    expect(s.sur("/props")).toHaveLength(3);
    plusTard(11);
    await m.caps.engineCaps();
    expect(s.sur("/props")).toHaveLength(4);
  });

  it("panneau Sampling : sources par paramètre ; /props absent = repli signalé, jamais de chargement", async () => {
    s.json("GET /props", {
      default_generation_settings: { params: { temperature: 0.4, top_k: 40 } },
      chat_template: "x",
    });
    const vue = await m.parametres.describeEffectiveParams("q", "tools", { top_k: 5, seed: 3 });
    expect(vue).toMatchObject({
      props_unavailable: false,
      supports_thinking: false,
      supports_reasoning_effort: false,
      supports_preserve_reasoning: false,
      supports_continue_final_message: null,
      effective: { ...V.constantes.TASK_PROFILES["tools"], top_k: 5, seed: 3 },
    });
    expect((vue["param_sources"] as Dict)["top_k"]).toBe("user_override");
    expect(s.sur("/props").every((r) => r.chemin === "/props" || r.chemin.endsWith("&autoload=false"))).toBe(
      true,
    );
    m.parametres.invalidateParamsCache();
    s.texte("GET /props", "non", 404);
    const degrade = await m.parametres.describeEffectiveParams(null, "chat");
    expect(degrade["props_unavailable"]).toBe(true);
    expect((degrade["param_sources"] as Dict)["temperature"]).toBe(
      "temperature" in (V.constantes.TASK_PROFILES["chat"] ?? {}) ? "task_profile" : "fallback",
    );
  });
});
