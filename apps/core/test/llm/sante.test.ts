// SPDX-License-Identifier: MIT
/** apps/core/test/llm/sante.test.ts — santé, appels courts, fenêtres et slots, inventaire et vision : vecteurs Python rejoués sur un faux llama-server. */
import { DOSSIER_MOTEUR } from "./environnement-fournisseurs";

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decoder, lireVecteurs } from "../vecteurs-moteur";
import { FauxServeur, portFerme } from "./faux-serveur";
import { moteurFrais, urlLlama } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

type Dict = Record<string, unknown>;

interface VecteursSante {
  prometheus: { texte: string; metriques: Dict }[];
  routeur: { modeles: unknown; chemin: string | null }[];
  fenetres_slots: { props: unknown; fenetre: number; slots: number }[];
  occupations: { slots: unknown; occupes: number[]; directe: number[] | null }[];
  inventaires: {
    corps: unknown;
    illisible: boolean;
    statut: number;
    sonde: [Dict[], boolean];
    liste: Dict[];
  }[];
  vision: (
    | { entree: Dict; vision: unknown; meta: boolean; drapeau: boolean }
    | { sequence: Dict[]; drapeaux: boolean[] }
  )[];
  familles: { nom: string | null; fenetre: number }[];
  fenetres_connues: [string, number][];
}

const V = lireVecteurs<VecteursSante>("moteur-sante");
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

beforeEach(() => {
  s.requetes.length = 0;
  for (const r of ["GET /props", "GET /slots", "GET /metrics", "GET /v1/models", "GET /health", "GET /"])
    s.route(r, (_q, rep) => {
      rep.writeHead(404);
      rep.end();
    });
  m.caps.invalidate();
  m.modeles.invalidateContextSizeCache();
  m.modeles.invalidateTotalSlotsCache();
  m.modeles.poserSlotsOccupes(null, 0);
  m.http.metricsOffUntil.clear();
  m.constantes.VISION_CAPABILITY_CACHE.clear();
  m.sante.preflightOkAt.clear();
  m.sante.loadedModelCache.id = null;
  m.sante.loadedModelCache.ts = 0;
});

afterEach(() => {
  m.ports.installerImages(null);
});

function servirJson(cle: string, corps: unknown, statut = 200): void {
  if (corps === null) s.texte(cle, "panne", 500);
  else s.json(cle, corps, statut);
}

describe("vecteurs Python : formes pures", () => {
  it("métriques Prometheus (noms normalisés, flottants Python, lignes illisibles ignorées)", () => {
    for (const c of V.prometheus)
      expect(m.sante.parsePrometheusMetrics(c.texte), c.texte).toEqual(decoder(c.metriques));
    const hostile = m.sante.parsePrometheusMetrics("__proto__ 5\nconstructor 2\n");
    expect(Object.keys(hostile)).toEqual(["__proto__", "constructor"]);
    expect([hostile["__proto__"], hostile["constructor"]]).toEqual([5, 2]);
    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
  });

  it("chemin /metrics d'un routeur d'après /v1/models", () => {
    for (const c of V.routeur)
      expect(m.sante.routerMetricsPath(c.modeles), JSON.stringify(c.modeles)).toBe(c.chemin);
    expect(m.sante.routerMetricsPath({ data: [{ id: {}, status: "loaded" }] })).toBeNull();
    expect(
      m.sante.analyserModelesDistants({ data: [{ id: "a", status: { value: "unloaded", failed: {} } }] }),
    ).toEqual([{ id: "a", status: "unloaded", vision: false }]);
  });

  it("vision d'une entrée /v1/models, métadonnées, drapeau sans rétrogradation (cache partagé, ordre gardé)", () => {
    m.constantes.VISION_CAPABILITY_CACHE.clear();
    for (const c of V.vision) {
      if ("sequence" in c) {
        m.constantes.VISION_CAPABILITY_CACHE.clear();
        expect(c.sequence.map((e) => m.vision.visionFlagFromEntry(e))).toEqual(c.drapeaux);
        continue;
      }
      const ctx = JSON.stringify(c.entree);
      expect(m.vision.entryHasVision(c.entree), ctx).toBe(c.vision);
      expect(m.vision.entryHasCapabilityMeta(c.entree), ctx).toBe(c.meta);
      expect(m.vision.visionFlagFromEntry(c.entree), ctx).toBe(c.drapeau);
    }
  });

  it("fenêtres des familles connues (préfixes, dernier segment, suffixe -128k / -1m)", () => {
    expect(m.fenetre.KNOWN_WINDOWS).toEqual(V.fenetres_connues);
    for (const c of V.familles)
      expect(m.fenetre.fromKnownFamily(c.nom), String(c.nom).slice(0, 40)).toBe(c.fenetre);
  });
});

