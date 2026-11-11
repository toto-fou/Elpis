// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-runs.test.ts — contrats des exécutions de la console (liste, agrégat par compte, chronologie, export) rejoués contre le core TS réel en process admin. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore, verifierReponse } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieModerateur = "";
let uid = 0;

beforeAll(async () => {
  core = await demarrerCore("admin");
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "max", "mdp-de-max-1", 2);
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieModerateur = await core.connecter("max", "mdp-de-max-1");
  const maintenant = Date.now() / 1000;
  for (const [id, parent] of [
    ["chat-a1", ""],
    ["subagent-b2", "chat-a1"],
  ] as const)
    await core.base.run(
      "INSERT INTO runs(id, kind, user_id, chat_id, parent_id, model, engine, started_at, ended_at, status, input_tokens, tool_families) " +
        "VALUES (?, ?, ?, 'c1', ?, 'm', 'builtin', ?, ?, 'ok', 1000, '{\"fs\": 2}')",
      [id, parent === "" ? "chat" : "subagent", uid, parent, maintenant - 60, maintenant - 50],
    );
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : exécutions de la console (core réel)", () => {
  it("liste filtrée, agrégat par compte, refus à un compte ordinaire", async () => {
    expect(await core.appeler("GET", "/api/admin/runs", { cookie: cookieModerateur })).toMatchObject({
      items: [{ id: "chat-a1", username: "zoe" }],
    });
    expect(
      await core.appeler("GET", "/api/admin/runs?kind=subagent&hours=1000&limit=5", { cookie }),
    ).toMatchObject({
      items: [{ id: "subagent-b2" }],
    });
    await core.appeler("GET", `/api/admin/runs?user_id=${uid}&status=ok`, { cookie });
    await core.appeler("GET", "/api/admin/runs?kind=inconnu", { cookie });
    await core.appeler("GET", "/api/admin/runs?status=a%20b", { cookie });
    expect(
      await core.appeler("GET", "/api/admin/runs/accounts?hours=2", { cookie: cookieModerateur }),
    ).toMatchObject({
      hours: 2,
      items: [{ username: "zoe", runs: 1, subagents: 1 }],
    });
    await core.appeler("GET", "/api/admin/runs");
  });

  it("chronologie et export d'une exécution, réservés à l'administrateur", async () => {
    expect(await core.appeler("GET", "/api/admin/runs/chat-a1/timeline", { cookie })).toMatchObject({
      events: [{ type: "child" }],
    });
    await core.appeler("GET", "/api/admin/runs/inconnu/timeline", { cookie });
    await core.appeler("GET", "/api/admin/runs/chat-a1/timeline", { cookie: cookieModerateur });
    const r = await core.app.inject({
      method: "GET",
      url: "/api/admin/runs/chat-a1/export",
      headers: { cookie, "x-elpis-console": "1" },
    });
    verifierReponse("GET", "/api/admin/runs/chat-a1/export", r.statusCode, r.body, core.couvertes);
    expect(r.headers["content-disposition"]).toContain("execution-chat-a1.json");
    await core.appeler("GET", "/api/admin/runs/inconnu/export", {
      cookie,
      entetes: { "x-elpis-console": "1" },
    });
  });

  it("toutes les routes du domaine admin-runs ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-runs").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
