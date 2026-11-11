// SPDX-License-Identifier: MIT
/** apps/core/test/llm/routes-moteurs.test.ts — routes de main et de la console contre un faux vLLM (moteur intégré) et un faux SGLang (connecteur) : catalogue, chargement refusé, propriétés, sonde « Tester », clé jamais rendue, config.json masqué. */
import "./environnement-fournisseurs";

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, configurerCoffre, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { demarrerFauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import type { FauxMoteur } from "../../../../tests/frontend/lib/faux-moteurs.mjs";
import { composer } from "../../src/composition";
import { invalidateCache as oublierAcces } from "../../src/llm/acces-moteurs";
import { arreterSondeModeles, viderCacheModeles } from "../../src/llm/cache-modeles";
import { closeLlmClient } from "../../src/llm/client-http";
import { createConnector } from "../../src/llm/connecteurs";
import { invalidate as oublierCaps } from "../../src/llm/fournisseurs/llama-capacites";
import { viderInventaires } from "../../src/llm/fournisseurs/llama-modeles";
import { closeAdminClient } from "../../src/llm/llama-http";
import { invalidateAllModelCaches } from "../../src/llm/modeles";
import { installerOrdonnanceur } from "../../src/llm/ordonnanceur/process";
import { oublierSondes } from "../../src/llm/sonde-moteur";
import { appTest, journalMuet } from "../aides";

type Dict = Record<string, unknown>;

const T = 1_791_331_200;
const SECRET = "secret-de-test";
const CLE_VLLM = "cle-vllm-jamais-rendue";
const CLE_SGLANG = "cle-sglang-du-connecteur";
const ADMIN = 1;
const BOB = 2;

let dossier: string;
const envAvant = {
  ELPIS_AUDIT_DIR: process.env["ELPIS_AUDIT_DIR"],
  ELPIS_ENGINE_ACCESS_DIR: process.env["ELPIS_ENGINE_ACCESS_DIR"],
};

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-routes-moteurs-"));
  process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
  process.env["ELPIS_ENGINE_ACCESS_DIR"] = path.join(dossier, "acces");
  oublierConfigurationAudit();
  configurerChiffrement({ cleEnv: "unit-test-master-key", fichierCle: path.join(dossier, ".k") });
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: path.join(dossier, "absente.key"),
    repli: path.join(dossier, ".vault.key"),
  });
});