describe("vecteurs Python rejoués sur le faux serveur", () => {
  it("fenêtre par slot et nombre de slots d'après /props", async () => {
    for (const c of V.fenetres_slots) {
      m.modeles.invalidateContextSizeCache();
      m.modeles.invalidateTotalSlotsCache();
      servirJson("GET /props", c.props);
      const ctx = JSON.stringify(c.props);
      expect(await m.modeles.getModelContextSize("m"), ctx).toBe(c.fenetre);
      expect(await m.modeles.getModelTotalSlots(null), ctx).toBe(c.slots);
    }
  });

  it("slots occupés d'après /slots (is_processing, sinon state)", async () => {
    for (const c of V.occupations) {
      m.modeles.poserSlotsOccupes(null, 0);
      servirJson("GET /slots", c.slots);
      const occupes = await m.modeles.getBusySlotsSnapshot();
      expect(
        [...(occupes ?? [])].sort((a, b) => a - b),
        JSON.stringify(c.slots),
      ).toEqual(c.occupes);
      if (Array.isArray(c.slots))
        expect([...m.modeles.parseBusy(c.slots)].sort((a, b) => a - b)).toEqual(c.directe);
    }
  });

  it("inventaire /v1/models : sonde (joignable ou non) et liste avec statut et vision", async () => {
    for (const c of V.inventaires) {
      m.constantes.VISION_CAPABILITY_CACHE.clear();
      if (c.illisible) s.texte("GET /v1/models", "pas du json{", c.statut);
      else s.json("GET /v1/models", c.corps, c.statut);
      const ctx = `${c.statut} ${JSON.stringify(c.corps)}`;
      expect(await m.sante.remoteModelsProbe(), ctx).toEqual(c.sonde);
      expect(await m.sante.getRemoteModelsWithStatus(), ctx).toEqual(c.liste);
    }
  });
});

