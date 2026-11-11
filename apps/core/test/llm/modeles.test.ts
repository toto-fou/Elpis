// SPDX-License-Identifier: MIT
/** apps/core/test/llm/modeles.test.ts — fenêtre et slots (caches à TTL), invalidations, fenêtre des cibles distantes, cycle de vie, capacités, état diffusé des modèles. */
import "./environnement-fournisseurs";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { attendre, FauxServeur, portFerme } from "./faux-serveur";
import { moteurFrais, urlLlama } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

type Dict = Record<string, unknown>;

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

function absent(cle: string): void {
  s.route(cle, (_q, rep) => {
    rep.writeHead(404);
    rep.end();
  });
}

beforeEach(() => {
  s.requetes.length = 0;
  for (const r of ["GET /props", "GET /slots", "GET /metrics", "GET /v1/models", "GET /health", "GET /"])
    absent(r);
  m.caps.invalidate();
  m.modeles.invalidateContextSizeCache();
  m.modeles.invalidateTotalSlotsCache();
  m.modeles.poserSlotsOccupes(null, 0);
  m.modeles.slotsBusyOther.clear();
  m.fenetre.invalidateCache();
  m.sante.loadedModelCache.ts = 0;
  m.sante.loadedModelCache.id = null;
  delete process.env["LLAMA_N_CTX_PER_SLOT"];
  delete process.env["LLM_REMOTE_N_CTX"];
});

afterEach(() => {
  m.ports.installerConnecteurs(null);
  m.ports.installerDiffusion(null);
  m.ports.installerAccesMoteurs(null);
  m.cacheModeles.arreterSondeModeles();
});

function connecteurs(metas: Record<number, unknown>, appels: number[] = []): void {
  m.ports.installerConnecteurs({
    getSecretForUser: () => Promise.resolve(null),
    bumpLastUsed: () => Promise.resolve(),
    getMeta: (id) => {
      appels.push(id);
      return Promise.resolve((metas[id] ?? null) as never);
    },
    allowedProviderTypes: () => ["llamacpp", "openai", "opencode", "anthropic"],
  });
}

