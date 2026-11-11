// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/llm.test.ts — contrats des connecteurs LLM du compte, du catalogue, de la santé et de la file, rejoués contre le core TS réel et de faux serveurs de modèles. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configurerChiffrement } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createConnector } from "../../../../apps/core/src/llm/connecteurs";
import { FauxServeur } from "../../../../apps/core/test/llm/faux-serveur";
import { CONTRATS_REST, schemaParametresEffectifs, schemaReponseFileLlm } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let uid = 0;
let dossier = "";
let openai: FauxServeur;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrats-llm-"));
  configurerChiffrement({ cleEnv: "cle-de-test-contrats", fichierCle: join(dossier, ".k") });
  openai = await FauxServeur.demarrer();
  openai.json("GET /v1/models", { data: [{ id: "gpt-b" }, { id: "gpt-a" }, { pas: "d'id" }] });
  core = await demarrerCore();
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  await openai.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

describe("contrats REST : connecteurs LLM (core réel)", () => {
  it("liste, création validée, test, modèles, mise à jour, suppression", async () => {
    expect(await core.appeler("GET", "/api/llm/connectors", { cookie })).toMatchObject({
      connectors: [],
      builtin_allowed: true,
    });
    const cree = (await core.appeler("POST", "/api/llm/connectors", {
      cookie,
      corps: { provider_type: "openai", api_key: "sk-openai", label: "Mon OpenAI" },
    })) as { id: number };
    await core.appeler("POST", "/api/llm/connectors", {
      cookie,
      corps: { provider_type: "x", api_key: "k" },
    });
    await core.appeler("POST", "/api/llm/connectors", {
      cookie,
      corps: { provider_type: "openai", api_key: " " },
    });
    await core.appeler("POST", "/api/llm/connectors", {
      cookie: cookieLou,
      corps: { provider_type: "llamacpp", api_key: "k" },
    });
    const local = await createConnector(core.base, {
      scope: "user",
      owner_user_id: uid,
      provider_type: "openai",
      wire: "openai",
      base_url: `${openai.url}/v1`,
      api_key: "sk-faux",
      models_json: "manuel",
    });
    const partage = await createConnector(core.base, {
      scope: "shared",
      provider_type: "llamacpp",
      wire: "openai",
      base_url: `${openai.url}`,
      label: "GPU",
    });
    expect(await core.appeler("GET", "/api/llm/connectors", { cookie })).toMatchObject({
      connectors: [{ id: local }, { id: cree.id, has_key: true }],
      shared: [{ id: partage, scope: "shared" }],
    });
    expect(await core.appeler("POST", `/api/llm/connectors/${local}/test`, { cookie })).toEqual({
      ok: true,
      status: 200,
      models_count: 2,
    });
    expect(await core.appeler("GET", `/api/llm/connectors/${local}/models`, { cookie })).toMatchObject({
      ok: true,
      models: expect.arrayContaining(["gpt-a", "gpt-b"]),
      router: false,
    });
    await core.appeler("POST", `/api/llm/connectors/${local}/test`, { cookie: cookieLou });
    await core.appeler("GET", `/api/llm/connectors/${local}/models`, { cookie: cookieLou });
    expect(
      await core.appeler("PUT", `/api/llm/connectors/${local}`, {
        cookie,
        corps: { label: "Renommé", enabled: false },
      }),
    ).toEqual({ ok: true });
    await core.appeler("PUT", `/api/llm/connectors/${local}`, { cookie, corps: {} });
    await core.appeler("GET", `/api/llm/connectors/${local}/models`, { cookie });
    expect(await core.appeler("DELETE", `/api/llm/connectors/${local}`, { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", `/api/llm/connectors/${local}`, { cookie });
    await core.appeler("GET", "/api/llm/connectors");
  });
});

describe("contrats REST : modèles, santé et file (core réel, aucun moteur joignable)", () => {
  it("catalogue injoignable, santé, instantané de la file", async () => {
    expect(await core.appeler("GET", "/api/llm/models", { cookie })).toMatchObject({
      server_reachable: false,
      status: "unreachable",
    });
    await core.appeler("GET", "/api/llm/models?engine=inconnu", { cookie });
    expect(await core.appeler("GET", "/api/llm/health", { cookie })).toMatchObject({
      server_reachable: false,
    });
    const file = schemaReponseFileLlm.parse(await core.appeler("GET", "/api/llm/queue-status", { cookie }));
    expect(file.llm.capacity).toBe(0);
    await core.appeler("GET", "/api/llm/models");
    await core.appeler("GET", "/api/llm/health");
    await core.appeler("GET", "/api/llm/queue-status");
  });

  it("paramètres effectifs d'un modèle (route à joker, hors registre) : vue dégradée et vue complète", async () => {
    for (const suite of ["?task=chat&degraded=1", "?task=chat", ""]) {
      const r = await core.app.inject({
        method: "GET",
        url: `/api/llm/models/m1/effective-params${suite}`,
        headers: { cookie },
      });
      expect(r.statusCode).toBe(200);
      const corps: unknown = JSON.parse(r.body);
      const lu = schemaParametresEffectifs.parse(corps);
      expect(lu).toEqual(corps);
      expect(lu.model_id).toBe("m1");
    }
    const dégradé = await core.app.inject({
      method: "GET",
      url: "/api/llm/models/m1/effective-params?degraded=1",
      headers: { cookie },
    });
    expect(schemaParametresEffectifs.parse(JSON.parse(dégradé.body)).degraded).toBe(true);
  });

  it("chargement, déchargement et complétion : corps incomplets refusés", async () => {
    await core.appeler("POST", "/api/llm/models/load", { cookie, corps: {} });
    await core.appeler("POST", "/api/llm/models/unload", { cookie, corps: {} });
    await core.appeler("POST", "/api/llm/infill", { cookie, corps: {} });
    await core.appeler("POST", "/api/llm/models/load", {
      cookie: cookieLou,
      corps: { model_path: "m.gguf" },
    });
  });

  it("toutes les routes du domaine llm ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "llm").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