describe("appels courts (llama-http)", () => {
  it("GET : JSON, corps illisible en `_raw`, statut d'échec ou serveur muet = null", async () => {
    s.json("GET /props", { a: 1 });
    expect(await m.http.llamaGet("/props")).toEqual({ a: 1 });
    s.texte("GET /props", "x".repeat(2500));
    expect(await m.http.llamaGet("/props")).toEqual({ _raw: "x".repeat(2000) });
    s.texte("GET /props", "non", 503);
    expect(await m.http.llamaGet("/props")).toBeNull();
    s.route("GET /props", () => new Promise(() => undefined));
    expect(await m.http.llamaGet("/props", 0.1)).toBeNull();
  });

  it("POST et DELETE : `_status` + corps, texte tronqué à 300, panne de transport nommée comme httpx", async () => {
    s.json("POST /x", { ok: true }, 201);
    expect(await m.http.llamaPost("/x", { a: 1 })).toEqual({ _status: 201, ok: true });
    expect(s.sur("/x")[0]?.json()).toEqual({ a: 1 });
    s.json("POST /x", [1, 2]);
    expect(await m.http.llamaPost("/x", {})).toEqual({ _status: 200, text: "[1,2]" });
    s.texte("POST /x", "é".repeat(400), 500);
    expect(await m.http.llamaPost("/x", {})).toEqual({ _status: 500, text: "é".repeat(300) });
    s.json("DELETE /x", { supprime: 1 });
    expect(await m.http.llamaDelete("/x")).toEqual({ _status: 200, supprime: 1 });
    const mort = new m.moteurs.EngineRef({
      key: "conn:9",
      baseRoot: `http://127.0.0.1:${await portFerme()}`,
    });
    expect(await m.http.llamaPost("/x", {}, 2, { engine: mort })).toEqual({
      _status: 0,
      error: "All connection attempts failed",
      error_type: "ConnectError",
    });
    expect(await m.http.llamaDelete("/x", 2, { engine: mort })).toEqual({
      _status: 0,
      error: "All connection attempts failed",
    });
  });

  it("serveur d'un connecteur : sa racine et sa clé, jamais celles de l'intégré", async () => {
    const autre = await FauxServeur.demarrer();
    try {
      autre.json("GET /props", { distant: true });
      const eng = new m.moteurs.EngineRef({
        key: "conn:4",
        baseRoot: autre.url,
        headers: [["Authorization", "Bearer sk-4"]],
      });
      expect(m.http.engineUrlHeaders("/props", eng)).toEqual([
        `${autre.url}/props`,
        { Authorization: "Bearer sk-4" },
      ]);
      expect(m.http.engineUrlHeaders("/props")).toEqual([`${s.url}/props`, null]);
      expect(await m.moteurs.useEngine(eng, () => m.http.llamaGet("/props"))).toEqual({ distant: true });
      expect(autre.requetes[0]?.entetes["authorization"]).toBe("Bearer sk-4");
      expect(s.requetes).toHaveLength(0);
    } finally {
      await autre.arreter();
    }
  });

  it("/metrics en 501 (sans --metrics) : plus demandé pendant 300 s", async () => {
    s.texte("GET /metrics", "Not Implemented", 501);
    expect(await m.http.llamaGetText("/metrics")).toBeNull();
    expect(await m.http.llamaGetText("/metrics")).toBeNull();
    expect(s.sur("/metrics")).toHaveLength(1);
    const [cle, jusque] = [...m.http.metricsOffUntil.entries()][0] ?? ["", 0];
    expect(cle).toBe("builtin/metrics");
    expect(jusque - m.http.monotonic()).toBeGreaterThan(299);
  });

  it("routeur : /metrics et /slots routés vers le modèle CHARGÉ sans le charger ; aucun chargé = rien demandé", async () => {
    s.json("GET /props", { build_info: "b10545-abc", role: "router" });
    s.json("GET /v1/models", { data: [{ id: "a b/é", status: { value: "loaded" } }] });
    s.texte("GET /metrics", "llamacpp:n_ctx_total 4096\n");
    expect(await m.http.perModelPath("/metrics")).toBe("/metrics?model=a%20b%2F%C3%A9&autoload=false");
    expect(await m.http.llamaGetText("/metrics")).toBe("llamacpp:n_ctx_total 4096\n");
    expect(s.sur("/metrics")[0]?.chemin).toBe("/metrics?model=a%20b%2F%C3%A9&autoload=false");
    m.sante.loadedModelCache.ts = 0;
    s.json("GET /v1/models", { data: [{ id: "a", status: { value: "unloaded" } }] });
    expect(await m.http.llamaGet("/slots")).toBeNull();
    expect(s.sur("/slots")).toHaveLength(0);
    expect(await m.http.perModelPath("/props")).toBe("/props");
  });

  it("dormir() annulable : le signal lève CancelledError", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(m.http.dormir(5, ctl.signal)).rejects.toBeInstanceOf(m.client.CancelledError);
  });
});