describe("fenêtre par slot et slots", () => {
  it("LLAMA_N_CTX_PER_SLOT prime ; invalide = ignoré ; cache 300 s par (serveur, modèle)", async () => {
    s.json("GET /props", { default_generation_settings: { n_ctx: 8192 } });
    process.env["LLAMA_N_CTX_PER_SLOT"] = " 4096 ";
    expect(await m.modeles.getModelContextSize("m")).toBe(4096);
    m.modeles.invalidateContextSizeCache();
    process.env["LLAMA_N_CTX_PER_SLOT"] = "abc";
    expect(await m.modeles.getModelContextSize("m")).toBe(8192);
    delete process.env["LLAMA_N_CTX_PER_SLOT"];
    s.json("GET /props", { default_generation_settings: { n_ctx: 1 } });
    expect(await m.modeles.getModelContextSize("m")).toBe(8192);
    m.modeles.cachedContextSizeTs.set("m", m.http.monotonic() - 301);
    expect(await m.modeles.getModelContextSize("m")).toBe(1);
    expect(s.sur("/props").map((r) => r.chemin)).toEqual([
      "/props",
      "/props?model=m&autoload=false",
      "/props?model=m&autoload=false",
    ]);
  });

  it("/metrics ÷ slots quand /props se tait ; slots inconnus = ÷ concurrence déclarée, NON caché", async () => {
    s.texte("GET /metrics", "llamacpp:n_ctx_total 16384\n");
    s.route("GET /props", (q, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify(q.url.searchParams.has("model") ? {} : { total_slots: 4 }));
    });
    expect(await m.modeles.getModelContextSize("m")).toBe(4096);
    s.json("GET /props", {});
    m.modeles.invalidateContextSizeCache();
    m.modeles.invalidateTotalSlotsCache();
    expect(await m.modeles.getModelContextSize("m")).toBe(16384 / 4);
    expect(m.modeles.cachedContextSize.size).toBe(0);
  });

  it("cible hors llama.cpp : 0 sans requête ; slots du connecteur sous sa propre clé", async () => {
    const openai = new m.moteurs.EngineRef({ key: "conn:1", baseRoot: s.url, providerType: "openai" });
    expect(await m.moteurs.useEngine(openai, () => m.modeles.getModelContextSize("m"))).toBe(0);
    expect(await m.moteurs.useEngine(openai, () => m.modeles.getModelTotalSlots("m"))).toBe(0);
    expect(await m.moteurs.useEngine(openai, () => m.modeles.getBusySlotsSnapshot())).toBeNull();
    expect(s.requetes).toHaveLength(0);
    const autre = await FauxServeur.demarrer();
    try {
      autre.json("GET /props", { total_slots: 3 });
      const eng = new m.moteurs.EngineRef({ key: "conn:2", baseRoot: autre.url });
      expect(await m.moteurs.useEngine(eng, () => m.modeles.getModelTotalSlots("m"))).toBe(3);
      expect(m.modeles.totalSlotsCache.get("conn:2|m")?.[0]).toBe(3);
      expect(m.modeles.getCachedTotalSlots()).toBe(0);
    } finally {
      await autre.arreter();
    }
  });

  it("vue « dernier connu » des slots : posée à la main, respectée tant que le cache par modèle est vide", async () => {
    m.modeles.setCachedTotalSlots(6);
    expect(await m.modeles.getModelTotalSlots()).toBe(6);
    expect(s.requetes).toHaveLength(0);
    s.json("GET /props", { total_slots: 2 });
    expect(await m.modeles.getModelTotalSlots("q")).toBe(2);
    expect(m.modeles.getCachedTotalSlots()).toBe(2);
  });

  it("slots occupés : instantané 2 s, échec mémorisé 30 s en gardant le dernier connu", async () => {
    s.json("GET /slots", [{ id: 1, is_processing: true }]);
    expect([...((await m.modeles.getBusySlotsSnapshot()) ?? [])]).toEqual([1]);
    s.json("GET /slots", []);
    expect([...((await m.modeles.getBusySlotsSnapshot()) ?? [])]).toEqual([1]);
    m.modeles.poserSlotsOccupes(m.modeles.etatSlotsOccupes()[0], 0);
    s.texte("GET /slots", "panne", 500);
    expect([...((await m.modeles.getBusySlotsSnapshot()) ?? [])]).toEqual([1]);
    expect(m.modeles.etatSlotsOccupes()[1] - m.http.monotonic()).toBeGreaterThan(27);
    expect(s.sur("/slots")).toHaveLength(2);
  });

  it("resolveSlotIdAsync : total connu sans I/O pour l'intégré, sondé pour un connecteur, occupation de /slots", async () => {
    const { resolveSlotId, resolveSlotIdAsync } = m.constantes;
    expect(await resolveSlotIdAsync("chat-1")).toBe(resolveSlotId("chat-1", 0, null));
    expect(s.requetes).toHaveLength(0);
    m.modeles.setCachedTotalSlots(4);
    s.json("GET /slots", [
      { id: 0, is_processing: true },
      { id: 2, is_processing: true },
    ]);
    for (const chat of ["a", "b", "c", "d", "e"]) {
      m.modeles.poserSlotsOccupes(null, 0);
      expect(await resolveSlotIdAsync(chat)).toBe(resolveSlotId(chat, 4, new Set([0, 2])));
      expect(await resolveSlotIdAsync(chat, { avoidOwn: true })).toBe(
        resolveSlotId(chat, 4, new Set([0, 2]), { avoidOwn: true }),
      );
    }
    const autre = await FauxServeur.demarrer();
    try {
      autre.json("GET /props", { total_slots: 3 });
      autre.json("GET /slots", [{ id: 1, state: 1 }]);
      const eng = new m.moteurs.EngineRef({ key: "conn:3", baseRoot: autre.url });
      expect(await m.moteurs.useEngine(eng, () => resolveSlotIdAsync("z"))).toBe(
        resolveSlotId("z", 3, new Set([1])),
      );
    } finally {
      await autre.arreter();
    }
  });

  it("invalidation globale : bilan de Python, caches inscrits compris (paramètres, fenêtres distantes, vision)", async () => {
    s.json("GET /props", { default_generation_settings: { n_ctx: 2048 }, total_slots: 2 });
    await m.modeles.getModelContextSize("m");
    await m.modeles.getModelTotalSlots("m");
    m.constantes.VISION_CAPABILITY_CACHE.set("v", true);
    m.fenetre.cache.set('[null,"x"]', 10);
    expect(m.modeles.invalidateAllModelCaches()).toEqual({
      context_size_was_cached: true,
      context_size_entries_cleared: 1,
      total_slots_was_cached: true,
      total_slots_entries_cleared: 1,
      llm_params_entries_cleared: 0,
      vision_entries_cleared: 1,
      ctx_window_entries_cleared: 1,
    });
    expect(m.modeles.invalidateAllModelCaches()).toEqual({
      context_size_was_cached: false,
      context_size_entries_cleared: 0,
      total_slots_was_cached: false,
      total_slots_entries_cleared: 0,
      llm_params_entries_cleared: 0,
      vision_entries_cleared: 0,
      ctx_window_entries_cleared: 0,
    });
  });
});

