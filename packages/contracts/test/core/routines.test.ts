// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/routines.test.ts — contrats des routines (CRUD, activation, runs, webhook) rejoués contre le core TS réel ; le lancement effectif d'un run exige un moteur LLM et reste vérifié sur des exemples. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseArretRun, schemaReponseLancementRoutine } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let uid = 0;

beforeAll(async () => {
  core = await demarrerCore();
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : routines (core réel)", () => {
  it("création validée, liste, lecture, mise à jour, activation, suppression", async () => {
    expect(
      await core.appeler("POST", "/api/routines", {
        cookie,
        corps: { name: "R1", cron_expr: "0 8 * * *", task_prompt: "Fais X", notify_on: "error" },
      }),
    ).toEqual({ id: 1, ok: true });
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "" } });
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "R", cron_expr: "pas un cron" } });
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "R", notify_on: "x" } });
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "R", skills: ["inconnu"] } });
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "R", trigger_after_id: 99 } });
    await core.appeler("POST", "/api/routines", { cookie, corps: { name: "R2", trigger_after_id: 1 } });
    expect(await core.appeler("GET", "/api/routines", { cookie })).toMatchObject({
      items: [
        { id: 2, trigger_after_id: 1 },
        { id: 1, notify_on: "error", running_count: 0 },
      ],
    });
    expect(await core.appeler("GET", "/api/routines/1", { cookie })).toMatchObject({ name: "R1" });
    await core.appeler("GET", "/api/routines/1", { cookie: cookieLou });
    expect(
      await core.appeler("PUT", "/api/routines/1", { cookie, corps: { name: "R1b", enabled: false } }),
    ).toEqual({
      ok: true,
    });
    await core.appeler("PUT", "/api/routines/1", { cookie, corps: { trigger_after_id: 1 } });
    await core.appeler("PUT", "/api/routines/99", { cookie, corps: { name: "x" } });
    expect(await core.appeler("POST", "/api/routines/1/enable", { cookie })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(await core.appeler("POST", "/api/routines/1/disable", { cookie })).toEqual({
      ok: true,
      enabled: false,
    });
    await core.appeler("POST", "/api/routines/99/enable", { cookie });
    expect(await core.appeler("DELETE", "/api/routines/2", { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", "/api/routines/2", { cookie });
    await core.appeler("GET", "/api/routines");
  });

  it("exécution immédiate refusée si désactivée, historique, arrêt d'un run", async () => {
    await core.appeler("POST", "/api/routines/1/run-now", { cookie });
    await core.appeler("POST", "/api/routines/99/run-now", { cookie });
    await core.base.run(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, trigger, started_at, ended_at, duration_ms, summary, files) " +
        "VALUES (1, ?, 'ok', 'manual', 1700000000, 1700000010, 10000, 'Fini', '[]')",
      [uid],
    );
    await core.base.run(
      "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, trigger, started_at) VALUES (1, ?, 'running', 'schedule', 1700000100)",
      [uid],
    );
    expect(await core.appeler("GET", "/api/routines/1/runs?limit=10", { cookie })).toMatchObject({
      items: [{ status: "running" }, { status: "ok", summary: "Fini" }],
    });
    await core.appeler("GET", "/api/routines/99/runs", { cookie });
    expect(await core.appeler("POST", "/api/routines/1/runs/1/stop", { cookie })).toEqual({
      ok: true,
      stopping: false,
      status: "ok",
    });
    expect(await core.appeler("POST", "/api/routines/1/runs/2/stop", { cookie })).toMatchObject({ ok: true });
    await core.appeler("POST", "/api/routines/1/runs/99/stop", { cookie });
    expect(schemaReponseLancementRoutine.parse({ ok: true, run_id: 7 })).toEqual({ ok: true, run_id: 7 });
    const saute = { ok: false, skipped: true, reason: "cap de runs simultanés atteint" };
    expect(schemaReponseLancementRoutine.parse(saute)).toEqual(saute);
    expect(schemaReponseArretRun.parse({ ok: true, stopping: true })).toEqual({ ok: true, stopping: true });
  });

  it("webhook : rotation du secret, filtre, désactivation", async () => {
    expect(await core.appeler("POST", "/api/routines/1/webhook/rotate", { cookie })).toMatchObject({
      ok: true,
      path: "/api/webhooks/routines/1",
    });
    expect(
      await core.appeler("POST", "/api/routines/1/webhook/filter", {
        cookie,
        corps: { events: ["push", "Push"], branch: "main" },
      }),
    ).toEqual({ ok: true, webhook_filter: { events: ["push"], branch: "main", repo: "" } });
    await core.appeler("POST", "/api/routines/1/webhook/filter", {
      cookie,
      corps: { events: ["pas valide"] },
    });
    await core.appeler("POST", "/api/routines/1/webhook/rotate", { cookie: cookieLou });
    expect(await core.appeler("POST", "/api/routines/1/webhook/disable", { cookie })).toEqual({
      ok: true,
      webhook_enabled: false,
    });
  });

  it("toutes les routes du domaine routines ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "routines").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
