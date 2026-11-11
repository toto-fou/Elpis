// SPDX-License-Identifier: MIT
/** apps/core/test/llm/profils.test.ts — profils de moteur (llama.cpp, vLLM, SGLang, générique) : table, configuration, en-têtes, métriques, et chaque capacité contre les faux vLLM 0.31.0 et SGLang 0.5.21. */
import "./environnement-fournisseurs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { calculerReglages, typeMoteurLlama, urlChatLlama } from "@elpis/config";

import { demarrerFauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import type { FauxMoteur, OptionsFauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import {
  etatCharge,
  lireEchantillons,
  metriquesReconnues,
  oublierDebits,
} from "../../src/llm/metriques-moteur";
import {
  aDialecteEtendu,
  CHAMPS_DIALECTE_ETENDU,
  PROFILS,
  profilDe,
  profilDuType,
  texteReflexion,
  TYPES_MOTEUR,
} from "../../src/llm/profils";
import { moteurFrais } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

const CLE = "cle-secrete-du-moteur-42";

describe("table des profils", () => {
  it("un profil par type, alias de llama.engine compris ; un fournisseur cloud ou inconnu est générique", () => {
    expect(TYPES_MOTEUR).toEqual(["llamacpp", "vllm", "sglang", "generic"]);
    for (const [brut, type] of [
      ["vllm", "vllm"],
      ["vLLM", "vllm"],
      [" SGLang ", "sglang"],
      ["llama.cpp", "llamacpp"],
      ["llama-cpp", "llamacpp"],
      ["", "llamacpp"],
      ["ollama", "generic"],
      ["openai", "generic"],
      ["anthropic", "generic"],
      ["inconnu", "generic"],
    ] as const)
      expect(profilDe(brut).type, brut).toBe(type);
  });

  it("adresses relevées dans le code source (vLLM v0.31.0, SGLang v0.5.21)", () => {
    expect(PROFILS.vllm.chemins).toMatchObject({
      chat: "/v1/chat/completions",
      modeles: "/v1/models",
      sante: "/health",
      version: "/version",
      metriques: "/metrics",
      tokenisation: "/tokenize",
      chargement: null,
      slots: null,
      infill: null,
    });
    expect(PROFILS.sglang.chemins).toMatchObject({
      sante: "/health",
      version: "/server_info",
      infos: "/server_info",
      infosModele: "/model_info",
      metriques: "/metrics",
      tokenisation: "/v1/tokenize",
      chargement: null,
    });
    expect(PROFILS.llamacpp.chemins).toMatchObject({
      infos: "/props",
      gabarit: "/apply-template",
      slots: "/slots",
    });
    expect(PROFILS.generic.chemins).toMatchObject({ sante: null, metriques: null, tokenisation: null });
  });

  it("capacités : file et chargement pour llama.cpp seul, fenêtre lue sur /v1/models pour vLLM et SGLang", () => {
    expect(PROFILS.llamacpp.capacites).toMatchObject({
      file: true,
      chargement: true,
      slots: true,
      contexte: "props",
    });
    for (const t of ["vllm", "sglang"] as const)
      expect(PROFILS[t].capacites, t).toMatchObject({
        file: false,
        chargement: false,
        slots: false,
        contexte: "modeles",
        tokenisation: "openai",
        tokenisationMessages: true,
        modelesServisCharges: true,
        jetonsEnCache: "option",
      });
    expect(PROFILS.generic.capacites).toMatchObject({ contexte: "aucune", tokenisation: null, file: false });
  });

  it("dialecte (lot M1) : étendu pour vllm et sglang au type exact, natif pour llama.cpp, réflexion des deux champs", () => {
    for (const type of ["vllm", "sglang"]) {
      expect(aDialecteEtendu(type), type).toBe(true);
      expect(profilDuType(type).dialecte.champsEtendus).toBe(CHAMPS_DIALECTE_ETENDU);
      expect(profilDuType(type).dialecte.efforts).toEqual([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
    }
    for (const type of ["llamacpp", "generic", "openai", "VLLM", "", null, undefined])
      expect(aDialecteEtendu(type), String(type)).toBe(false);
    expect(PROFILS.llamacpp.dialecte).toMatchObject({ natif: true, etendu: false, efforts: null });
    expect(PROFILS.generic.dialecte.champsEtendus.size).toBe(0);
    expect([...CHAMPS_DIALECTE_ETENDU]).toEqual([
      "chat_template_kwargs",
      "reasoning_effort",
      "top_k",
      "min_p",
      "repetition_penalty",
    ]);
    expect(texteReflexion({ reasoning: "vllm" })).toBe("vllm");
    expect(texteReflexion({ reasoning_content: "sglang", reasoning: "double" })).toBe("sglang");
    expect(texteReflexion({ reasoning_content: "", reasoning: "repli" })).toBe("repli");
    expect(texteReflexion({ reasoning: 3 })).toBe("");
    expect(texteReflexion(null)).toBe("");
  });

  it("drapeaux exacts conseillés", () => {
    expect(PROFILS.vllm.drapeaux.jetonsEnCache).toContain("--enable-prompt-tokens-details");
    expect(PROFILS.vllm.drapeaux.metriques).toContain("--disable-log-stats");
    expect(PROFILS.vllm.drapeaux.reflexion).toContain("--reasoning-parser");
    expect(PROFILS.vllm.drapeaux.outils).toContain("--enable-auto-tool-choice --tool-call-parser");
    expect(PROFILS.sglang.drapeaux.metriques).toContain("--enable-metrics");
    expect(PROFILS.sglang.drapeaux.jetonsEnCache).toContain("--enable-cache-report");
    expect(PROFILS.sglang.drapeaux.reflexion).toContain("deepseek-r1");
    expect(PROFILS.generic.drapeaux.metriques).toBeNull();
    expect(Object.isFrozen(PROFILS.vllm.chemins)).toBe(true);
  });
});

describe("configuration (config.json fait foi)", () => {
  let dossier: string;
  beforeAll(() => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-profils-"));
  });
  afterAll(() => rmSync(dossier, { recursive: true, force: true }));

  const regler = (llama: Record<string, unknown>, env: Record<string, string> = {}) =>
    calculerReglages(
      { APP_SESSION_SECRET: "secret-de-test-0123456789abcdef", ...env },
      { llama, app: { db_path: path.join(dossier, "app.db") } },
      dossier,
      path.join(dossier, "config.json"),
    ).reglages;

  it("llama.url en base, en /v1 ou complète : même URL de complétion ; ip et port gardés sans url", () => {
    for (const url of [
      "http://10.0.0.5:8000",
      "http://10.0.0.5:8000/",
      "http://10.0.0.5:8000/v1",
      "http://10.0.0.5:8000/v1/",
      "http://10.0.0.5:8000/v1/chat/completions",
    ])
      expect(urlChatLlama(url), url).toBe("http://10.0.0.5:8000/v1/chat/completions");
    expect(urlChatLlama("")).toBe("");
    expect(urlChatLlama("http://h/proxy/chat/completions")).toBe("http://h/proxy/chat/completions");
    expect(regler({ url: "http://10.0.0.5:8000", engine: "vllm" }).LLAMA_URL).toBe(
      "http://10.0.0.5:8000/v1/chat/completions",
    );
    expect(regler({ ip: "10.0.0.6", port: 30000, engine: "sglang" }).LLAMA_URL).toBe(
      "http://10.0.0.6:30000/v1/chat/completions",
    );
  });

  it("llama.engine (alias compris) et clé d'API : variable d'environnement prioritaire, absente = aucune", () => {
    expect(typeMoteurLlama("SGLang")).toBe("sglang");
    const r = regler({ url: "http://h:8000", engine: "SGLang", api_key: "  depuis-config  " });
    expect([r.LLAMA_PROVIDER_TYPE, r.LLAMA_ENGINE, r.LLAMA_API_KEY]).toEqual([
      "sglang",
      "sglang",
      "depuis-config",
    ]);
    expect(regler({ api_key: "cfg" }, { LLAMA_API_KEY: "env" }).LLAMA_API_KEY).toBe("env");
    expect(regler({ api_key: "cfg" }, { LLAMA_API_KEY: "" }).LLAMA_API_KEY).toBe("cfg");
    expect(regler({}).LLAMA_API_KEY).toBe("");
    expect(regler({}).LLAMA_PROVIDER_TYPE).toBe("llamacpp");
  });
});

describe("métriques Prometheus", () => {
  afterEach(() => oublierDebits());

  it("étiquettes gardées (échappements), lignes illisibles ignorées", () => {
    const e = lireEchantillons('a:b{x="1",y="q\\"r"} 2.5\n# HELP z\nbad line\nc{} NaN\nd 3\n');
    expect(e).toEqual([
      { nom: "a_b", etiquettes: { x: "1", y: 'q"r' }, valeur: 2.5 },
      { nom: "d", etiquettes: {}, valeur: 3 },
    ]);
  });

  it("étiquettes lues comme l'ancienne expression, longue suite de lettres en temps linéaire", () => {
    const ancienne = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/gu;
    const signes = ["a", "Z", "_", "9", "=", '"', "\\", ",", " ", "x"];
    let graine = 7;
    const hasard = (n: number): number => (graine = (graine * 48271) % 2147483647) % n;
    for (let essai = 0; essai < 3000; essai++) {
      const bloc = Array.from({ length: hasard(14) }, () => signes[hasard(signes.length)]).join("");
      const attendu: Record<string, string> = {};
      for (const e of bloc.matchAll(ancienne))
        attendu[e[1] ?? ""] = (e[2] ?? "").replace(/\\(.)/gu, (_t, c: string) => (c === "n" ? "\n" : c));
      expect(lireEchantillons(`m{${bloc}} 1`)[0]?.etiquettes, bloc).toEqual(attendu);
    }
    const debut = performance.now();
    expect(lireEchantillons(`m{${"A".repeat(100_000)}} 1`)[0]?.etiquettes).toEqual({});
    expect(performance.now() - debut).toBeLessThan(1000);
  });

  it("vLLM : cache KV en fraction × capacité de cache_config_info, cache de préfixe, débit entre deux lectures", () => {
    const texte = (gen: number) =>
      [
        'vllm:num_requests_running{engine="0",model_name="m"} 2.0',
        'vllm:num_requests_waiting{engine="0",model_name="m"} 1.0',
        'vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.5',
        'vllm:cache_config_info{block_size="16",engine="0",num_gpu_blocks="100"} 1.0',
        'vllm:prefix_cache_queries_total{engine="0",model_name="m"} 200.0',
        'vllm:prefix_cache_hits_total{engine="0",model_name="m"} 50.0',
        `vllm:generation_tokens_total{engine="0",model_name="m"} ${gen}`,
      ].join("\n");
    const a = etatCharge(PROFILS.vllm, texte(100), { cle: "t", maintenant: 10 });
    expect(a).toEqual({
      kv: { used: 800, total: 1600, pct: 50 },
      en_cours: 2,
      en_attente: 1,
      debit_tps: null,
      cache_prefixe_pct: 25,
      ttft_s: null,
      prefill_tps: null,
    });
    expect(etatCharge(PROFILS.vllm, texte(160), { cle: "t", maintenant: 12 }).debit_tps).toBe(30);
  });

  it("SGLang : total des files sans le détail par priorité, capacité donnée par /server_info", () => {
    const e = 'model_name="m",tp_rank="0"';
    const texte = [
      `sglang:num_running_reqs{${e},priority=""} 3.0`,
      `sglang:num_running_reqs{${e},priority="1"} 3.0`,
      `sglang:num_queue_reqs{${e},priority=""} 0.0`,
      `sglang:token_usage{${e}} 0.25`,
      `sglang:kv_used_tokens{${e}} 1000.0`,
      `sglang:gen_throughput{${e}} 41.27`,
      `sglang:cache_hit_rate{${e}} 0.6`,
    ].join("\n");
    expect(etatCharge(PROFILS.sglang, texte, { capaciteKv: 4000 })).toEqual({
      kv: { used: 1000, total: 4000, pct: 25 },
      en_cours: 3,
      en_attente: 0,
      debit_tps: 41.3,
      cache_prefixe_pct: 60,
      ttft_s: null,
      prefill_tps: null,
    });
  });

  it("SGLang --dp : répliques additionnées par dp_rank, rangs TP en double comptés une fois", () => {
    const texte = [
      ["0", "0", 3, 1000, 0.25, 40],
      ["0", "1", 3, 1000, 0.25, 40],
      ["1", "0", 2, 500, 0.125, 30],
      ["1", "1", 2, 500, 0.125, 30],
    ]
      .flatMap(([dp, tp, enCours, kv, ratio, debit]) => {
        const e = `dp_rank="${dp}",model_name="m",tp_rank="${tp}"`;
        return [
          `sglang:num_running_reqs{${e}} ${enCours}`,
          `sglang:num_queue_reqs{${e}} 1`,
          `sglang:kv_used_tokens{${e}} ${kv}`,
          `sglang:max_total_num_tokens{${e}} 4000`,
          `sglang:token_usage{${e}} ${ratio}`,
          `sglang:gen_throughput{${e}} ${debit}`,
        ];
      })
      .join("\n");
    expect(etatCharge(PROFILS.sglang, texte, { capaciteKv: 999 })).toMatchObject({
      kv: { used: 1500, total: 8000, pct: 18.8 },
      en_cours: 5,
      en_attente: 2,
      debit_tps: 70,
    });
  });

  it('SGLang : débit de prefill sur realtime_tokens_total{mode="prefill_compute"} seul, entre deux lectures', () => {
    const texte = (calcul: number, cache: number) =>
      ["0", "1"]
        .flatMap((dp) => [
          `sglang:realtime_tokens_total{dp_rank="${dp}",mode="prefill_compute",tp_rank="0"} ${calcul}`,
          `sglang:realtime_tokens_total{dp_rank="${dp}",mode="prefill_cache",tp_rank="0"} ${cache}`,
          `sglang:realtime_tokens_total{dp_rank="${dp}",mode="decode",tp_rank="0"} ${cache * 3}`,
        ])
        .join("\n");
    expect(
      etatCharge(PROFILS.sglang, texte(1000, 5000), { cle: "p", maintenant: 10 }).prefill_tps,
    ).toBeNull();
    expect(etatCharge(PROFILS.sglang, texte(5000, 90000), { cle: "p", maintenant: 12 }).prefill_tps).toBe(
      4000,
    );
    expect(metriquesReconnues(PROFILS.sglang, texte(1, 1))).toBe(true);
    expect(metriquesReconnues(PROFILS.sglang, "dp_rank 1\nmode 2\n")).toBe(false);
  });

  it("délai du premier jeton : moyenne de l'intervalle, stable entre deux lectures sans requête nouvelle", () => {
    const texte = (somme: number, compte: number) =>
      [
        `sglang:time_to_first_token_seconds_bucket{le="1.0",model_name="m"} ${compte}`,
        `sglang:time_to_first_token_seconds_sum{model_name="m"} ${somme}`,
        `sglang:time_to_first_token_seconds_count{model_name="m"} ${compte}`,
      ].join("\n");
    const ttft = (somme: number, compte: number, cle = "t") =>
      etatCharge(PROFILS.sglang, texte(somme, compte), { cle }).ttft_s;
    expect(ttft(0, 0)).toBeNull();
    expect(ttft(10, 10)).toBe(1);
    expect(ttft(10, 10)).toBe(1);
    expect(ttft(14, 12)).toBe(2);
    expect(ttft(14, 12)).toBe(2);
    expect(ttft(14, 12)).toBe(2);
    expect(ttft(15, 14)).toBe(0.5);
    expect(ttft(15, 14)).toBe(0.5);
    expect(ttft(3, 2)).toBe(1.5);
    expect(ttft(9, 3, "autre")).toBe(3);
    expect(metriquesReconnues(PROFILS.sglang, texte(1, 1))).toBe(true);
    expect(etatCharge(PROFILS.vllm, texte(1, 1).replaceAll("sglang:", "vllm:")).ttft_s).toBe(1);
  });

  it("llama.cpp : même jauge qu'avant (jetons du cache ÷ n_ctx_total)", () => {
    const k = etatCharge(PROFILS.llamacpp, "llamacpp:kv_cache_tokens 512\nllamacpp:n_ctx_total 2048\n").kv;
    expect(k).toEqual({ used: 512, total: 2048, pct: 25 });
  });
});

/** Moteur du process rechargé contre un faux serveur du type demandé. */
async function monter(
  type: "vllm" | "sglang",
  options: OptionsFauxMoteur = {},
  reglages: Record<string, unknown> = {},
): Promise<[Moteur, FauxMoteur]> {
  const faux = await demarrerFauxMoteur({ type, cleApi: CLE, ...options });
  const m = await moteurFrais({
    LLAMA_URL: `${faux.url}/v1/chat/completions`,
    LLAMA_PROVIDER_TYPE: type,
    LLAMA_ENGINE: type,
    LLAMA_API_KEY: CLE,
    LLAMA_MODEL: faux.options.modele,
    ...reglages,
  });
  return [m, faux];
}

describe.each(["vllm", "sglang"] as const)("moteur intégré %s (faux serveur fidèle)", (type) => {
  let m: Moteur;
  let faux: FauxMoteur;

  beforeAll(async () => {
    [m, faux] = await monter(type, { detailsJetons: type === "sglang", metriques: true });
  });
  afterAll(async () => {
    await m.fermer();
    await faux.arreter();
  });

  it("clé d'API envoyée en Bearer sur chaque appel, jamais dans la représentation du moteur", async () => {
    const eng = m.moteurs.builtinEngine();
    expect(eng.headerDict()).toEqual({ Authorization: `Bearer ${CLE}` });
    expect(String(eng)).not.toContain(CLE);
    expect(JSON.stringify(eng)).not.toContain(CLE);
    faux.etat.requetes.length = 0;
    await m.sante.getLlmHealth();
    expect(faux.etat.requetes.length).toBeGreaterThan(0);
    for (const r of faux.etat.requetes) expect(r.autorisation, r.url).toBe(`Bearer ${CLE}`);
  });

  it("santé agrégée : modèle servi = en mémoire, fenêtre max_model_len, cache KV et charge, profil décrit", async () => {
    const h = await m.sante.getLlmHealth();
    expect(h["server_reachable"]).toBe(true);
    expect(h["moteur"]).toEqual({
      type,
      libelle: type === "vllm" ? "vLLM" : "SGLang",
      chargement: false,
      file: false,
      contexte: true,
    });
    expect(h["props"]).toMatchObject({ n_ctx: faux.options.contexte });
    expect((h["kv_cache"] as { total: number }).total).toBe(
      type === "vllm" ? faux.options.blocsKv * faux.options.tailleBloc : faux.options.jetonsKv,
    );
    expect(h["charge"]).toMatchObject({ en_cours: 0, en_attente: 0 });
    expect(await m.sante.getRemoteModelsWithStatus()).toEqual([
      { id: faux.options.modele, status: "loaded", vision: false },
    ]);
    expect(await m.sante.getCurrentlyLoadedModel()).toBe(faux.options.modele);
  });

  it("fenêtre de contexte : getModelContextSize et resolveContextWindow lisent max_model_len", async () => {
    m.modeles.invalidateContextSizeCache();
    m.fenetre.invalidateCache();
    expect(await m.modeles.getModelContextSize(faux.options.modele)).toBe(faux.options.contexte);
    expect(await m.fenetre.resolveContextWindow(faux.options.modele, m.cible.defaultTarget())).toBe(
      faux.options.contexte,
    );
    expect(await m.modeles.getModelTotalSlots()).toBe(0);
    expect(await m.modeles.getBusySlotsSnapshot()).toBeNull();
  });

  it("tokenisation exacte : texte (prompt) et conversation rendue (messages) en un appel", async () => {
    m.tokens.invalidateTokenizeCache();
    faux.etat.requetes.length = 0;
    expect(await m.tokens.countTokensExact("Bonjour Elpis, ceci est un test.")).toBe(8);
    const messages = [
      { role: "system", content: "Tu es Elpis." },
      { role: "user", content: "Salut" },
    ];
    const n = await m.tokens.countRenderedPromptTokensExact(messages);
    expect(n).toBeGreaterThan(0);
    const chemin = type === "vllm" ? "/tokenize" : "/v1/tokenize";
    const appels = faux.etat.requetes.filter((r) => r.url === chemin);
    expect(appels.map((r) => Object.keys(r.corps ?? {}).sort())).toEqual([
      ["add_special_tokens", "prompt"],
      type === "vllm" ? ["add_generation_prompt", "messages"] : ["messages"],
    ]);
    expect(faux.etat.requetes.some((r) => r.url === "/apply-template")).toBe(false);
    const [jetons, estime] = await m.raisonnement.measureThinkingTokens("Je réfléchis un peu.");
    expect([jetons, estime]).toEqual([5, false]);
  });

  it("aucun chargement : inventaire du routeur vide, infill refusé sans appel au serveur", async () => {
    expect((await m.inventaire.modelStatuses("", true)).size).toBe(0);
    faux.etat.requetes.length = 0;
    const r = await m.infill.llmInfill("def f(", ")", null);
    expect(r).toMatchObject({ ok: false });
    expect(String(r["error"])).toContain(type === "vllm" ? "vLLM" : "SGLang");
    expect(faux.etat.requetes).toEqual([]);
  });

  it("concurrence : hors file d'Elpis, deux générations simultanées atteignent le moteur ensemble", async () => {
    const process = await import("../../src/llm/ordonnanceur/process");
    const eng = m.moteurs.builtinEngine();
    expect(process.moteurDeFile(eng).enFile).toBe(false);
    expect(await process.etatFile(faux.options.modele, eng)).toEqual({
      kind: "ready",
      model: faux.options.modele,
    });
    faux.etat.maxEnCours = 0;
    faux.etat.script.push({ contenu: "un", delaiMs: 300 }, { contenu: "deux", delaiMs: 300 });
    const generer = () =>
      process.avecLLM(eng, faux.options.modele, "high", undefined, async () => {
        const r = await fetch(`${faux.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${CLE}` },
          body: JSON.stringify({ model: faux.options.modele, messages: [{ role: "user", content: "x" }] }),
        });
        return r.status;
      });
    expect(await Promise.all([generer(), generer()])).toEqual([200, 200]);
    expect(faux.etat.maxEnCours).toBe(2);
  });

  it("sonde : version, modèle servi, contexte, métriques, tokenisation, clé jamais rendue", async () => {
    const sonde = await import("../../src/llm/sonde-moteur");
    const r = await sonde.sonderMoteur(m.moteurs.builtinEngine(), { generation: true });
    expect(r).toMatchObject({
      type,
      joignable: true,
      version: type === "vllm" ? "0.31.0" : "0.5.21",
      modele_servi: faux.options.modele,
      contexte: faux.options.contexte,
      metriques: true,
      tokenisation: true,
      cle_api: true,
      chargement: false,
      concurrence: { mode: "moteur", max: type === "sglang" ? faux.options.maxRequetes : null },
    });
    expect(r.adresses.every((a) => a.ok)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CLE);
    if (type === "vllm") {
      expect(r.jetons_en_cache).toBe(false);
      expect(r.conseils.map((c) => c.code)).toEqual(["jetons_en_cache"]);
      expect(r.conseils[0]?.message).toContain("--enable-prompt-tokens-details");
      expect(r.parseurs_connus).toBe(false);
    } else {
      expect(r).toMatchObject({ jetons_en_cache: true, parseurs_connus: true, parseur_reflexion: "qwen3" });
      expect(r.conseils).toEqual([]);
    }
    expect(sonde.dernierRapportIntegre()).toEqual(r);
  });
});

describe("conseils de la sonde (options manquantes, adresses muettes)", () => {
  it("vLLM sans statistiques ni détail des jetons, modèle déclaré non servi", async () => {
    const [m, faux] = await monter(
      "vllm",
      { metriques: false, detailsJetons: true },
      { LLAMA_MODEL: "local-model" },
    );
    try {
      const sonde = await import("../../src/llm/sonde-moteur");
      const r = await sonde.sonderMoteur(m.moteurs.builtinEngine(), { generation: true });
      expect(r.metriques).toBe(false);
      expect(r.jetons_en_cache).toBe(true);
      const codes = Object.fromEntries(r.conseils.map((c) => [c.code, c.message]));
      expect(codes["metriques"]).toContain("retirez --disable-log-stats");
      expect(codes["modele"]).toContain("« local-model »");
      expect(codes["modele"]).toContain(faux.options.modele);
    } finally {
      await m.fermer();
      await faux.arreter();
    }
  });

  it("vLLM : réponse sans prompt_tokens_details observée, conseil ajouté au dernier rapport sans nouvelle sonde", async () => {
    const [m, faux] = await monter("vllm", { metriques: true });
    try {
      const sonde = await import("../../src/llm/sonde-moteur");
      const r = await sonde.sonderMoteur(m.moteurs.builtinEngine());
      expect(r.jetons_en_cache).toBeNull();
      expect(r.conseils.map((c) => c.code)).not.toContain("jetons_en_cache");
      sonde.observerUsage({
        prompt_tokens: 9,
        total_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: null,
      });
      const vu = sonde.dernierRapportIntegre();
      expect(vu?.jetons_en_cache).toBe(false);
      expect(vu?.conseils.find((c) => c.code === "jetons_en_cache")?.message).toContain(
        "--enable-prompt-tokens-details",
      );
    } finally {
      await m.fermer();
      await faux.arreter();
    }
  });

  it("parseur d'outils attendu : Qwen3-Coder quel que soit le préfixe, id géant en temps linéaire, inconnu sans conclusion", async () => {
    const { parseursOutilsAttendus } = await import("../../src/llm/sonde-moteur");
    for (const id of [
      "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "unsloth/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "/modeles/org/sous-org/qwen3-coder-next",
      "qwen3-30b-coder",
    ])
      expect(parseursOutilsAttendus(id), id).toEqual(["qwen3_coder"]);
    expect(parseursOutilsAttendus("qwen3/coder-legacy")).toBeNull();
    expect(parseursOutilsAttendus("zai-org/GLM-4.7")).toEqual(["glm47"]);
    expect(parseursOutilsAttendus("moonshotai/Kimi-K2-Instruct")).toEqual(["kimi_k2"]);
    for (const inconnu of [
      "Qwen/Qwen3-8B",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V3.2-Exp",
      "",
      null,
    ])
      expect(parseursOutilsAttendus(inconnu), String(inconnu)).toBeNull();
    const debut = performance.now();
    expect(parseursOutilsAttendus("qwen3".repeat(40000))).toBeNull();
    expect(performance.now() - debut).toBeLessThan(50);
  });

  it("SGLang : parseur d'outils comparé au format du modèle servi, réponse avalée imputée aux deux parseurs", async () => {
    const modele = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
    for (const [parseurOutils, attendu] of [
      ["qwen25", ["parseur_outils"]],
      ["qwen3_coder", []],
    ] as const) {
      const [m, faux] = await monter("sglang", {
        metriques: true,
        detailsJetons: true,
        modele,
        parseurOutils,
      });
      try {
        const sonde = await import("../../src/llm/sonde-moteur");
        const eng = m.moteurs.builtinEngine();
        const r = await sonde.sonderMoteur(eng);
        expect(r.conseils.map((c) => c.code)).toEqual(attendu);
        if (attendu.length) {
          expect(r.conseils[0]?.niveau).toBe("info");
          expect(r.conseils[0]?.message).toContain(`« qwen25 » pour ${modele}`);
          expect(r.conseils[0]?.message).toContain("--tool-call-parser qwen3_coder");
          continue;
        }
        sonde.noterObservation(eng, "outils_avales");
        const outils = sonde.dernierRapportIntegre()?.conseils.find((c) => c.code === "outils");
        expect(outils?.niveau).toBe("avertissement");
        expect(outils?.message).toContain(
          "le parseur d'appels d'outils ou le parseur de réflexion ne correspond peut-être pas au modèle",
        );
        expect(outils?.message).toContain("--tool-call-parser");
        expect(outils?.message).toContain("--reasoning-parser");
      } finally {
        await m.fermer();
        await faux.arreter();
      }
    }
  });

  it("SGLang sans métriques ni parseurs : drapeaux exacts ; clé refusée et serveur absent signalés", async () => {
    const [m, faux] = await monter("sglang", {
      metriques: false,
      parseurReflexion: null,
      parseurOutils: null,
    });
    try {
      const sonde = await import("../../src/llm/sonde-moteur");
      const r = await sonde.sonderMoteur(m.moteurs.builtinEngine());
      const codes = Object.fromEntries(r.conseils.map((c) => [c.code, c]));
      expect(codes["metriques"]?.message).toContain("ajoutez --enable-metrics");
      expect(codes["reflexion"]?.message).toContain("--reasoning-parser");
      expect(codes["outils"]?.message).toContain("--tool-call-parser");
      expect(codes["outils"]?.niveau).toBe("avertissement");
      m.config.surchargerConfig({ LLAMA_API_KEY: "mauvaise" });
      const refus = await sonde.sonderMoteur(m.moteurs.builtinEngine());
      expect(refus.conseils.find((c) => c.code === "cle")?.message).toContain("llama.api_key");
    } finally {
      await m.fermer();
      await faux.arreter();
    }
    const m2 = await moteurFrais({
      LLAMA_URL: "http://127.0.0.1:9/v1/chat/completions",
      LLAMA_PROVIDER_TYPE: "sglang",
    });
    try {
      const sonde = await import("../../src/llm/sonde-moteur");
      const r = await sonde.sonderMoteur(m2.moteurs.builtinEngine());
      expect(r.joignable).toBe(false);
      expect(r.conseils).toEqual([
        {
          code: "injoignable",
          niveau: "erreur",
          message:
            "SGLang ne répond pas sur http://127.0.0.1:9/health : vérifiez llama.url et que le serveur est lancé.",
        },
      ]);
    } finally {
      await m2.fermer();
    }
  });
});

describe("connecteurs vLLM et SGLang : même profil que le moteur intégré", () => {
  it("cible d'un connecteur sglang : adresses du profil, clé du connecteur", async () => {
    const faux = await demarrerFauxMoteur({ type: "sglang", cleApi: "cle-du-connecteur" });
    const m = await moteurFrais({});
    try {
      const cible = new m.cible.LlmTarget({
        providerType: "sglang",
        baseUrl: `${faux.url}/v1`,
        apiKey: "cle-du-connecteur",
        connectorId: 7,
        isDefault: false,
      });
      expect(cible.profil.type).toBe("sglang");
      const eng = m.moteurs.engineForTarget(cible);
      expect([eng.key, eng.baseRoot, eng.profil.libelle]).toEqual(["conn:7", faux.url, "SGLang"]);
      const h = await m.sante.getLlmHealth(eng);
      expect(h["server_reachable"]).toBe(true);
      expect(h["props"]).toMatchObject({ n_ctx: faux.options.contexte });
      expect(await m.fenetre.resolveContextWindow(faux.options.modele, cible)).toBe(faux.options.contexte);
      expect(
        faux.etat.requetes.every((r) => r.url === "/health" || r.autorisation === "Bearer cle-du-connecteur"),
      ).toBe(true);
    } finally {
      await m.fermer();
      await faux.arreter();
    }
  });
});
