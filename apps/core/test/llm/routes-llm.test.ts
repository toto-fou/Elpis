// SPDX-License-Identifier: MIT
/** apps/core/test/llm/routes-llm.test.ts — famille `/api/llm` de bout en bout contre de faux serveurs (llama-server, OpenAI, Anthropic) : gardes, connecteurs sans secret, modèles, propriétés, cycle de vie, infill sous l'ordonnanceur, file ; SQLite et PostgreSQL. */
import "./environnement-fournisseurs";

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, configurerCoffre, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { composer } from "../../src/composition";
import { creerFamilleLlm, reglagesLlm } from "../../src/familles/llm";
import { Journal } from "../../src/journal";
import { invalidateCache as oublierAcces, setPolicy } from "../../src/llm/acces-moteurs";
import { arreterSondeModeles, modelCache, viderCacheModeles } from "../../src/llm/cache-modeles";
import { closeLlmClient } from "../../src/llm/client-http";
import { createConnector, getSecretForUser } from "../../src/llm/connecteurs";
import { ANTHROPIC_CATALOG } from "../../src/llm/fournisseurs/decouverte";
import { invalidate as oublierCaps } from "../../src/llm/fournisseurs/llama-capacites";
import { viderInventaires } from "../../src/llm/fournisseurs/llama-modeles";
import { closeAdminClient } from "../../src/llm/llama-http";
import { invalidateAllModelCaches } from "../../src/llm/modeles";
import { builtinEngine } from "../../src/llm/moteurs";
import { LLMQueue } from "../../src/llm/ordonnanceur";
import type { Moteur } from "../../src/llm/ordonnanceur";
import {
  installerOrdonnanceur,
  occupation,
  ordonnanceur,
  sourcesDuProcess,
  tenirModele,
} from "../../src/llm/ordonnanceur/process";
import { describeEffectiveParams, describeEffectiveParamsDegraded } from "../../src/llm/parametres";
import { installerDiffusion } from "../../src/llm/ports";
import { loadedModelCache } from "../../src/llm/sante";
import { appTest, journalMuet, lignesAuditRecentes } from "../aides";
import { attendreQue, ouvrirFlux } from "../evenements/aides";
import { fauxLlama, FauxServeur, portFerme } from "./faux-serveur";

type Dict = Record<string, unknown>;
type Methode = "GET" | "POST" | "PUT" | "DELETE";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T = 1_791_331_200;
const FENETRE = {
  ctx_size: expect.any(Number),
  buffer_tokens: expect.any(Number),
  output_reserve: { chat: expect.any(Number), thinking: expect.any(Number) },
  compaction_at: null,
};
const SECRET = "secret-de-test";
const ADMIN = 1;
const BOB = 2;
const CAROL = 3;
/** Types cloud tous ouverts aux comptes non admin : depuis la 0.1.0, il faut les lister (absents = aucun). */
const TOUS_CLOUD = [
  "anthropic",
  "openai",
  "mistral",
  "groq",
  "openrouter",
  "deepseek",
  "moonshot",
  "opencode",
];
const PROPS_ROUTEUR = {
  build_info: "b10545-abc",
  role: "router",
  default_generation_settings: { n_ctx: 8192 },
  total_slots: 1,
};
const INVENTAIRE = {
  data: [
    { id: "golden-model", status: { value: "loaded" } },
    { id: "m", status: { value: "unloaded" } },
  ],
};
const INVENTAIRE_ROUTEUR = {
  data: [
    { id: "r1", status: { value: "loaded" } },
    { id: "r2", status: { value: "unloaded", failed: true } },
  ],
};
const ANONYMES: readonly [Methode, string][] = [
  ["GET", "/api/llm/connectors"],
  ["POST", "/api/llm/connectors"],
  ["PUT", "/api/llm/connectors/abc"],
  ["DELETE", "/api/llm/connectors/1"],
  ["POST", "/api/llm/connectors/1/test"],
  ["GET", "/api/llm/connectors/1/models"],
  ["GET", "/api/llm/models"],
  ["GET", "/api/llm/models/a/b/props"],
  ["GET", "/api/llm/models/x/effective-params?task=bogus"],
  ["GET", "/api/llm/health"],
  ["POST", "/api/llm/models/load"],
  ["GET", "/api/llm/models/load-progress"],
  ["POST", "/api/llm/models/unload"],
  ["POST", "/api/llm/infill"],
  ["GET", "/api/llm/queue-status"],
  ["GET", "/api/llm/queue-status/stream"],
];

let dossier: string;
const envAvant = {
  ELPIS_AUDIT_DIR: process.env["ELPIS_AUDIT_DIR"],
  ELPIS_ENGINE_ACCESS_DIR: process.env["ELPIS_ENGINE_ACCESS_DIR"],
};

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-routes-llm-"));
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

/** Caches du moteur et ordonnanceur remis à neuf, comme dans un process qui démarre. */
function moteurANeuf(): void {
  arreterSondeModeles();
  viderCacheModeles();
  oublierCaps();
  viderInventaires();
  invalidateAllModelCaches();
  loadedModelCache.id = null;
  loadedModelCache.ts = 0;
  installerOrdonnanceur(null);
  oublierAcces();
}

/** Une génération tenue sur `modele` (modèle et créneau) jusqu'à `lacher()`. */
function tenir(
  modele: string,
  moteur?: Moteur,
): { lacher: () => void; tenu: Promise<void>; fini: Promise<void> } {
  let lacher = (): void => undefined;
  const fin = new Promise<void>((ok) => {
    lacher = ok;
  });
  let entrer = (): void => undefined;
  const tenu = new Promise<void>((ok) => {
    entrer = ok;
  });
  const fini = ordonnanceur().withLLM(
    modele,
    "high",
    undefined,
    async () => {
      entrer();
      await fin;
    },
    moteur ? { moteur } : {},
  );
  return { lacher, tenu, fini };
}