describe("fenêtre de la cible (locale, connecteur llama.cpp, distante)", () => {
  it("locale : /props ; connecteur llama.cpp : fenêtre déclarée, sinon son /props vivant", async () => {
    s.json("GET /props", { default_generation_settings: { n_ctx: 8192 } });
    expect(await m.fenetre.resolveContextWindow("m")).toBe(8192);
    const autre = await FauxServeur.demarrer();
    try {
      autre.json("GET /props", { n_ctx: 16384 });
      const appels: number[] = [];
      connecteurs({ 7: { context_window: 32768 }, 8: { meta: { ctx_size: "4096" } } }, appels);
      const cible = (id: number) =>
        new m.cible.LlmTarget({
          isDefault: false,
          providerType: "llamacpp",
          baseUrl: autre.url,
          connectorId: id,
        });
      expect(await m.fenetre.resolveContextWindow("q", cible(7))).toBe(32768);
      expect(await m.fenetre.resolveContextWindow("q", cible(7))).toBe(32768);
      expect(appels).toEqual([7]);
      expect(await m.fenetre.resolveContextWindow("q", cible(8))).toBe(4096);
      expect(await m.fenetre.resolveContextWindow("q", cible(9))).toBe(16384);
      expect(autre.sur("/props").length).toBeGreaterThan(0);
    } finally {
      await autre.arreter();
    }
  });

  it("distante : déclarée, famille connue, défaut du fournisseur, LLM_REMOTE_N_CTX, puis 0 mémorisé 60 s", async () => {
    const appels: number[] = [];
    connecteurs({ 1: { n_ctx: 50000 } }, appels);
    const cible = (champs: Dict) =>
      new m.cible.LlmTarget({ isDefault: false, providerType: "openai", baseUrl: "http://x/v1", ...champs });
    expect(await m.fenetre.resolveContextWindow("gpt-4o", cible({ connectorId: 1 }))).toBe(50000);
    expect(await m.fenetre.resolveContextWindow("gpt-4o", cible({ connectorId: 2 }))).toBe(128000);
    expect(
      await m.fenetre.resolveContextWindow("inconnu", cible({ connectorId: 3, providerType: "opencode" })),
    ).toBe(131072);
    expect(await m.fenetre.resolveContextWindow("inconnu", cible({ connectorId: 4 }))).toBe(0);
    process.env["LLM_REMOTE_N_CTX"] = "65536";
    expect(await m.fenetre.resolveContextWindow("inconnu", cible({ connectorId: 4 }))).toBe(0);
    expect(await m.fenetre.resolveContextWindow("autre", cible({ connectorId: 4 }))).toBe(65536);
    expect(await m.fenetre.resolveContextWindow(null, cible({ connectorId: 5, model: "claude-x" }))).toBe(
      200000,
    );
    m.fenetre.invalidateCache();
    expect(await m.fenetre.resolveContextWindow("inconnu", cible({ connectorId: 4 }))).toBe(65536);
    process.env["LLM_REMOTE_N_CTX"] = "-3";
    expect(m.fenetre.envDefault()).toBe(0);
    process.env["LLM_REMOTE_N_CTX"] = "beaucoup";
    expect(m.fenetre.envDefault()).toBe(0);
    expect(s.requetes).toHaveLength(0);
  });

  it("moteur qui annonce sa fenêtre, muet : 0 sans repli sur la famille ; connecteur générique : famille connue", async () => {
    connecteurs({});
    const cible = (providerType: string, connectorId: number) =>
      new m.cible.LlmTarget({ isDefault: false, providerType, baseUrl: s.url, connectorId });
    expect(await m.fenetre.resolveContextWindow("qwen3-32b", cible("vllm", 21))).toBe(0);
    expect(await m.fenetre.resolveContextWindow("qwen3-32b", cible("sglang", 22))).toBe(0);
    expect(await m.fenetre.resolveContextWindow("qwen3-32b", cible("llamacpp", 23))).toBe(0);
    expect(await m.fenetre.resolveContextWindow("qwen3-32b", cible("generic", 24))).toBe(131072);
  });

  it("type de fournisseur hérité d'Object.prototype : aucun défaut de fournisseur", async () => {
    const cible = new m.cible.LlmTarget({
      isDefault: false,
      providerType: "constructor",
      baseUrl: "http://x",
      connectorId: 9,
    });
    expect(await m.fenetre.resolveContextWindow("inconnu-z", cible)).toBe(0);
  });

  it("connecteurs non posés : aucune fenêtre déclarée, la suite décide", async () => {
    const cible = new m.cible.LlmTarget({
      isDefault: false,
      providerType: "openai",
      baseUrl: "http://x",
      connectorId: 1,
    });
    expect(await m.fenetre.fromConnector(1)).toBe(0);
    expect(await m.fenetre.resolveContextWindow("gpt-4", cible)).toBe(8192);
  });
});