describe("santé du serveur", () => {
  function sain(): void {
    s.json("GET /health", { status: "ok" });
    s.json("GET /props", { total_slots: 2 });
    s.json("GET /v1/models", { data: [{ id: "q", object: "model", owned_by: "llamacpp", meta: { n: 1 } }] });
    s.texte("GET /metrics", "llamacpp:kv_cache_tokens 1024\nllamacpp:n_ctx_total 8192\n");
  }

  it("agrégée : /health puis inventaire, métriques, cache KV et slots en parallèle", async () => {
    sain();
    expect(await m.sante.getLlmHealth()).toEqual({
      server_reachable: true,
      status: "ok",
      models_loaded: [{ id: "q", object: "model", owned_by: "llamacpp", meta: { n: 1 } }],
      kv_cache: { used: 1024, total: 8192, pct: 12.5 },
      metrics: { llamacpp_kv_cache_tokens: 1024, llamacpp_n_ctx_total: 8192 },
      props: { n_ctx: 8192, total_slots: 2 },
      moteur: { type: "llamacpp", libelle: "llama.cpp", chargement: true, file: true, contexte: true },
    });
  });

  it("sans /health : la racine décide (< 500 joignable) ; injoignable = état vide", async () => {
    s.texte("GET /", "accueil");
    expect((await m.sante.getLlmHealth())["status"]).toBe("ok");
    s.texte("GET /", "boum", 502);
    expect(await m.sante.getLlmHealth()).toMatchObject({ server_reachable: false, status: "error" });
    const mort = await moteurFrais(urlLlama(`http://127.0.0.1:${await portFerme()}`));
    try {
      expect(await mort.sante.getLlmHealth()).toEqual({
        server_reachable: false,
        status: "unreachable",
        models_loaded: [],
        kv_cache: { used: 0, total: 0, pct: 0 },
        metrics: {},
        moteur: { type: "llamacpp", libelle: "llama.cpp", chargement: true, file: true, contexte: true },
      });
      expect(await mort.sante.getLlmHealthSync()).toMatchObject({ server_reachable: false });
    } finally {
      await mort.fermer();
      m.config.surchargerConfig(urlLlama(s.url));
    }
  });

  it("directe : un magasin de CA illisible rend l'état « injoignable » au lieu de lever, comme Python", async () => {
    process.env["SSL_CERT_FILE"] = "/nulle/part.pem";
    try {
      expect(await m.sante.getLlmHealthSync()).toEqual({
        server_reachable: false,
        status: "unreachable",
        models_loaded: [],
        metrics: {},
        kv_cache: { used: 0, total: 0, pct: 0 },
      });
    } finally {
      delete process.env["SSL_CERT_FILE"];
    }
  });

  it("directe (moteur de métriques) : routeur → /metrics du modèle chargé, 501 coupe /metrics", async () => {
    sain();
    s.json("GET /v1/models", {
      data: [
        { id: "a", status: { value: "unloaded" } },
        { id: "b", status: "loaded" },
      ],
    });
    const r = await m.sante.getLlmHealthSync();
    expect(r).toMatchObject({
      server_reachable: true,
      status: "ok",
      kv_cache: { used: 1024, total: 8192, pct: 12.5 },
    });
    expect(r["models_loaded"]).toEqual([
      { id: "a", meta: {} },
      { id: "b", meta: {} },
    ]);
    expect(s.sur("/metrics")[0]?.chemin).toBe("/metrics?model=b&autoload=false");
    s.texte("GET /metrics", "off", 501);
    await m.sante.getLlmHealthSync();
    await m.sante.getLlmHealthSync();
    expect(s.sur("/metrics")).toHaveLength(2);
  });

  it("modèle chargé : cache 5 s ; une panne rend le dernier connu", async () => {
    s.json("GET /v1/models", {
      data: [
        { id: "x", status: { value: "unloaded" } },
        { id: "y", status: { value: "loaded" } },
      ],
    });
    expect(await m.sante.getCurrentlyLoadedModel()).toBe("y");
    s.json("GET /v1/models", { data: [] });
    expect(await m.sante.getCurrentlyLoadedModel()).toBe("y");
    expect(s.sur("/v1/models")).toHaveLength(1);
    m.sante.loadedModelCache.ts = 0;
    s.texte("GET /v1/models", "panne", 500);
    expect(await m.sante.getCurrentlyLoadedModel()).toBe("y");
    m.sante.setLoadedModelCache("z");
    expect(m.sante.getCurrentlyLoadedModelSync()).toBe("z");
  });

  it("préflight : intégré joignable (mémorisé 10 s), injoignable = ConnectError au libellé de Python", async () => {
    await m.sante.verifyLlmAvailability();
    await m.sante.verifyLlmAvailability();
    expect(s.requetes.filter((r) => r.chemin === "/")).toHaveLength(1);
    const mort = `http://127.0.0.1:${await portFerme()}`;
    const cible = new m.cible.LlmTarget({
      isDefault: false,
      providerType: "openai",
      baseUrl: `${mort}/v1`,
      apiKey: "k",
    });
    await expect(m.cible.useLlmTarget(cible, () => m.sante.verifyLlmAvailability())).rejects.toMatchObject({
      name: "ConnectError",
      message: `Connecteur LLM injoignable (${mort.slice(7)}). Vérifiez l'URL du connecteur et le réseau.`,
    });
    const sansBase = new m.cible.LlmTarget({ isDefault: false, providerType: "openai", baseUrl: " " });
    await m.cible.useLlmTarget(sansBase, () => m.sante.verifyLlmAvailability());
  });

  it("requêtes simultanées : 20 flux ouverts ensemble vers le moteur, le préflight passe pendant ce temps", async () => {
    s.sse("POST /v1/chat/completions", ["data: 1"], { ouvert: true });
    const c = m.client.getLlmClient();
    const flux = await Promise.all(
      Array.from({ length: 20 }, () => c.stream("POST", `${s.url}/v1/chat/completions`, { json: {} })),
    );
    try {
      expect(s.requetes.filter((r) => r.chemin === "/v1/chat/completions")).toHaveLength(20);
      await m.sante.verifyLlmAvailability();
    } finally {
      await Promise.all(flux.map((r) => r.aclose()));
    }
  });

  it("préflight d'un connecteur : en-têtes de son dialecte (Bearer ou x-api-key)", async () => {
    const autre = await FauxServeur.demarrer();
    try {
      for (const r of ["GET /"]) autre.texte(r, "ok");
      const openai = new m.cible.LlmTarget({
        isDefault: false,
        providerType: "openai",
        baseUrl: `${autre.url}/v1`,
        apiKey: "sk-o",
      });
      await m.cible.useLlmTarget(openai, () => m.sante.verifyLlmAvailability());
      m.sante.preflightOkAt.clear();
      const anth = new m.cible.LlmTarget({
        isDefault: false,
        wire: "anthropic",
        providerType: "anthropic",
        baseUrl: autre.url,
        apiKey: "sk-a",
      });
      await m.cible.useLlmTarget(anth, () => m.sante.verifyLlmAvailability());
      expect(autre.requetes[0]?.entetes["authorization"]).toBe("Bearer sk-o");
      expect(autre.requetes[1]?.entetes["x-api-key"]).toBe("sk-a");
      expect(autre.requetes[1]?.entetes["anthropic-version"]).toBe("2023-06-01");
    } finally {
      await autre.arreter();
    }
  });
});

