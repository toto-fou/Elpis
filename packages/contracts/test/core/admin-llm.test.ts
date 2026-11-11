// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-llm.test.ts — contrats des connecteurs partagés, du mode d'ordonnancement et du trafic LLM de la console, rejoués contre le core TS réel en process admin. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configurerChiffrement } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FauxServeur } from "../../../../apps/core/test/llm/faux-serveur";
import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieModerateur = "";
let cookieLou = "";
let dossier = "";
let faux: FauxServeur;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrats-adminllm-"));
  configurerChiffrement({ cleEnv: "cle-de-test-contrats", fichierCle: join(dossier, ".k") });
  faux = await FauxServeur.demarrer();
  faux.json("GET /v1/models", { data: [{ id: "m1" }, { id: "m2" }] });
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "max", "mdp-de-max-1", 2);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieModerateur = await core.connecter("max", "mdp-de-max-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

describe("contrats REST : LLM de la console (core réel)", () => {
  it("connecteurs partagés : création, liste, test, mise à jour, suppression", async () => {
    const cree = (await core.appeler("POST", "/api/admin/llm/connectors", {
      cookie,
      corps: {
        provider_type: "generic",
        base_url: `${faux.url}/v1`,
        label: "Local",
        api_key: "sk-x",
        max_concurrency: 2,
      },
    })) as { id: number };
    await core.appeler("POST", "/api/admin/llm/connectors", { cookie, corps: { provider_type: "inconnu" } });
    await core.appeler("POST", "/api/admin/llm/connectors", {
      cookie: cookieLou,
      corps: { provider_type: "generic" },
    });
    expect(await core.appeler("GET", "/api/admin/llm/connectors", { cookie })).toMatchObject({
      connectors: [{ id: cree.id, scope: "shared", has_key: true, max_concurrency: 2 }],
    });
    expect(await core.appeler("POST", `/api/admin/llm/connectors/${cree.id}/test`, { cookie })).toEqual({
      ok: true,
      status: 200,
      models_count: 2,
    });
    await core.appeler("POST", "/api/admin/llm/connectors/99/test", { cookie });
    expect(
      await core.appeler("PUT", `/api/admin/llm/connectors/${cree.id}`, {
        cookie,
        corps: { label: "Renommé", enabled: false, max_concurrency: "" },
      }),
    ).toEqual({ ok: true });
    await core.appeler("PUT", "/api/admin/llm/connectors/99", { cookie, corps: { label: "x" } });
    expect(await core.appeler("DELETE", `/api/admin/llm/connectors/${cree.id}`, { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", `/api/admin/llm/connectors/${cree.id}`, { cookie });
    await core.appeler("GET", "/api/admin/llm/connectors", { cookie: cookieLou });
  });

  it("fournisseurs autorisés, capacités, sonde, mode d'ordonnancement", async () => {
    expect(await core.appeler("GET", "/api/admin/llm/allowed-providers", { cookie })).toMatchObject({
      allowed: expect.any(Array),
    });
    expect(
      await core.appeler("PUT", "/api/admin/llm/allowed-providers", {
        cookie,
        corps: { allowed: ["openai", "generic", "x"] },
      }),
    ).toEqual({ ok: true, allowed: ["openai"] });
    await core.appeler("PUT", "/api/admin/llm/allowed-providers", { cookie, corps: { allowed: "openai" } });
    expect(
      await core.appeler("GET", "/api/admin/llm-capabilities", { cookie: cookieModerateur }),
    ).toMatchObject({
      configured_mode: expect.any(String),
    });
    await core.appeler("GET", "/api/admin/llm-capabilities", { cookie: cookieLou });
    await core.appeler("POST", "/api/admin/llm-capabilities/probe", { cookie });
    expect(
      await core.appeler("POST", "/api/admin/llm-scheduling-mode", { cookie, corps: { mode: "classic" } }),
    ).toEqual({ configured_mode: "classic", effective_mode: "classic" });
    await core.appeler("POST", "/api/admin/llm-scheduling-mode", { cookie, corps: { mode: "rapide" } });
  });

  it("moteur intégré : rapport de sonde et « Tester », réservés à l'administrateur", async () => {
    const vu = (await core.appeler("GET", "/api/admin/llm/engine", { cookie })) as { rapport: unknown };
    expect(vu.rapport).toMatchObject({ type: "llamacpp", conseils: expect.any(Array) });
    expect(await core.appeler("POST", "/api/admin/llm/engine/test", { cookie })).toMatchObject({
      rapport: { type: "llamacpp", adresses: expect.any(Array) },
    });
    await core.appeler("GET", "/api/admin/llm/engine", { cookie: cookieLou });
  });

  it("trafic déboguable : liste filtrée, détail, effacement", async () => {
    expect(await core.appeler("GET", "/api/admin/llm-traffic", { cookie })).toMatchObject({
      calls: [],
      count: 0,
    });
    await core.base.run(
      "INSERT INTO llm_calls(ts, req_id, user_id, chat_id, model, path, status, finish_reason, prompt_tokens, completion_tokens, duration_ms, n_messages, n_tool_calls, request_json, response_json) " +
        "VALUES (1700000000, 'r1', 1, 'c1', 'm', '/v1/chat/completions', 'ok', 'stop', 10, 5, 800, 2, 0, '{\"messages\": []}', 'pas du json')",
    );
    expect(await core.appeler("GET", "/api/admin/llm-traffic?model=m&limit=5", { cookie })).toMatchObject({
      count: 1,
      calls: [{ id: 1, status: "ok" }],
    });
    expect(
      await core.appeler("GET", "/api/admin/llm-traffic/1", { cookie, entetes: { "x-elpis-console": "1" } }),
    ).toMatchObject({
      request: { messages: [] },
      response: "pas du json",
    });
    await core.appeler("GET", "/api/admin/llm-traffic/99", { cookie, entetes: { "x-elpis-console": "1" } });
    await core.appeler("GET", "/api/admin/llm-traffic", { cookie: cookieModerateur });
    expect(await core.appeler("DELETE", "/api/admin/llm-traffic", { cookie })).toEqual({
      ok: true,
      deleted: 1,
    });
  });

  it("toutes les routes du domaine admin-llm ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-llm").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