describe("cycle de vie des modèles", () => {
  it("chargement et déchargement : corps, succès = caches de modèle vidés, échec = indice", async () => {
    s.json("POST /models/load", { success: true });
    s.json("POST /models/unload", {}, 204);
    m.modeles.cachedContextSize.set("m", 10);
    m.tokens.tokenizeCache.set("k", 1);
    expect(await m.cycle.loadLlmModel(" /models/q.gguf ")).toEqual({
      ok: true,
      method: "models_load",
      detail: { _status: 200, success: true },
    });
    expect(s.sur("/models/load")[0]?.json()).toEqual({ model: "/models/q.gguf" });
    expect(m.modeles.cachedContextSize.size).toBe(0);
    expect(m.tokens.tokenizeCache.size).toBe(0);
    expect((await m.cycle.unloadLlmModel("q"))["ok"]).toBe(true);
    expect(await m.cycle.loadLlmModel("  ")).toEqual({ ok: false, error: "Chemin requis." });
    expect(await m.cycle.unloadLlmModel("")).toEqual({ ok: false, error: "model_id requis." });
    s.json("POST /models/load", { error: "introuvable" });
    expect(await m.cycle.loadLlmModel("x")).toMatchObject({ ok: false, error: "introuvable" });
    s.texte("POST /models/unload", "non", 404);
    expect(await m.cycle.unloadLlmModel("x")).toMatchObject({
      ok: false,
      error: "Non supporté par ce build ou modèle introuvable.",
    });
  });

  it("attente d'inactivité : /health (slots_processing), sinon /metrics ; moteur muet 3 fois = abandon", async () => {
    let tours = 0;
    s.route("GET /health", (_q, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ status: "ok", slots_processing: tours++ < 2 ? 1 : 0 }));
    });
    expect(await m.cycle.waitForSlotsIdle(5, 0.01)).toBe(true);
    expect(tours).toBe(3);
    absent("GET /health");
    s.texte("GET /metrics", "llamacpp:requests_processing 0\n");
    expect(await m.cycle.waitForSlotsIdle(5, 0.01)).toBe(true);
    absent("GET /metrics");
    s.requetes.length = 0;
    expect(await m.cycle.waitForSlotsIdle(5, 0.01)).toBe(false);
    expect(s.sur("/health")).toHaveLength(3);
    s.json("GET /health", { slots_processing: 2 });
    expect(await m.cycle.waitForSlotsIdle(0.05, 0.01)).toBe(false);
  });

  it("attente d'inactivité annulable", async () => {
    s.json("GET /health", { slots_processing: 1 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    await expect(m.cycle.waitForSlotsIdle(5, 1, { signal: ctl.signal })).rejects.toBeInstanceOf(
      m.client.CancelledError,
    );
  });
});