describe("vision", () => {
  it("modèle vision : /v1/models du serveur de la cible, puis motif du nom ; résultat mis en cache", async () => {
    s.json("GET /v1/models", { data: [{ id: "plain", capabilities: ["vision"] }, { id: "texte" }] });
    expect(await m.vision.modelSupportsVision("plain")).toBe(true);
    expect(await m.vision.modelSupportsVision("texte")).toBe(false);
    expect(await m.vision.modelSupportsVision("llava-7b")).toBe(true);
    expect(await m.vision.modelSupportsVision("plain")).toBe(true);
    expect(await m.vision.modelSupportsVision("")).toBe(false);
    expect(s.sur("/v1/models")).toHaveLength(3);
    const autre = await FauxServeur.demarrer();
    try {
      autre.json("GET /v1/models", { data: [{ id: "plain", multimodal: true }] });
      const eng = new m.moteurs.EngineRef({
        key: "conn:5",
        baseRoot: autre.url,
        headers: [["Authorization", "Bearer v"]],
      });
      expect(await m.moteurs.useEngine(eng, () => m.vision.modelSupportsVision("plain"))).toBe(true);
      expect(m.constantes.VISION_CAPABILITY_CACHE.get("conn:5|plain")).toBe(true);
      expect(autre.requetes[0]?.entetes["authorization"]).toBe("Bearer v");
    } finally {
      await autre.arreter();
    }
  });

  it("captures : réduction par le port d'images (absent = PNG tel quel, en échec = rien), LRU de 32", async () => {
    const png = path.join(DOSSIER_MOTEUR, "capture.png");
    writeFileSync(png, Buffer.from([137, 80, 78, 71]));
    await m.vision.trackLastScreenshotForVision("c0", png);
    expect(m.vision.getLastScreenshotB64("c0")).toBe("data:image/jpeg;base64,iVBORw==");
    const appels: unknown[] = [];
    m.ports.installerImages({
      reduireCapture: (octets, largeur, qualite) => {
        appels.push([octets.length, largeur, qualite]);
        return Promise.resolve(Buffer.from("jpeg"));
      },
    });
    for (let i = 1; i <= 33; i++) await m.vision.trackLastScreenshotForVision(`c${i}`, png);
    expect(appels[0]).toEqual([4, 1024, 85]);
    expect(m.vision.getLastScreenshotB64("c0")).toBeNull();
    expect(m.vision.getLastScreenshotB64("c1")).toBeNull();
    expect(m.vision.getLastScreenshotB64("c33")).toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
    );
    m.vision.clearLastScreenshotFor("c33");
    expect(m.vision.getLastScreenshotB64("c33")).toBeNull();
    m.ports.installerImages({ reduireCapture: () => Promise.reject(new Error("boum")) });
    expect(await m.vision.downscaleScreenshot(Buffer.from([1]))).toBeNull();
    await m.vision.trackLastScreenshotForVision("absent", path.join(DOSSIER_MOTEUR, "nulle-part.png"));
    expect(m.vision.getLastScreenshotB64("absent")).toBeNull();
  });
});
