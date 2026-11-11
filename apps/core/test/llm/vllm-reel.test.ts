// SPDX-License-Identifier: MIT
/** apps/core/test/llm/vllm-reel.test.ts — profil vLLM contre un VRAI vLLM 0.31 (`ELPIS_VLLM_URL`, sauté sinon) : sonde, santé, fenêtre, tokenisation exacte égale au `prompt_tokens` du moteur, et formats du faux serveur comparés au vrai. */
import "./environnement-fournisseurs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { demarrerFauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import type { FauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import { lireEchantillons } from "../../src/llm/metriques-moteur";
import { moteurFrais } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

const URL_VLLM = (process.env["ELPIS_VLLM_URL"] ?? "").replace(/\/+$/u, "");
const CLE = process.env["ELPIS_VLLM_CLE"] ?? "";

type Dict = Record<string, unknown>;

async function lire(url: string, init: RequestInit = {}): Promise<[number, string]> {
  const r = await fetch(url, {
    ...init,
    headers: { ...(CLE ? { authorization: `Bearer ${CLE}` } : {}), ...(init.headers ?? {}) },
  });
  return [r.status, await r.text()];
}

const cles = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o).sort() : []);

describe.skipIf(!URL_VLLM)("vrai vLLM (ELPIS_VLLM_URL)", () => {
  let m: Moteur;
  let faux: FauxMoteur;
  let modele = "";

  let contexte = 0;
  let detailsJetons = false;
  let parseur = false;

  beforeAll(async () => {
    const [, corps] = await lire(`${URL_VLLM}/v1/models`);
    const entree = (JSON.parse(corps) as { data: Dict[] }).data[0] ?? {};
    modele = String(entree["id"] ?? "");
    contexte = Number(entree["max_model_len"] ?? 0);
    const [, essai] = await lire(`${URL_VLLM}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modele, messages: [{ role: "user", content: "OK" }], max_tokens: 1 }),
    });
    const usage = (JSON.parse(essai) as { usage: Dict }).usage;
    detailsJetons = (usage["prompt_tokens_details"] ?? null) !== null;
    parseur = (usage["completion_tokens_details"] ?? null) !== null;
    m = await moteurFrais({
      LLAMA_URL: `${URL_VLLM}/v1/chat/completions`,
      LLAMA_PROVIDER_TYPE: "vllm",
      LLAMA_ENGINE: "vllm",
      LLAMA_API_KEY: CLE,
      LLAMA_MODEL: modele,
    });
    faux = await demarrerFauxMoteur({
      type: "vllm",
      modele,
      contexte,
      detailsJetons,
      parseurReflexion: parseur ? "qwen3" : null,
    });
  }, 60_000);

  afterAll(async () => {
    await m?.fermer();
    await faux?.arreter();
  });

  it("sonde : joignable, version 0.31, modèle servi, contexte, métriques et tokenisation", async () => {
    const sonde = await import("../../src/llm/sonde-moteur");
    const r = await sonde.sonderMoteur(m.moteurs.builtinEngine(), { generation: true });
    expect(r.joignable).toBe(true);
    expect(r.version ?? "").toMatch(/^0\.31\./u);
    expect(r.modele_servi).toBe(modele);
    expect(r.contexte ?? 0).toBeGreaterThan(0);
    expect(r.metriques).toBe(true);
    expect(r.tokenisation).toBe(true);
    expect(r.jetons_en_cache).toBe(detailsJetons);
    expect(r.adresses.filter((a) => !a.ok)).toEqual([]);
  }, 120_000);

  it("santé : jauge KV d'après kv_cache_usage_perc et cache_config_info, fenêtre max_model_len", async () => {
    const h = await m.sante.getLlmHealth();
    expect(h["server_reachable"]).toBe(true);
    expect((h["kv_cache"] as { total: number }).total).toBeGreaterThan(0);
    expect(h["charge"]).toMatchObject({ en_cours: expect.any(Number), en_attente: expect.any(Number) });
    m.modeles.invalidateContextSizeCache();
    expect(await m.modeles.getModelContextSize(modele)).toBe((h["props"] as { n_ctx: number }).n_ctx);
  }, 60_000);

  it("tokenisation exacte : le prompt rendu compte exactement le prompt_tokens de la complétion", async () => {
    const messages = [
      { role: "system", content: "Tu es Elpis, un assistant concis." },
      { role: "user", content: "Combien font deux et deux ?" },
    ];
    m.tokens.invalidateTokenizeCache();
    const compte = await m.tokens.countRenderedPromptTokensExact(messages);
    const [statut, corps] = await lire(`${URL_VLLM}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modele, messages, max_tokens: 1, stream: false }),
    });
    expect(statut).toBe(200);
    const usage = (JSON.parse(corps) as { usage: { prompt_tokens: number } }).usage;
    expect(compte).toBe(usage.prompt_tokens);
    expect(await m.tokens.countTokensExact("Bonjour Elpis")).toBeGreaterThan(0);
  }, 120_000);

  it("formats du faux serveur identiques au vrai (modèles, version, tokenisation, métriques, réponse, usage en flux)", async () => {
    for (const chemin of ["/v1/models", "/version"]) {
      const [, vrai] = await lire(`${URL_VLLM}${chemin}`);
      const [, simule] = await lire(`${faux.url}${chemin}`);
      const v = JSON.parse(vrai) as Dict;
      const s = JSON.parse(simule) as Dict;
      if (chemin === "/v1/models")
        expect(cles((s["data"] as Dict[])[0]), chemin).toEqual(cles((v["data"] as Dict[])[0]));
      else expect(cles(s), chemin).toEqual(cles(v));
    }
    const corps = JSON.stringify({ prompt: "Bonjour", add_special_tokens: false });
    const [, tv] = await lire(`${URL_VLLM}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: corps,
    });
    const [, ts] = await lire(`${faux.url}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: corps,
    });
    expect(cles(JSON.parse(ts))).toEqual(cles(JSON.parse(tv)));
    const [, mv] = await lire(`${URL_VLLM}/metrics`);
    const [, ms] = await lire(`${faux.url}/metrics`);
    const nomsVrais = new Set(lireEchantillons(mv).map((e) => e.nom));
    for (const nom of new Set(lireEchantillons(ms).map((e) => e.nom)))
      if (nom.startsWith("vllm_")) expect(nomsVrais.has(nom), nom).toBe(true);
    const info = lireEchantillons(mv).find((e) => e.nom === "vllm_cache_config_info");
    expect(cles(info?.etiquettes)).toEqual(
      expect.arrayContaining(["block_size", "kv_cache_size_tokens", "num_gpu_blocks"]),
    );
    const demande = JSON.stringify({
      model: modele,
      messages: [{ role: "user", content: "OK" }],
      max_tokens: 1,
    });
    const [, cv] = await lire(`${URL_VLLM}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: demande,
    });
    const [, cs] = await lire(`${faux.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: demande,
    });
    const [rv, rs] = [JSON.parse(cv) as Dict, JSON.parse(cs) as Dict];
    expect(cles(rs)).toEqual(cles(rv));
    const choix = (r: Dict): Dict => (r["choices"] as Dict[])[0] ?? {};
    expect(cles(choix(rs))).toEqual(cles(choix(rv)));
    expect(cles(choix(rs)["message"])).toEqual(cles(choix(rv)["message"]));
    expect(cles(rs["usage"])).toEqual(cles(rv["usage"]));
    const details = (r: Dict): unknown => (r["usage"] as Dict)["prompt_tokens_details"];
    expect(cles(details(rs))).toEqual(cles(details(rv)));
    const flux = JSON.stringify({
      ...JSON.parse(demande),
      stream: true,
      stream_options: { include_usage: true },
    });
    const dernier = async (base: string): Promise<Dict> => {
      const [, texte] = await lire(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: flux,
      });
      const lignes = texte.split("\n").filter((l) => l.startsWith("data: {"));
      return JSON.parse((lignes.at(-1) ?? "data: {}").slice(6)) as Dict;
    };
    const [uv, us] = [(await dernier(URL_VLLM))["usage"] as Dict, (await dernier(faux.url))["usage"] as Dict];
    expect(cles(us)).toEqual(cles(uv));
    expect(cles(us["prompt_tokens_details"])).toEqual(cles(uv["prompt_tokens_details"]));
  }, 120_000);
});