describe("capacités du serveur intégré et mode d'ordonnancement", () => {
  it("mono-modèle : total_slots, modèle (alias, nom, chemin sans extension), /slots accessible = optimisé", async () => {
    s.json("GET /props", { total_slots: 4, model_path: "/modeles/qwen3-8b.Q4_K_M.gguf" });
    s.json("GET /slots", [{ id: 0 }]);
    expect(await m.capacites.detectLlamaCapabilities()).toEqual({
      probed: true,
      slots_endpoint: true,
      total_slots: 4,
      loaded_model: "qwen3-8b.Q4_K_M",
      role: "single-model",
      max_instances: null,
      probe_error: null,
      recommended_mode: "optimized",
    });
    expect(m.capacites.getLlamaCapabilities()["total_slots"]).toBe(4);
    expect(
      ["/a/b.gguf", ".bashrc", "a.b.c", "..x", "...a.b", "sans"].map(m.capacites.nomSansExtension),
    ).toEqual(["b", ".bashrc", "a.b", "..x", "...a", "sans"]);
  });

  it("routeur : modèle chargé par /v1/models, /slots routé sans charger ; aucun chargé = slots en attente", async () => {
    s.json("GET /props", { role: "router", max_instances: 2 });
    s.json("GET /v1/models", {
      data: [
        { id: "a", status: { value: "unloaded" } },
        { id: "b c", status: { value: "loaded" } },
      ],
    });
    s.json("GET /slots", [{ id: 0 }]);
    const caps = await m.capacites.detectLlamaCapabilities();
    expect(caps).toMatchObject({
      role: "router",
      loaded_model: "b c",
      slots_endpoint: true,
      recommended_mode: "optimized",
    });
    expect(s.sur("/slots")[0]?.chemin).toBe("/slots?model=b%20c&autoload=false");
    s.json("GET /v1/models", { data: [] });
    expect(await m.capacites.detectLlamaCapabilities()).toMatchObject({
      slots_pending: true,
      slots_endpoint: false,
      probe_error: null,
      recommended_mode: "optimized",
    });
  });

  it("serveur injoignable : erreur notée, mode classique ; re-sonde en `auto` après 60 s seulement", async () => {
    const mort = await moteurFrais(urlLlama(`http://127.0.0.1:${await portFerme()}`));
    try {
      const caps = await mort.capacites.detectLlamaCapabilities(0.5);
      expect(caps["probe_error"]).toBe("/props: All connection attempts failed");
      expect(caps["recommended_mode"]).toBe("classic");
      mort.config.surchargerConfig({ LLM_SCHEDULING_MODE: "auto" });
      mort.capacites.probeState.ts = 0;
      expect(mort.capacites.resolveSchedulingMode()).toBe("classic");
      expect(mort.capacites.resondagesEnVol()).toHaveLength(1);
      await Promise.all(mort.capacites.resondagesEnVol());
      mort.capacites.maybeReprobeCapabilities();
      expect(mort.capacites.resondagesEnVol()).toHaveLength(0);
      mort.config.surchargerConfig({ LLM_SCHEDULING_MODE: "optimized" });
      expect(mort.capacites.resolveSchedulingMode()).toBe("optimized");
      mort.config.surchargerConfig({ LLM_SCHEDULING_MODE: "classic" });
      expect(mort.capacites.resolveSchedulingMode()).toBe("classic");
    } finally {
      await mort.fermer();
      m.config.surchargerConfig(urlLlama(s.url));
    }
  });
});