afterAll(() => {
  for (const [nom, valeur] of Object.entries(envAvant)) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

function cookie(uid: number): string {
  return `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}`;
}

function aNeuf(): void {
  arreterSondeModeles();
  viderCacheModeles();
  oublierCaps();
  viderInventaires();
  invalidateAllModelCaches();
  installerOrdonnanceur(null);
  oublierAcces();
  oublierSondes();
}

describe("moteurs vLLM (intégré) et SGLang (connecteur) de bout en bout", () => {
  let t: BaseDeTest;
  let vllm: FauxMoteur;
  let sglang: FauxMoteur;
  let configJson: string;
  let restaurer: () => void;
  const apps: FastifyInstance[] = [];

  async function monter(mode: "main" | "admin"): Promise<FastifyInstance> {
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => SECRET,
      jetonService: () => "",
      maintenant: () => T,
    };
    const c = await composer(mode, t.base, journalMuet, dep, dossier);
    const app = await appTest({ ...c, mode });
    apps.push(app);
    return app;
  }

  function appel(
    app: FastifyInstance,
    uid: number,
    method: "GET" | "POST" | "PATCH",
    url: string,
    corps?: unknown,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url,
      headers: {
        cookie: cookie(uid),
        ...(corps === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
    });
  }

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [nom, admin] of [
      ["admin", 1],
      ["bob", 0],
    ] as const)
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
        [nom, admin],
      );
    vllm = await demarrerFauxMoteur({ type: "vllm", cleApi: CLE_VLLM, contexte: 8192 });
    sglang = await demarrerFauxMoteur({
      type: "sglang",
      cleApi: CLE_SGLANG,
      detailsJetons: true,
      contexte: 16384,
    });
    configJson = path.join(dossier, "config.json");
    const llama = { engine: "vllm", url: vllm.url, api_key: CLE_VLLM, model: vllm.options.modele };
    // Un flottant écrit `1.0` et un entier hors de la plage sûre : le masque ne doit pas les réécrire.
    writeFileSync(
      configJson,
      `{"llama": ${JSON.stringify(llama)}, "llm": {"temperature": 1.0, "graine": 9007199254740993}}`,
    );
    restaurer = surchargerConfig({
      LLAMA_URL: `${vllm.url}/v1/chat/completions`,
      LLAMA_PROVIDER_TYPE: "vllm",
      LLAMA_ENGINE: "vllm",
      LLAMA_API_KEY: CLE_VLLM,
      LLAMA_MODEL: vllm.options.modele,
      CONFIG_JSON_PATH: configJson,
    });
    invalidateConfigCache();
    aNeuf();
  });

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    aNeuf();
    restaurer();
    await closeLlmClient();
    await closeAdminClient();
    await vllm.arreter();
    await sglang.arreter();
    await t.fermer();
  });

  it("catalogue de l'intégré vLLM : modèle servi chargé, profil sans chargement, fenêtre et jauge ; charger refusé sans appel", async () => {
    const app = await monter("main");
    const r = await appel(app, BOB, "GET", "/api/llm/models");
    const c = r.json() as Dict;
    expect(c).toMatchObject({
      models: [vllm.options.modele],
      models_with_status: [{ id: vllm.options.modele, status: "loaded" }],
      server_reachable: true,
      moteur: { type: "vllm", libelle: "vLLM", chargement: false, file: false, contexte: true },
      props: { n_ctx: 8192 },
      kv_cache: { total: vllm.options.blocsKv * vllm.options.tailleBloc },
      charge: { en_cours: 0, en_attente: 0 },
    });
    expect(r.body).not.toContain(CLE_VLLM);
    vllm.etat.requetes.length = 0;
    const charge = await appel(app, ADMIN, "POST", "/api/llm/models/load", { model_path: "autre" });
    expect(charge.json()).toEqual({
      ok: false,
      error: "vLLM ne charge ni ne décharge de modèle : le modèle est choisi au lancement du serveur.",
    });
    const decharge = await appel(app, ADMIN, "POST", "/api/llm/models/unload", {
      model_id: vllm.options.modele,
    });
    expect(decharge.json()).toMatchObject({ ok: false });
    expect(vllm.etat.requetes.filter((q) => q.url.startsWith("/models"))).toEqual([]);
    const props = await appel(
      app,
      BOB,
      "GET",
      `/api/llm/models/${encodeURIComponent(vllm.options.modele)}/props`,
    );
    expect(props.json()).toMatchObject({
      id: vllm.options.modele,
      max_model_len: 8192,
      n_ctx: 8192,
      moteur: "vLLM",
      version: "0.31.0",
    });
  });

  it("connecteur SGLang : modèles servis, fenêtre, jauge, profil ; test avec sonde sur demande, clé jamais rendue", async () => {
    const cid = await createConnector(t.base, {
      scope: "shared",
      provider_type: "sglang",
      wire: "openai",
      base_url: `${sglang.url}/v1`,
      api_key: CLE_SGLANG,
    });
    const main = await monter("main");
    const m = await appel(main, BOB, "GET", `/api/llm/connectors/${cid}/models`);
    expect(m.json()).toMatchObject({
      provider_type: "sglang",
      router: false,
      ok: true,
      models: [sglang.options.modele],
      statuses: { [sglang.options.modele]: "loaded" },
      moteur: { type: "sglang", chargement: false, contexte: true },
      n_ctx: 16384,
      kv_cache: { total: sglang.options.jetonsKv },
    });
    expect(m.body).not.toContain(CLE_SGLANG);
    expect(
      sglang.etat.requetes
        .filter((q) => q.url !== "/health" && q.url !== "/metrics")
        .every((q) => q.autorisation === `Bearer ${CLE_SGLANG}`),
    ).toBe(true);

    const admin = await monter("admin");
    const sansSonde = await appel(admin, ADMIN, "POST", `/api/admin/llm/connectors/${cid}/test`);
    expect(sansSonde.json()).toEqual({ ok: true, status: 200, models_count: 1 });
    const test = await appel(admin, ADMIN, "POST", `/api/admin/llm/connectors/${cid}/test?sonde=1`);
    const corps = test.json() as { sonde: Dict };
    expect(corps.sonde).toMatchObject({
      cle: `conn:${cid}`,
      type: "sglang",
      joignable: true,
      version: "0.5.21",
      contexte: 16384,
      metriques: true,
      tokenisation: true,
      jetons_en_cache: true,
      parseurs_connus: true,
      concurrence: { mode: "moteur", max: sglang.options.maxRequetes },
      conseils: [],
    });
    expect(test.body).not.toContain(CLE_SGLANG);
  });

  it("console : rapport du moteur intégré, « Tester » avec conseil exact ; clé masquée dans config.json lu et préservée", async () => {
    const admin = await monter("admin");
    const lu = await appel(admin, ADMIN, "GET", "/api/admin/llm/engine");
    expect((lu.json() as { rapport: Dict }).rapport).toMatchObject({
      type: "vllm",
      joignable: true,
      version: "0.31.0",
    });
    const test = await appel(admin, ADMIN, "POST", "/api/admin/llm/engine/test");
    const rapport = (test.json() as { rapport: { conseils: { code: string; message: string }[] } }).rapport;
    expect(rapport.conseils.map((c) => c.code)).toEqual(["jetons_en_cache"]);
    expect(rapport.conseils[0]?.message).toContain("--enable-prompt-tokens-details");
    expect(test.body).not.toContain(CLE_VLLM);
    expect((await appel(admin, BOB, "GET", "/api/admin/llm/engine")).statusCode).toBe(403);

    const fichier = await appel(admin, ADMIN, "GET", "/api/admin/config-file?type=main");
    const contenu = (fichier.json() as { content: string }).content;
    expect(contenu).not.toContain(CLE_VLLM);
    expect(JSON.parse(contenu)).toMatchObject({ llama: { api_key: "********", engine: "vllm" } });
    expect(contenu).toContain('"temperature": 1.0');
    expect(contenu).toContain('"graine": 9007199254740993');
    const ecrit = await appel(admin, ADMIN, "POST", "/api/admin/config-file", {
      type: "main",
      content: contenu,
    });
    expect(ecrit.json()).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(configJson, "utf-8"))).toMatchObject({ llama: { api_key: CLE_VLLM } });
    const patch = await appel(admin, ADMIN, "PATCH", "/api/admin/config", {
      changes: [{ path: "llama.api_key", from: "********", to: "nouvelle-cle" }],
    });
    expect(patch.json()).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(configJson, "utf-8"))).toMatchObject({
      llama: { api_key: "nouvelle-cle" },
    });
    await appel(admin, ADMIN, "PATCH", "/api/admin/config", {
      changes: [{ path: "llama.api_key", from: "********", to: "********" }],
    });
    expect(JSON.parse(readFileSync(configJson, "utf-8"))).toMatchObject({
      llama: { api_key: "nouvelle-cle" },
    });

    const main = await monter("main");
    const cfg = await appel(main, BOB, "GET", "/api/config");
    expect(cfg.body).not.toContain("nouvelle-cle");
  });
});
