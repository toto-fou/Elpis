// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/chats-runs.test.ts — contrats des conversations, des exécutions et du pilotage d'un tour rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaExportExecution, schemaReponseNouveauChat } from "../../src";
import { cle, creerCompte, demarrerCore, verifierReponse } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let uid = 0;

beforeAll(async () => {
  core = await demarrerCore();
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

async function nouveauChat(corps?: unknown): Promise<string> {
  return schemaReponseNouveauChat.parse(
    await core.appeler("POST", "/api/saved/chats/new", { cookie, ...(corps === undefined ? {} : { corps }) }),
  ).id;
}

async function insererExecution(id: string, parent = ""): Promise<void> {
  await core.base.run(
    "INSERT INTO runs(id, kind, user_id, chat_id, parent_id, model, engine, started_at, ended_at, status, input_tokens, tool_families) " +
      "VALUES (?, 'chat', ?, 'c1', ?, 'm', 'builtin', 1700000000, 1700000010.5, 'ok', 1000, '{\"fs\": 2}')",
    [id, uid, parent],
  );
}

describe("contrats REST : conversations (core réel)", () => {
  it("création, lecture, renommage, outils, mode plan, sauvegarde, recherche, archivage, suppression", async () => {
    const a = await nouveauChat();
    const b = await nouveauChat({ plan_mode: true });
    await core.appeler("POST", "/api/saved/chats/new", { cookie, corps: { plan_mode: "oui" } });
    expect(
      await core.appeler("PATCH", `/api/saved/chats/${a}`, { cookie, corps: { title: "Plan de test" } }),
    ).toEqual({
      ok: true,
    });
    await core.appeler("PUT", `/api/saved/chats/${a}/tools`, { cookie, corps: { tools: ["fs", "shell"] } });
    await core.appeler("PUT", `/api/saved/chats/inconnu/tools`, { cookie, corps: { tools: ["fs"] } });
    expect(
      await core.appeler("PUT", `/api/saved/chats/${a}/plan-mode`, { cookie, corps: { plan_mode: false } }),
    ).toEqual({ ok: true, plan_mode: false });
    const messages = [
      { role: "user", content: "Bonjour é" },
      { role: "assistant", content: "Salut", metrics: { tokens: 3 }, run_ids: ["chat-a1"] },
    ];
    expect(
      await core.appeler("PUT", `/api/saved/chats/${a}/save-messages`, { cookie, corps: { messages } }),
    ).toEqual({ ok: true });
    expect(
      await core.appeler("PUT", `/api/saved/chats/${a}/save-messages`, {
        cookie,
        corps: { messages: [{ role: "user", content: "B" }] },
      }),
    ).toEqual({ ok: true, skipped: "stale" });
    expect(
      await core.appeler("PUT", `/api/saved/chats/inconnu/save-messages`, { cookie, corps: { messages } }),
    ).toEqual({ ok: true, skipped: "absent" });
    expect(await core.appeler("GET", `/api/saved/chats/${a}`, { cookie })).toMatchObject({
      title: "Plan de test",
      tools: ["fs", "shell"],
      messages,
    });
    expect(await core.appeler("GET", `/api/saved/chats/${b}`, { cookie })).toMatchObject({ plan_mode: true });
    expect(
      await core.appeler("PUT", `/api/saved/chats/${a}/rag`, { cookie, corps: { collections: [] } }),
    ).toEqual({
      ok: true,
      rag: { collections: [], mode: "mixte", top_k: 8 },
    });
    await core.appeler("PUT", `/api/saved/chats/${a}/rag`, { cookie, corps: { collections: ["x"] } });
    await core.appeler("PUT", `/api/saved/chats/inconnu/rag`, { cookie, corps: { collections: [] } });
    await core.appeler("GET", "/api/saved/chats/inconnu", { cookie });
    expect(await core.appeler("GET", "/api/saved/chats", { cookie })).toMatchObject({
      items: [{ id: a }, { id: b }],
    });
    await core.appeler("GET", "/api/saved/chats/search?q=plan", { cookie });
    await core.appeler("GET", "/api/saved/chats/search?q=bonjour&deep=1", { cookie });
    await core.appeler("GET", "/api/saved/chats/search?q=", { cookie });
    await core.appeler("POST", `/api/saved/chats/${a}/archive`, { cookie });
    await core.appeler("GET", "/api/saved/chats?archived=1", { cookie });
    await core.appeler("POST", `/api/saved/chats/${a}/unarchive`, { cookie });
    await core.appeler("POST", "/api/saved/chats/archive-batch", { cookie, corps: { ids: [a, "inconnu"] } });
    await core.appeler("POST", "/api/saved/chats/delete-batch", { cookie, corps: { ids: [a] } });
    await core.appeler("POST", "/api/saved/chats/delete-batch", { cookie, corps: { ids: "x" } });
    await core.appeler("DELETE", `/api/saved/chats/${b}`, { cookie });
    await core.appeler("DELETE", `/api/saved/chats/${b}`, { cookie });
    await nouveauChat();
    expect(await core.appeler("POST", "/api/saved/chats/clear-all", { cookie })).toEqual({
      ok: true,
      deleted: 1,
    });
    expect(await core.appeler("GET", "/api/inbox/count", { cookie })).toEqual({ count: 0, prompts: 0 });
    await core.appeler("GET", "/api/saved/chats");
  });
});

describe("contrats REST : exécutions et pilotage du tour (core réel)", () => {
  it("exécution et filles, chronologie, export ; état de génération, runs actifs, arrêts", async () => {
    await insererExecution("chat-a1");
    await insererExecution("subagent-b2", "chat-a1");
    await core.base.run(
      "INSERT INTO usage_events(ts, user_id, source, model, connector, input_tokens, duration_ms, iterations, run_id) " +
        "VALUES (1700000003.5, ?, 'chat', 'm', 'builtin', 600, 1500, 1, 'chat-a1')",
      [uid],
    );
    await core.base.run(
      "INSERT INTO tool_call_metrics(run_id, user_id, tool_name, status, duration_ms, ts, call_id, started_at, category, exit_code) " +
        "VALUES ('chat-a1', ?, 'execute_shell', 'success', 900, 1700000005, 'call_1', 1700000004.25, 'shell', 0)",
      [uid],
    );
    expect(await core.appeler("GET", "/api/runs/chat-a1", { cookie })).toMatchObject({
      children: [{ id: "subagent-b2", children: [] }],
      tool_families: { fs: 2 },
    });
    const chrono = await core.appeler("GET", "/api/runs/chat-a1/timeline", { cookie });
    expect(chrono).toMatchObject({ events: [{ type: "child" }, { type: "llm" }, { type: "tool" }] });
    await core.appeler("GET", "/api/runs/inconnu-x/timeline", { cookie });
    const r = await core.app.inject({ method: "GET", url: "/api/runs/chat-a1/export", headers: { cookie } });
    expect(r.headers["content-disposition"]).toContain("execution-chat-a1.json");
    verifierReponse("GET", "/api/runs/chat-a1/export", r.statusCode, r.body, core.couvertes);
    expect(schemaExportExecution.parse(JSON.parse(r.body)).children_timelines).toHaveLength(1);

    const chat = await nouveauChat();
    expect(await core.appeler("GET", `/api/chat/${chat}/generation-status`, { cookie })).toEqual({
      generation_running: false,
      run_id: null,
      resumable: false,
    });
    expect(await core.appeler("GET", "/api/chats/active-runs", { cookie })).toEqual({ chat_ids: [] });
    expect(await core.appeler("POST", "/api/chat/cancel", { cookie, corps: { chat_id: chat } })).toEqual({
      status: "cancelled",
    });
    await core.appeler("POST", "/api/chat/cancel", { cookie, corps: {} });
    expect(
      await core.appeler("POST", "/api/chat/task-cancel", { cookie, corps: { child_id: "x1" } }),
    ).toEqual({
      status: "cancelled",
      active: false,
    });
    await core.appeler("POST", "/api/chat/task-cancel", { cookie, corps: {} });
    expect(await core.appeler("POST", "/api/chat/reasoning-end", { cookie, corps: {} })).toEqual({
      ok: false,
      reason: "no_chat",
    });
    await core.appeler("POST", "/api/chat/reasoning-end", { cookie, corps: { chat_id: chat } });
    await core.appeler("POST", "/api/chat/reasoning-end", { cookie, corps: { chat_id: "inconnu" } });
    await core.appeler("POST", "/api/chat/compress", {
      cookie,
      corps: { messages: [{ role: "user", content: "x" }] },
    });
  });

  it("toutes les routes des domaines chats et runs ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "chats" || r.domaine === "runs").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