function repondreJson(statut: number, corps: unknown) {
  return (_req: unknown, rep: ServerResponse): void => {
    rep.writeHead(statut, { "content-type": "application/json" });
    rep.end(JSON.stringify(corps));
  };
}

describe.each(MOTEURS)("famille /api/llm (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let llama: FauxServeur;
  let configJson: string;
  let restaurer: () => void;
  let lignes: string[];
  let diffuses: Dict[];
  let metriques: unknown[][];
  const reglagesAvant = { ...reglagesLlm };

  async function monter(mode: "main" | "admin" = "main"): Promise<FastifyInstance> {
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
    installerDiffusion({ diffuser: (m) => void diffuses.push(m) });
    const journal = new Journal({ niveau: "debug", sortie: (l) => lignes.push(l) });
    const familles = c.familles.map((f) =>
      f.nom === "llm"
        ? creerFamilleLlm({
            base: t.base,
            auth: dep,
            journal,
            logMetric: (...a) => void metriques.push(a),
          })
        : f,
    );
    return appTest({ ...c, mode, familles });
  }

  function appel(
    uid: number,
    method: Methode,
    url: string,
    corps?: unknown,
  ): Promise<LightMyRequestResponse> {
    const entetes: Record<string, string> = { cookie: cookie(uid) };
    if (typeof corps === "string") entetes["content-type"] = "application/json";
    return app.inject({
      method,
      url,
      headers: entetes,
      ...(corps === undefined ? {} : { payload: corps as string }),
    });
  }

  function ecrireConfig(llm: Dict): void {
    writeFileSync(configJson, JSON.stringify({ llm: { scheduling_mode: "classic", ...llm } }));
    invalidateConfigCache();
  }

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of [
      ["admin", 1],
      ["bob", 0],
      ["carol", 0],
    ] as const)
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
        [nom, admin],
      );
    llama = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE });
    configJson = path.join(dossier, `config-${moteur}.json`);
    restaurer = surchargerConfig({
      LLAMA_URL: `${llama.url}/v1/chat/completions`,
      LLAMA_PROVIDER_TYPE: "llamacpp",
      LLAMA_MODEL: "golden-model",
      LLAMA_MAX_MODELS: 1,
      LLAMA_MAX_CONCURRENCY: 1,
      LLM_SCHEDULING_MODE: "classic",
      CONFIG_JSON_PATH: configJson,
    });
    ecrireConfig({ allowed_provider_types: TOUS_CLOUD });
    moteurANeuf();
    lignes = [];
    diffuses = [];
    metriques = [];
    app = await monter();
  });

  afterEach(async () => {
    await app.close();
    installerDiffusion(null);
    moteurANeuf();
    Object.assign(reglagesLlm, reglagesAvant);
    restaurer();
    await closeLlmClient();
    await closeAdminClient();
    await llama.arreter();
    await t.fermer();
  });

  it("inventaire : les 16 routes de main sous une garde de session, rien dans l'admin ; anonyme = 401 avant toute validation", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; gardes: string[] }[] };
    const attendues = inventaire.routes.filter((r) => r.chemin.startsWith("/api/llm/"));
    expect(attendues).toHaveLength(16);
    const montees = app.elpis.routes.filter((r) => r.famille === "llm");
    expect(montees).toHaveLength(15);
    for (const r of attendues) {
      const chemin = r.chemin
        .replace("{cid}", ":cid")
        .replace(/\{model_id:path\}\/(props|effective-params)$/u, "*");
      const m = montees.find((x) => x.chemin === chemin && x.methodes.some((v) => v === r.methodes[0]));
      expect([r.process, r.gardes.includes("session"), m?.acces], `${r.methodes[0]} ${r.chemin}`).toEqual([
        ["main"],
        true,
        "session",
      ]);
    }
    for (const [method, url] of ANONYMES) {
      const r = await app.inject({ method, url, ...(method === "GET" ? {} : { payload: {} }) });
      expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([401, { detail: "not logged in" }]);
    }
    const admin = await monter("admin");
    expect(admin.elpis.routes.filter((r) => r.famille === "llm")).toEqual([]);
    const r = await admin.inject({ method: "GET", url: "/api/llm/models", headers: { cookie: cookie(BOB) } });
    expect(r.statusCode).toBe(404);
    await admin.close();
  });

  it("cloud fermé par défaut : sans liste blanche, un compte non admin ne crée aucun connecteur cloud, l'administrateur garde tous les types", async () => {
    ecrireConfig({});
    const refus = { detail: "Ce fournisseur n'est pas autorisé pour les utilisateurs" };
    expect(
      (await appel(BOB, "POST", "/api/llm/connectors", { provider_type: "openai", api_key: "k" })).json(),
    ).toEqual(refus);
    expect((await appel(BOB, "GET", "/api/llm/connectors")).json()).toMatchObject({
      allowed_provider_types: [],
    });
    expect((await appel(ADMIN, "GET", "/api/llm/connectors")).json()).toMatchObject({
      allowed_provider_types: TOUS_CLOUD,
    });
    const cree = await appel(ADMIN, "POST", "/api/llm/connectors", {
      provider_type: "anthropic",
      api_key: "k",
    });
    expect(cree.json()).toMatchObject({ ok: true });
    expect((await appel(ADMIN, "GET", "/api/llm/connectors")).json()).toMatchObject({
      connectors: [{ provider_type: "anthropic", provider_allowed: true }],
    });
    expect(
      (await appel(ADMIN, "POST", "/api/llm/connectors", { provider_type: "llamacpp", api_key: "k" })).json(),
    ).toEqual(refus);
  });

  it("connecteurs du compte : création validée, liste sans secret, modification, suppression, audit, compte d'autrui refusé", async () => {
    const creer = (corps: unknown) => appel(BOB, "POST", "/api/llm/connectors", corps);
    const types =
      "['anthropic', 'openai', 'mistral', 'groq', 'openrouter', 'deepseek', 'moonshot', 'opencode', 'llamacpp', 'vllm', 'sglang', 'generic']";
    expect((await creer({ provider_type: "x" })).json()).toEqual({
      detail: `provider_type invalide (${types})`,
    });
    expect((await creer({ provider_type: "llamacpp", api_key: "k" })).json()).toEqual({
      detail: "Ce fournisseur n'est pas autorisé pour les utilisateurs",
    });
    expect((await creer({ provider_type: "openai", api_key: "  " })).json()).toEqual({
      detail: "Clé API requise pour un connecteur cloud",
    });
    expect((await creer("{")).statusCode).toBe(400);
    expect((await creer({ provider_type: "openai", api_key: 5 })).statusCode).toBe(500);
    const cree = await creer({
      provider_type: "openai",
      api_key: " sk-bob-secret ",
      label: "Perso",
      base_url: "http://ailleurs.lan/v1",
    });
    const { id } = cree.json<{ id: number }>();
    expect(cree.json()).toEqual({ ok: true, id });
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "llm.connector.create",
      user_id: BOB,
      details: { connector_id: id, provider_type: "openai", scope: "user" },
    });
    const ligne = await t.base.get<{ api_key_enc: string; key_scheme: string; base_url: string }>(
      "SELECT api_key_enc, key_scheme, base_url FROM llm_connectors WHERE id=?",
      [id],
    );
    expect([ligne?.key_scheme, ligne?.base_url, ligne?.api_key_enc]).toEqual([
      "vault",
      "https://api.openai.com/v1",
      "",
    ]);
    expect((await getSecretForUser(t.base, BOB, id))?.["api_key"]).toBe("sk-bob-secret");

    const liste = await appel(BOB, "GET", "/api/llm/connectors");
    expect(liste.body).not.toContain("sk-bob-secret");
    expect(liste.body).not.toContain("api_key");
    expect(liste.json()).toMatchObject({
      connectors: [
        { id, provider_type: "openai", label: "Perso", has_key: true, enabled: true, provider_allowed: true },
      ],
      shared: [],
      allowed_provider_types: TOUS_CLOUD,
      builtin_allowed: true,
      can_manage_models: true,
    });
    expect(Object.keys(liste.json<Dict>())).toEqual([
      "connectors",
      "shared",
      "presets",
      "allowed_provider_types",
      "builtin_allowed",
      "can_manage_models",
    ]);
    ecrireConfig({ allowed_provider_types: ["anthropic", "inconnu"] });
    expect((await appel(BOB, "GET", "/api/llm/connectors")).json()).toMatchObject({
      connectors: [{ id, provider_allowed: false }],
      allowed_provider_types: ["anthropic"],
    });
    expect((await appel(CAROL, "GET", "/api/llm/connectors")).json()).toMatchObject({ connectors: [] });

    const modifier = (uid: number, corps: unknown, cid: unknown = id) =>
      appel(uid, "PUT", `/api/llm/connectors/${String(cid)}`, corps);
    const absent = { detail: "Connecteur introuvable ou rien à modifier" };
    expect((await modifier(CAROL, { label: "volé" })).json()).toEqual(absent);
    expect((await modifier(BOB, {})).json()).toEqual(absent);
    expect((await modifier(BOB, {}, "abc")).json()).toEqual({
      detail: [
        {
          type: "int_parsing",
          loc: ["path", "cid"],
          msg: "Input should be a valid integer, unable to parse string as an integer",
          input: "abc",
        },
      ],
    });
    expect((await modifier(BOB, [1])).statusCode).toBe(500);
    expect((await modifier(BOB, { label: "  Nouveau  ", enabled: 0, api_key: " sk-neuf " })).json()).toEqual({
      ok: true,
    });
    const apres = await t.base.get<{ label: string; enabled: number }>(
      "SELECT label, enabled FROM llm_connectors WHERE id=?",
      [id],
    );
    expect([apres?.label, apres?.enabled, (await getSecretForUser(t.base, BOB, id))?.["api_key"]]).toEqual([
      "Nouveau",
      0,
      "sk-neuf",
    ]);
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "llm.connector.update",
      details: { connector_id: id },
    });

    const supprimer = (uid: number) => appel(uid, "DELETE", `/api/llm/connectors/${id}`);
    expect((await supprimer(CAROL)).json()).toEqual({ detail: "Connecteur introuvable" });
    expect((await supprimer(BOB)).json()).toEqual({ ok: true });
    expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
      action: "llm.connector.delete",
      details: { connector_id: id },
    });
    expect((await supprimer(BOB)).json()).toEqual({ detail: "Connecteur introuvable" });
  });

  it("test et modèles d'un connecteur : clé transmise au fournisseur, jamais rendue ; routeur llama.cpp avec états ; politique et désactivation", async () => {
    const openai = await FauxServeur.demarrer();
    openai.json("GET /v1/models", { data: [{ id: "gpt-b" }, { id: "gpt-a" }, { pas: "d'id" }] });
    const anthropic = await FauxServeur.demarrer();
    anthropic.json("GET /v1/models", { error: "clé refusée" }, 401);
    const routeur = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE_ROUTEUR });
    try {
      const o = await createConnector(t.base, {
        scope: "user",
        owner_user_id: BOB,
        provider_type: "openai",
        wire: "openai",
        base_url: `${openai.url}/v1`,
        api_key: "sk-openai",
      });
      const a = await createConnector(t.base, {
        scope: "user",
        owner_user_id: BOB,
        provider_type: "anthropic",
        wire: "anthropic",
        base_url: anthropic.url,
        api_key: "sk-ant",
      });
      const r = await createConnector(t.base, {
        scope: "shared",
        provider_type: "llamacpp",
        wire: "openai",
        base_url: routeur.url,
        label: "GPU",
      });
      const test = await appel(BOB, "POST", `/api/llm/connectors/${o}/test`);
      expect(test.json()).toEqual({ ok: true, status: 200, models_count: 2 });
      expect(openai.sur("/v1/models")[0]?.entetes["authorization"]).toBe("Bearer sk-openai");
      expect(lignesAuditRecentes({ limit: 1 })[0]).toMatchObject({
        action: "llm.connector.test",
        user_id: BOB,
        details: { connector_id: o, ok: true, status: 200 },
      });
      expect((await appel(BOB, "POST", `/api/llm/connectors/${a}/test`)).json()).toEqual({
        ok: false,
        status: 401,
        models_count: ANTHROPIC_CATALOG.length,
        fallback: "catalog",
        error: "HTTP 401",
        hint: "401/403 : clé API refusée. Vérifie la clé du fournisseur.",
      });
      expect(anthropic.sur("/v1/models")[0]?.entetes["x-api-key"]).toBe("sk-ant");
      const introuvable = { detail: "Connecteur introuvable" };
      expect((await appel(CAROL, "POST", `/api/llm/connectors/${o}/test`)).json()).toEqual(introuvable);
      expect((await appel(BOB, "POST", `/api/llm/connectors/${r}/test`)).json()).toEqual(introuvable);

      const modeles = await appel(BOB, "GET", `/api/llm/connectors/${o}/models`);
      expect(modeles.body).toBe(
        JSON.stringify({
          connector_id: o,
          default_model: "",
          provider_type: "openai",
          router: false,
          statuses: {},
          can_manage: false,
          ok: true,
          status: 200,
          models: ["gpt-b", "gpt-a"],
          free: [],
        }),
      );
      expect((await appel(CAROL, "GET", `/api/llm/connectors/${o}/models`)).json()).toEqual(introuvable);
      const etats = await appel(CAROL, "GET", `/api/llm/connectors/${r}/models?fresh=1`);
      expect(etats.body).toBe(
        JSON.stringify({
          connector_id: r,
          default_model: "",
          provider_type: "llamacpp",
          router: true,
          statuses: { r1: "loaded", r2: "failed" },
          can_manage: true,
          ok: true,
          status: 200,
          models: ["r1", "r2"],
          free: [],
        }),
      );
      await setPolicy(t.base, "user", CAROL, { engine_keys: ["builtin"], can_manage_models: false });
      expect((await appel(CAROL, "GET", `/api/llm/connectors/${r}/models`)).json()).toEqual({
        detail: "Serveur non autorisé",
      });
      await t.base.run("UPDATE llm_connectors SET enabled=0 WHERE id=?", [r]);
      expect((await appel(BOB, "GET", `/api/llm/connectors/${r}/models`)).json()).toEqual(introuvable);
    } finally {
      await openai.arreter();
      await anthropic.arreter();
      await routeur.arreter();
    }
  });

  it("catalogue : intégré refusé par la politique, premier appel borné, cache servi ; serveur nommé : routeur, non géré, introuvable", async () => {
    const routeur = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE_ROUTEUR });
    try {
      const r = await createConnector(t.base, {
        scope: "shared",
        provider_type: "llamacpp",
        wire: "openai",
        base_url: routeur.url,
      });
      const o = await createConnector(t.base, {
        scope: "user",
        owner_user_id: BOB,
        provider_type: "openai",
        wire: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "k",
      });
      await setPolicy(t.base, "user", CAROL, { engine_keys: [`conn:${r}`], can_manage_models: null });
      const refus = await appel(CAROL, "GET", "/api/llm/models");
      expect([refus.headers["cache-control"], refus.body]).toEqual([
        "no-cache",
        JSON.stringify({
          models: [],
          models_with_status: [],
          models_loaded: [],
          kv_cache: {},
          server_reachable: false,
          status: "forbidden",
          props: {},
          allowed: false,
          can_manage: false,
        }),
      ]);

      let liberer = (): void => undefined;
      const bloque = new Promise<void>((ok) => {
        liberer = ok;
      });
      llama.route("GET /health", async (_r, rep) => {
        await bloque;
        repondreJson(200, { status: "ok" })(_r, rep);
      });
      reglagesLlm.catalogueInitialMs = 100;
      const lent = await appel(BOB, "GET", "/api/llm/models");
      expect(lent.body).toBe(
        JSON.stringify({
          models: [],
          models_with_status: [],
          models_loaded: [],
          kv_cache: {},
          server_reachable: false,
          status: "unreachable",
          props: {},
        }),
      );
      liberer();
      await attendreQue(() => Object.keys(modelCache).length > 0, 5_000, "cache des modèles");
      const servi = await appel(BOB, "GET", "/api/llm/models");
      expect([servi.headers["cache-control"], servi.json()]).toMatchObject([
        "no-cache",
        { models: ["golden-model", "m"], models_loaded: [{ id: "golden-model" }], server_reachable: true },
      ]);

      const nomme = await appel(CAROL, "GET", `/api/llm/models?engine=conn:${r}`);
      expect([nomme.headers["cache-control"], nomme.body]).toEqual([
        "no-cache",
        JSON.stringify({
          engine: `conn:${r}`,
          models: ["r1", "r2"],
          models_with_status: [
            { id: "r1", status: "loaded" },
            { id: "r2", status: "failed" },
          ],
          models_loaded: ["r1"],
          kv_cache: {},
          props: {},
          server_reachable: true,
          status: "ok",
          router: true,
          can_manage: true,
        }),
      ]);
      expect((await appel(BOB, "GET", `/api/llm/models?engine=conn:${o}`)).json()).toEqual({
        engine: `conn:${o}`,
        models: [],
        models_with_status: [],
        models_loaded: [],
        kv_cache: {},
        props: {},
        server_reachable: false,
        status: "unsupported",
        router: false,
        can_manage: false,
      });
      const introuvable = { detail: "Serveur introuvable" };
      for (const cle of ["conn:999", "nimporte", `conn:${o}`])
        expect((await appel(CAROL, "GET", `/api/llm/models?engine=${cle}`)).json(), cle).toEqual(introuvable);
      routeur.route("GET /props", repondreJson(500, {}));
      expect((await appel(BOB, "GET", `/api/llm/models?engine=conn:${r}&fresh=1`)).json()).toMatchObject({
        engine: `conn:${r}`,
        server_reachable: false,
        status: "unreachable",
      });
    } finally {
      await routeur.arreter();
    }
  });

  it("politiques d'accès illisibles : 503 access_check_failed (pas 500), administrateur compris", async () => {
    const r = await createConnector(t.base, {
      scope: "shared",
      provider_type: "llamacpp",
      wire: "openai",
      base_url: llama.url,
    });
    await t.base.exec("DROP TABLE user_groups");
    oublierAcces(t.base);
    const panne = {
      detail: {
        code: "engine_unavailable",
        reason: "access_check_failed",
        message: "Contrôle d'accès au serveur indisponible, réessayez.",
      },
    };
    const appels: [number, Methode, string, unknown?][] = [
      [BOB, "GET", "/api/llm/models"],
      [ADMIN, "GET", "/api/llm/models"],
      [BOB, "GET", "/api/llm/connectors"],
      [BOB, "GET", `/api/llm/connectors/${r}/models`],
      [BOB, "GET", `/api/llm/models?engine=conn:${r}`],
      [BOB, "POST", "/api/llm/models/load", { model_path: "m" }],
    ];
    for (const [uid, method, url, corps] of appels) {
      const rep = await appel(uid, method, url, corps);
      expect(rep.statusCode, `${uid} ${method} ${url}`).toBe(503);
      expect(rep.json(), `${uid} ${method} ${url}`).toEqual(panne);
    }
  });

  it("propriétés d'un modèle : trois méthodes de l'intégré, 409 sans chargement, modèle non local, connecteur ; joker gourmand", async () => {
    let mode: "ok" | "sans-modele" | "rien" = "ok";
    const demandes: (string | null)[] = [];
    llama.route("GET /props", (req, rep) => {
      const m = req.url.searchParams.get("model");
      demandes.push(m);
      if (m === null) return repondreJson(mode === "rien" ? 500 : 200, PROPS_ROUTEUR)(req, rep);
      if (m === "absent") return repondreJson(400, { error: "not loaded" })(req, rep);
      if (mode === "ok")
        return repondreJson(200, { model_path: m, autoload: req.url.searchParams.get("autoload") })(req, rep);
      return repondreJson(404, {})(req, rep);
    });
    const props = (modele: string, suite = "") =>
      appel(BOB, "GET", `/api/llm/models/${modele}/props${suite}`);
    const direct = await props("golden-model");
    expect([direct.headers["cache-control"], direct.json()]).toEqual([
      "no-cache",
      { model_path: "golden-model", autoload: "false" },
    ]);
    expect((await props("org%2Fmodel")).json()).toEqual({ model_path: "org/model", autoload: "false" });
    expect((await props("a/b")).json()).toEqual({ model_path: "a/b", autoload: "false" });
    expect((await props("load-progress")).json()).toEqual({ model_path: "load-progress", autoload: "false" });
    expect((await props("absent")).json()).toEqual({ detail: "Modèle non chargé" });
    mode = "sans-modele";
    expect((await props("x")).json()).toEqual(PROPS_ROUTEUR);
    mode = "rien";
    expect((await props("m")).json()).toEqual({
      openai_compat: true,
      id: "m",
      status: { value: "unloaded" },
    });
    expect((await props("zzz")).json()).toEqual({
      openai_compat: true,
      id: "golden-model",
      status: { value: "loaded" },
    });
    llama.route("GET /v1/models", repondreJson(500, {}));
    expect((await props("zzz")).json()).toEqual({ detail: "Could not retrieve model properties" });
    modelCache["models"] = ["golden-model"];
    expect((await props("cloud-x")).json()).toEqual({
      detail: "Modèle non local (connecteur) — /props indisponible",
    });
    expect((await appel(BOB, "GET", "/api/llm/models/x/autre")).json()).toEqual({ detail: "Not Found" });

    const routeur = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE_ROUTEUR });
    try {
      const r = await createConnector(t.base, {
        scope: "shared",
        provider_type: "llamacpp",
        wire: "openai",
        base_url: routeur.url,
      });
      const o = await createConnector(t.base, {
        scope: "user",
        owner_user_id: BOB,
        provider_type: "openai",
        wire: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "k",
      });
      expect((await props("r1%2Fq", `?engine=conn:${r}`)).json()).toEqual(PROPS_ROUTEUR);
      expect(routeur.sur("/props").at(-1)?.chemin).toBe("/props?model=r1%2Fq&autoload=false");
      routeur.route("GET /props", repondreJson(404, {}));
      expect((await props("r1", `?engine=conn:${r}`)).json()).toEqual({
        detail: "Could not retrieve model properties",
      });
      expect((await props("gpt", `?engine=conn:${o}`)).json()).toEqual({
        detail: "Propriétés indisponibles pour ce serveur",
      });
      expect((await props("gpt", "?engine=conn:999")).json()).toEqual({ detail: "Serveur introuvable" });
    } finally {
      await routeur.arreter();
    }
  });

  it("paramètres effectifs : tâche validée avant le serveur, dégradé demandé ou forcé (modèle non local, connecteur cloud), complet sinon", async () => {
    const effectifs = (modele: string, suite = "") =>
      appel(BOB, "GET", `/api/llm/models/${modele}/effective-params${suite}`);
    expect((await effectifs("golden-model", "?task=bogus&engine=conn:999")).json()).toEqual({
      detail: "task invalide : bogus",
    });
    expect((await effectifs("golden-model", "?task=")).json()).toEqual({ detail: "task invalide : " });
    expect((await effectifs("golden-model", "?engine=conn:999")).json()).toEqual({
      detail: "Serveur introuvable",
    });
    const degrade = await effectifs("golden-model", "?task=tools&degraded=1");
    expect([degrade.headers["cache-control"], degrade.json()]).toEqual([
      "no-cache",
      { ...describeEffectiveParamsDegraded("golden-model", "tools", "llamacpp"), context_window: FENETRE },
    ]);
    const complet = await effectifs("golden-model", "?task=thinking");
    expect(complet.json()).toEqual({
      ...(await describeEffectiveParams("golden-model", "thinking")),
      context_window: FENETRE,
    });
    modelCache["models"] = ["golden-model"];
    expect((await effectifs("cloud-x")).json()).toEqual({
      ...describeEffectiveParamsDegraded("cloud-x", "chat", "llamacpp"),
      context_window: FENETRE,
    });
    const o = await createConnector(t.base, {
      scope: "user",
      owner_user_id: BOB,
      provider_type: "openai",
      wire: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "k",
    });
    expect((await effectifs("gpt-a", `?engine=conn:${o}&task=infill`)).json()).toEqual({
      ...describeEffectiveParamsDegraded("gpt-a", "infill", "openai"),
      context_window: FENETRE,
    });
  });

  it("santé : instantané du serveur, sans cache", async () => {
    const r = await appel(BOB, "GET", "/api/llm/health");
    expect([r.statusCode, r.headers["cache-control"]]).toEqual([200, "no-cache"]);
    expect(r.json()).toMatchObject({ server_reachable: true, status: "ok" });
  });

  it("chargement et déchargement de l'intégré : droits, exclusivité de modèle tenue, refus pendant une génération, journal et métriques", async () => {
    llama.route("POST /models/load", repondreJson(200, { success: true }));
    llama.route("POST /models/unload", repondreJson(200, { success: true }));
    await setPolicy(t.base, "user", CAROL, { engine_keys: null, can_manage_models: false });
    const charger = (uid: number, corps: unknown) => appel(uid, "POST", "/api/llm/models/load", corps);
    const decharger = (uid: number, corps: unknown) => appel(uid, "POST", "/api/llm/models/unload", corps);
    expect((await charger(BOB, { model_path: "  " })).json()).toEqual({ detail: "model_path requis" });
    expect((await charger(BOB, { model_path: "m", engine: "conn:999" })).json()).toEqual({
      detail: "Serveur introuvable",
    });
    expect((await charger(CAROL, { model_path: "m" })).json()).toEqual({
      detail: "Gestion des modèles non autorisée",
    });
    expect((await decharger(CAROL, { model_id: "m" })).json()).toEqual({
      detail: "Gestion des modèles non autorisée",
    });
    expect((await decharger(BOB, {})).json()).toEqual({ detail: "model_id requis" });

    const generation = tenir("golden-model");
    await generation.tenu;
    const enCours = charger(BOB, { model_path: "m" });
    await attendreQue(() => diffuses.some((d) => d["message"] === "[LLM] Chargement modèle: m (par bob)"));
    await new Promise((ok) => setTimeout(ok, 100));
    expect(llama.sur("/models/load")).toEqual([]);
    generation.lacher();
    await generation.fini;
    expect((await enCours).json()).toMatchObject({ ok: true, method: "models_load" });
    expect(llama.sur("/models/load").map((q) => q.json())).toEqual([{ model: "m" }]);
    expect(diffuses.filter((d) => d["type"] === "log")).toEqual([
      { type: "log", message: "[LLM] Chargement modèle: m (par bob)", level: "INFO" },
      { type: "log", message: "[LLM] Modèle chargé: m", level: "INFO" },
    ]);
    expect(diffuses.some((d) => d["type"] === "model_status")).toBe(true);
    expect(metriques).toEqual([["model_load", 1, { model: "m", user: "bob" }]]);
    expect(loadedModelCache.id).toBe("m");
    expect(occupation(builtinEngine())).toEqual({ current_model: null, active_count: 0 });

    llama.route("POST /models/load", repondreJson(500, { error: "boom" }));
    diffuses.length = 0;
    expect((await charger(BOB, { model_path: "m" })).json()).toMatchObject({ ok: false, error: "boom" });
    expect(diffuses.filter((d) => d["type"] === "log").at(-1)).toEqual({
      type: "log",
      message: "[LLM] Échec: boom",
      level: "ERROR",
    });

    const seconde = tenir("golden-model");
    await seconde.tenu;
    const refus = await decharger(BOB, { model_id: "golden-model" });
    expect(refus.body).toBe(
      JSON.stringify({
        ok: false,
        error: "Génération en cours sur « golden-model » — déchargement refusé",
        busy_model: "golden-model",
        active_count: 1,
      }),
    );
    expect(lignes.join("\n")).toContain(
      "[LLM] déchargement de golden-model refusé (par bob) : 1 génération(s) en cours sur golden-model",
    );
    expect(llama.sur("/models/unload")).toEqual([]);
    diffuses.length = 0;
    expect((await decharger(BOB, { model_id: "golden-model", force: true })).json()).toEqual({
      ok: true,
      method: "models_unload",
    });
    seconde.lacher();
    expect(diffuses.filter((d) => d["type"] === "log")).toEqual([
      {
        type: "log",
        message: "[LLM] Attente fin des requêtes avant déchargement de golden-model (par bob)…",
        level: "INFO",
      },
      { type: "log", message: "[LLM] Modèle déchargé: golden-model", level: "WARNING" },
    ]);
    expect(metriques.at(-1)).toEqual(["model_unload", 1, { model: "golden-model", user: "bob" }]);
    expect(loadedModelCache.id).toBeNull();
  });

  it("chargement et déchargement sur un connecteur llama.cpp : serveur visé seul, refus pendant une génération, serveur sans gestion", async () => {
    const routeur = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE_ROUTEUR });
    routeur.route("POST /models/load", repondreJson(200, { success: true }));
    routeur.route("POST /models/unload", repondreJson(200, { success: true }));
    llama.route("POST /models/unload", repondreJson(200, { success: true }));
    try {
      const r = await createConnector(t.base, {
        scope: "shared",
        provider_type: "llamacpp",
        wire: "openai",
        base_url: routeur.url,
      });
      const o = await createConnector(t.base, {
        scope: "user",
        owner_user_id: BOB,
        provider_type: "openai",
        wire: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "k",
      });
      const sansGestion = { ok: false, error: "Serveur sans gestion de modèles." };
      expect(
        (await appel(BOB, "POST", "/api/llm/models/load", { model_path: "x", engine: `conn:${o}` })).json(),
      ).toEqual(sansGestion);
      expect(
        (await appel(BOB, "POST", "/api/llm/models/unload", { model_id: "x", engine: `conn:${o}` })).json(),
      ).toEqual(sansGestion);
      const charge = await appel(BOB, "POST", "/api/llm/models/load", {
        model_path: "r2",
        engine: `conn:${r}`,
      });
      expect(charge.json()).toMatchObject({ ok: true, method: "models_load" });
      expect(routeur.sur("/models/load").map((q) => q.json())).toEqual([{ model: "r2" }]);
      expect(llama.sur("/models/load")).toEqual([]);
      expect(metriques).toEqual([["model_load", 1, { model: "r2", user: "bob", engine: `conn:${r}` }]]);
      expect(lignes.join("\n")).toContain(`[LLM] chargement r2 sur conn:${r} (par bob) → ok`);
      expect(diffuses.filter((d) => d["type"] === "log")).toEqual([]);

      const generation = tenir("r1", { id: `conn:${r}`, enFile: true });
      await generation.tenu;
      expect(
        (await appel(BOB, "POST", "/api/llm/models/unload", { model_id: "r1", engine: `conn:${r}` })).json(),
      ).toEqual({
        ok: false,
        error: "Génération en cours sur « r1 » — déchargement refusé",
        busy_model: "r1",
        active_count: 1,
      });
      expect((await appel(BOB, "POST", "/api/llm/models/unload", { model_id: "m" })).json()).toEqual({
        ok: true,
        method: "models_unload",
      });
      generation.lacher();
      await generation.fini;
      expect(
        (await appel(BOB, "POST", "/api/llm/models/unload", { model_id: "r1", engine: `conn:${r}` })).json(),
      ).toEqual({ ok: true, method: "models_unload" });
      expect(lignes.join("\n")).toContain(`[LLM] déchargement r1 sur conn:${r} (par bob) → ok`);
    } finally {
      await routeur.arreter();
    }
  });

  it("progression du chargement en SSE : paramètres requis, moteur ancien, étapes réelles puis fin", async () => {
    const progression = (suite: string) => appel(BOB, "GET", `/api/llm/models/load-progress${suite}`);
    expect((await progression("?model_id=%20")).json()).toEqual({ detail: "model_id requis" });
    expect((await progression("?model_id=m&engine=conn:999")).json()).toEqual({
      detail: "Serveur introuvable",
    });
    llama.sse("GET /models/sse", [
      'data: {"model":"autre","event":"status_change","data":{"status":"loaded"}}',
      'data: {"model":"m","event":"status_change","data":{"status":"loading","progress":{"value":0.5,"current":"text_model","stages":["text_model","mmproj"]}}}',
      'data: {"model":"m","event":"download_progress","data":{"progress":{"u":{"done":1,"total":4}}}}',
      'data: {"model":"m","event":"status_change","data":{"status":"loaded"}}',
    ]);
    const suivi = await progression("?model_id=m");
    expect([
      suivi.headers["content-type"],
      suivi.headers["cache-control"],
      suivi.headers["x-accel-buffering"],
    ]).toEqual(["text/event-stream; charset=utf-8", "no-cache", "no"]);
    expect(suivi.body).toBe(
      'data: {"pct": 50.0, "stage": "text_model", "stages": ["text_model", "mmproj"]}\n\n' +
        'data: {"pct": 25.0, "stage": "download", "stages": ["download"]}\n\n' +
        'data: {"done": true, "loaded": true}\n\n',
    );
    llama.json("GET /props", { build_info: "b9000-ancien" });
    oublierCaps();
    expect((await progression("?model_id=m")).body).toBe('data: {"supported": false}\n\n');
  });

  it("infill sous l'ordonnanceur : intégré seul, attente bornée puis « Modèle occupé », disjoncteur ouvert après des pannes de transport", async () => {
    llama.route("POST /infill", repondreJson(200, { content: "x + 1", model: "golden-model" }));
    const completer = (uid: number, corps: unknown) => appel(uid, "POST", "/api/llm/infill", corps);
    expect((await completer(BOB, { input_prefix: "", input_suffix: "" })).json()).toEqual({
      detail: "input_prefix ou input_suffix requis",
    });
    expect(
      (await completer(BOB, { input_prefix: "def f(", input_suffix: ")", model: " golden-model " })).json(),
    ).toEqual({
      ok: true,
      content: "x + 1",
      model: "golden-model",
    });
    expect(llama.sur("/infill")[0]?.json()).toMatchObject({
      input_prefix: "def f(",
      input_suffix: ")",
      model: "golden-model",
    });
    await setPolicy(t.base, "user", CAROL, { engine_keys: ["conn:5"], can_manage_models: null });
    expect((await completer(CAROL, { input_prefix: "a" })).json()).toEqual({
      detail: "Serveur non autorisé",
    });

    reglagesLlm.infillAttenteMaxS = 0.2;
    const autre = await tenirModele(builtinEngine(), "autre");
    const debut = performance.now();
    expect((await completer(BOB, { input_prefix: "a", model: "golden-model" })).json()).toEqual({
      ok: false,
      error: "Modèle occupé par une autre génération — réessayez plus tard.",
    });
    expect(performance.now() - debut).toBeLessThan(5_000);
    autre.release();
    expect(llama.sur("/infill")).toHaveLength(1);
    expect(ordonnanceur().stats("builtin").slot_waiters).toEqual([]);

    installerOrdonnanceur(
      new LLMQueue({ ...sourcesDuProcess(), disjoncteur: { enabled: true, failsToOpen: 2, cooldownS: 60 } }),
    );
    surchargerConfig({ LLAMA_URL: `http://127.0.0.1:${await portFerme()}/v1/chat/completions` });
    const panne = {
      ok: false,
      error: "All connection attempts failed",
      hint: "Vérifiez que le modèle supporte FIM (Fill-In-the-Middle).",
    };
    for (let i = 0; i < 2; i++)
      expect(
        (await completer(BOB, { input_prefix: "a", model: "golden-model" })).json(),
        `panne ${i}`,
      ).toEqual(panne);
    expect((await completer(BOB, { input_prefix: "a", model: "golden-model" })).json()).toEqual({
      ok: false,
      error: "Service LLM temporairement indisponible (circuit ouvert) — réessaie dans quelques secondes.",
    });
  });

  it("état de la file : instantané du serveur intégré (flottants Python, compact), génération en cours comptée", async () => {
    const vide = await appel(BOB, "GET", "/api/llm/queue-status");
    expect(vide.headers["cache-control"]).toBe("no-cache");
    expect(vide.headers["content-type"]).toMatch(/^application\/json/u);
    expect(vide.body).toMatch(
      /^\{"llm":\{"in_flight":0,"waiting":0,"capacity":0,"saturation_ratio":0\.0,"models":\[\]\},"chat":\{"active_estimate":0\},"ts":\d+\.\d+\}$/u,
    );
    const generation = tenir("golden-model");
    await generation.tenu;
    expect((await appel(BOB, "GET", "/api/llm/queue-status")).body).toMatch(
      /^\{"llm":\{"in_flight":1,"waiting":0,"capacity":1,"saturation_ratio":1\.0,"models":\[\{"model":"golden-model","holders":1,"max":1,"waiters":0\}\]\},"chat":\{"active_estimate":1\},"ts":\d+\.\d+\}$/u,
    );
    generation.lacher();
    await generation.fini;
  });

  describe("flux de la file", () => {
    async function ecouter(): Promise<string> {
      await app.listen({ port: 0, host: "127.0.0.1" });
      return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/llm/queue-status/stream`;
    }

    it("instantané immédiat puis périodique, en-têtes du flux, désabonnement à la déconnexion", async () => {
      Object.assign(reglagesLlm, { intervalleMs: 30 });
      const flux = await ouvrirFlux(await ecouter(), { cookie: cookie(BOB) });
      expect([
        flux.statut,
        flux.entetes["content-type"],
        flux.entetes["cache-control"],
        flux.entetes["x-accel-buffering"],
      ]).toEqual([200, "text/event-stream; charset=utf-8", "no-cache, no-transform", "no"]);
      await flux.attendreTexte('"in_flight":0');
      expect(flux.texte()).toMatch(
        /^data: \{"llm":\{"in_flight":0,"waiting":0,"capacity":0,"saturation_ratio":0\.0,/u,
      );
      const generation = tenir("golden-model");
      await generation.tenu;
      await flux.attendreTexte('"in_flight":1');
      generation.lacher();
      flux.fermer();
      await flux.fini;
      await attendreQue(() => lignes.join("\n").includes(`[queue-status/stream] unsubscribed uid=${BOB}`));
      expect(lignes.join("\n")).toContain(`[queue-status/stream] subscribe uid=${BOB}`);
    });

    it("keep-alive pendant le silence, puis session révoquée : session_expired et fin du flux", async () => {
      Object.assign(reglagesLlm, { intervalleMs: 60_000, keepaliveMs: 40, revalidationMs: 150 });
      const flux = await ouvrirFlux(await ecouter(), { cookie: cookie(BOB) });
      await flux.attendreTexte(": keep-alive\n\n");
      expect(flux.texte()).toMatch(/^data: \{"llm":.*\}\n\n(: keep-alive\n\n)+$/su);
      await t.base.run("UPDATE users SET session_min_ts=? WHERE id=?", [T, BOB]);
      await flux.fini;
      expect(flux.texte().endsWith('data: {"type": "session_expired"}\n\n')).toBe(true);
    });
  });
});