describe("état des modèles diffusé et crochets du bus", () => {
  function servirEtat(charge: string): void {
    s.json("GET /health", { status: "ok" });
    s.json("GET /v1/models", {
      data: [
        { id: "a", status: { value: charge === "a" ? "loaded" : "unloaded" } },
        { id: "llava", status: { value: charge === "llava" ? "loaded" : "unloaded" } },
      ],
    });
    s.texte("GET /metrics", "llamacpp:kv_cache_tokens 10\nllamacpp:n_ctx_total 100\n");
  }

  it("rafraîchissement : état servi, modèles en VRAM, diffusion SEULEMENT quand l'empreinte change", async () => {
    const diffuses: Dict[] = [];
    m.ports.installerDiffusion({ diffuser: (msg) => void diffuses.push(msg) });
    m.cacheModeles.viderCacheModeles();
    servirEtat("a");
    await m.cacheModeles.refreshModelCache();
    await m.cacheModeles.refreshModelCache();
    expect(diffuses).toHaveLength(1);
    expect(diffuses[0]?.["type"]).toBe("model_status");
    expect(m.cacheModeles.modelCache).toMatchObject({
      models: ["a", "llava"],
      models_with_status: [
        { id: "a", status: "loaded", vision: false },
        { id: "llava", status: "unloaded", vision: true },
      ],
      models_loaded: [{ id: "a" }],
      kv_cache: { used: 10, total: 100, pct: 10 },
      server_reachable: true,
      status: "ok",
      props: { model: "a", n_ctx: 100 },
    });
    expect([...m.cacheModeles.CURRENT_LOADED_MODELS]).toEqual(["a"]);
    servirEtat("llava");
    await m.cacheModeles.refreshModelCache();
    expect(diffuses).toHaveLength(2);
    expect([...m.cacheModeles.CURRENT_LOADED_MODELS]).toEqual(["llava"]);
  });

  it("crochets : ouverture d'un flux = UNE sonde de fond, rafraîchir sur ordre, visibilité ouverte en cas de doute", async () => {
    m.ports.installerDiffusion({ diffuser: () => undefined });
    servirEtat("a");
    m.cacheModeles.surOuvertureFlux();
    m.cacheModeles.surOuvertureFlux();
    await attendre(100);
    expect(s.sur("/health")).toHaveLength(1);
    m.cacheModeles.arreterSondeModeles();
    m.cacheModeles.rafraichirModeles();
    await attendre(100);
    expect(s.sur("/health")).toHaveLength(2);
    expect(m.cacheModeles.peutVoirModeles(1)).toBe(true);
    const vus: unknown[] = [];
    m.ports.installerAccesMoteurs({
      peutUtiliserMoteur: (uid, cle) => {
        vus.push([uid, cle]);
        return uid === 1;
      },
    });
    expect([m.cacheModeles.peutVoirModeles(1), m.cacheModeles.peutVoirModeles(2)]).toEqual([true, false]);
    expect(vus).toEqual([
      [1, "builtin"],
      [2, "builtin"],
    ]);
    m.ports.installerAccesMoteurs({
      peutUtiliserMoteur: () => {
        throw new Error("base");
      },
    });
    expect(m.cacheModeles.peutVoirModeles(3)).toBe(true);
  });
});
