// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/code.test.ts — contrats de la page Code rejoués contre le core TS réel, avec une CLI opencode simulée par ingestion et jeton. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore, verifierReponse } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let jeton = "";

async function cli(methode: string, url: string, corps?: unknown): Promise<unknown> {
  const r = await core.app.inject({
    method: methode as "GET",
    url,
    headers: { "x-elpis-token": jeton },
    ...(corps === undefined ? {} : { payload: corps as object }),
  });
  return verifierReponse(methode, url, r.statusCode, r.body, core.couvertes);
}

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : code (core réel)", () => {
  it("santé, configuration et jetons sans CLI", async () => {
    expect(await core.appeler("GET", "/api/code/health", { cookie })).toMatchObject({
      available: true,
      connected: false,
      sessions: 0,
    });
    await core.appeler("GET", "/api/code/health");
    expect(await core.appeler("GET", "/api/code/config", { cookie })).toMatchObject({ tokens: 0 });
    const t = (await core.appeler("POST", "/api/code/token", { cookie, corps: { name: "poste" } })) as {
      token: string;
    };
    jeton = t.token;
    expect(await core.appeler("GET", "/api/code/config", { cookie })).toMatchObject({ tokens: 1 });
    jeton = ((await core.appeler("POST", "/api/code/token/rotate", { cookie })) as { token: string }).token;
    expect(await core.appeler("GET", "/api/code/config", { cookie })).toMatchObject({ tokens: 1 });
    expect(await core.appeler("GET", "/api/code/sessions", { cookie })).toEqual([]);
    expect(await core.appeler("GET", "/api/code/commands", { cookie })).toEqual([]);
    expect(await core.appeler("GET", "/api/code/models", { cookie })).toEqual({ providers: [], default: {} });
    expect(await core.appeler("GET", "/api/code/agents", { cookie })).toEqual({ agents: [], default: "" });
    expect(await core.appeler("GET", "/api/code/clients", { cookie })).toEqual([]);
    expect(await core.appeler("GET", "/api/code/sessions/s1/messages", { cookie })).toEqual([]);
    expect(await core.appeler("GET", "/api/code/sessions/s1/permissions", { cookie })).toEqual([]);
    expect(await core.appeler("GET", "/api/code/sessions/s1/questions", { cookie })).toEqual([]);
  });

  it("commandes refusées sans CLI connectée ou mal formées", async () => {
    const corps = { text: "salut" };
    await core.appeler("POST", "/api/code/sessions/s1/prompt", { cookie, corps });
    await core.appeler("POST", "/api/code/sessions/s1/prompt", { cookie, corps: { text: " " } });
    await core.appeler("POST", "/api/code/sessions/s1/command", { cookie, corps: { command: "remote" } });
    await core.appeler("POST", "/api/code/sessions/s1/command", { cookie, corps: { command: "" } });
    await core.appeler("POST", "/api/code/sessions/s1/abort", { cookie });
    await core.appeler("POST", "/api/code/sessions/s1/action", { cookie, corps: { action: "zzz" } });
    await core.appeler("POST", "/api/code/sessions/s1/rename", { cookie, corps: { title: "" } });
    await core.appeler("POST", "/api/code/sessions/s1/permissions/p1", { cookie, corps: { response: "x" } });
    await core.appeler("POST", "/api/code/sessions/s1/questions/q1", { cookie, corps: { answers: [] } });
    await core.appeler("POST", "/api/code/new", { cookie, corps: {} });
    await core.appeler("POST", "/api/code/clients/c1/exit", { cookie });
    await core.appeler("POST", "/api/code/clients/c1/disconnect", { cookie });
  });

  it("CLI simulée : ingestion, tirage, commandes en file, sessions", async () => {
    expect(await cli("GET", "/api/code/hello")).toEqual({ ok: true, user: "zoe" });
    expect(
      await cli("POST", "/api/code/ingest", {
        client: "c1",
        directory: "/tmp/p",
        plugin: 20,
        events: [
          {
            type: "session.snapshot",
            properties: { session: { id: "s1", title: "Essai", time: { created: 1, updated: 2 } } },
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(await core.appeler("GET", "/api/code/health", { cookie })).toMatchObject({ connected: true });
    expect(await core.appeler("GET", "/api/code/clients", { cookie })).toMatchObject([
      { id: "c1", plugin_version: 20 },
    ]);
    expect(await core.appeler("GET", "/api/code/sessions", { cookie })).toMatchObject([{ id: "s1" }]);
    await core.appeler("GET", "/api/code/sessions/s1/messages", { cookie });
    const queued = { ok: true, queued: true };
    expect(
      await core.appeler("POST", "/api/code/sessions/s1/prompt", { cookie, corps: { text: "Bonjour" } }),
    ).toEqual(queued);
    await core.appeler("POST", "/api/code/sessions/s1/prompt", {
      cookie,
      corps: { text: "x", model: { providerID: "p", modelID: "m" }, agent: "inconnu" },
    });
    expect(
      await core.appeler("POST", "/api/code/sessions/s1/command", {
        cookie,
        corps: { command: "/compact", arguments: "" },
      }),
    ).toEqual(queued);
    expect(await core.appeler("POST", "/api/code/sessions/s1/abort", { cookie })).toEqual(queued);
    expect(
      await core.appeler("POST", "/api/code/sessions/s1/action", { cookie, corps: { action: "undo" } }),
    ).toEqual(queued);
    expect(
      await core.appeler("POST", "/api/code/sessions/s1/rename", { cookie, corps: { title: "Nouveau" } }),
    ).toEqual(queued);
    expect(
      await core.appeler("POST", "/api/code/sessions/s1/permissions/p1", {
        cookie,
        corps: { response: "once" },
      }),
    ).toEqual(queued);
    expect(
      await core.appeler("POST", "/api/code/sessions/s1/questions/q1", { cookie, corps: { reject: true } }),
    ).toEqual(queued);
    await core.appeler("POST", "/api/code/sessions/s1/questions/q1", { cookie, corps: { answers: [["a"]] } });
    expect(await core.appeler("POST", "/api/code/new", { cookie, corps: { client: "c1" } })).toEqual({
      ...queued,
      client: "c1",
    });
    await core.appeler("POST", "/api/code/clients/c1/exit", { cookie });
    await core.appeler("POST", "/api/code/clients/c1/disconnect", { cookie });
    const tire = (await cli("GET", "/api/code/pull?client=c1&wait=0")) as { commands: unknown[] };
    expect(tire.commands.length).toBeGreaterThan(5);
    expect(await core.appeler("DELETE", "/api/code/sessions/s1", { cookie })).toEqual({ ok: true });
    expect(await cli("POST", "/api/code/bye", { client: "c1" })).toEqual({ ok: true });
  });

  it("appairage : démarrage, sonde en attente, confirmation, jeton remis", async () => {
    const debut = (await core.appeler("POST", "/api/code/pair/start")) as { id: string; code: string };
    expect(await core.appeler("GET", `/api/code/pair/poll?id=${debut.id}`)).toEqual({ status: "pending" });
    await core.appeler("POST", "/api/code/pair/confirm", { cookie, corps: { code: "" } });
    await core.appeler("POST", "/api/code/pair/confirm", { cookie, corps: { code: "ZZZ-ZZZ" } });
    expect(
      await core.appeler("POST", "/api/code/pair/confirm", { cookie, corps: { code: debut.code } }),
    ).toEqual({
      ok: true,
    });
    expect(await core.appeler("GET", `/api/code/pair/poll?id=${debut.id}`)).toMatchObject({ status: "ok" });
    await core.appeler("GET", `/api/code/pair/poll?id=${debut.id}`);
  });

  it("toutes les routes du domaine sous contrat ont été interrogées (hors flux SSE et greffon)", () => {
    const manquantes = CONTRATS_REST.filter((r) => r.domaine === "code" && !core.couvertes.has(cle(r)));
    expect(manquantes.map(cle)).toEqual([]);
  });
});
