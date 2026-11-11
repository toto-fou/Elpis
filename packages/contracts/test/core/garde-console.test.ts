// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/garde-console.test.ts — les GET de la console qui écrivent une trace refusent (403) une requête inter-site ou sans l'en-tête de la console, avant tout travail et toute trace. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let audit = "";
let dossier = "";

const ENTETE = { "x-elpis-console": "1" };
const ROUTES = [
  { url: "/api/admin/export-metrics?target=usage_events", action: "admin.metrics.export" },
  { url: "/api/admin/runs/chat-a1/export", action: "admin.runs.export" },
  { url: "/api/admin/llm-traffic/1", action: "admin.llm_traffic.read" },
] as const;

/** Actions écrites, hors `auth.forbidden` (refus générique agrégé, détails fixes, que tout 403 écrit). */
const actions = (): string[] =>
  readdirSync(audit)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(audit, f), "utf8").split("\n").filter(Boolean))
    .map((l) => String((JSON.parse(l) as Record<string, unknown>)["action"]))
    .filter((a) => a !== "auth.forbidden");

const lire = (url: string, entetes: Record<string, string>) =>
  core.app.inject({ method: "GET", url, headers: { cookie, ...entetes } });

beforeAll(async () => {
  core = await demarrerCore("admin");
  dossier = mkdtempSync(join(tmpdir(), "elpis-garde-console-"));
  audit = join(dossier, "audit");
  oublierConfigurationAudit();
  configureAudit({ service: "admin", auditDir: audit, hmacKeyPath: join(dossier, "absente") });
  const uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  await core.base.run(
    "INSERT INTO runs(id, kind, user_id, chat_id, parent_id, model, engine, started_at, ended_at, status, input_tokens, tool_families) " +
      "VALUES ('chat-a1', 'chat', ?, 'c1', '', 'm', 'builtin', 1700000000, 1700000010, 'ok', 1000, '{}')",
    [uid],
  );
  await core.base.run(
    "INSERT INTO llm_calls(ts, req_id, user_id, chat_id, model, path, status, finish_reason, prompt_tokens, completion_tokens, duration_ms, n_messages, n_tool_calls, request_json, response_json) " +
      "VALUES (1700000000, 'r1', 1, 'c1', 'm', '/v1/chat/completions', 'ok', 'stop', 10, 5, 800, 2, 0, '{}', '{}')",
  );
});

afterAll(async () => {
  await core.fermer();
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

describe("lectures tracées de la console : garde d'en-tête", () => {
  for (const { url, action } of ROUTES)
    it(`${url.split("?")[0]} : refus sans en-tête ou inter-site, sans trace ; trace avec l'en-tête`, async () => {
      const avant = actions();
      for (const entetes of [
        {} as Record<string, string>,
        { "x-elpis-console": "0" },
        { ...ENTETE, "sec-fetch-site": "cross-site" },
        { ...ENTETE, origin: "http://autre.example", host: "elpis.lan" },
      ]) {
        const r = await lire(url, entetes);
        expect([url, r.statusCode]).toEqual([url, 403]);
        expect(r.json<{ detail: string }>().detail).toMatch(/^Lecture refusée/u);
      }
      expect(actions()).toEqual(avant);
      expect((await lire(url, ENTETE)).statusCode).toBe(200);
      expect(actions()).toEqual([...avant, action]);
    });

  it("sauvegarde : refusée sans l'en-tête (rien n'est compressé), validation atteinte avec", async () => {
    const url = "/api/admin/backup?scope=zzz";
    expect((await lire(url, {})).statusCode).toBe(403);
    expect((await lire(url, { ...ENTETE, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await lire(url, ENTETE)).statusCode).toBe(400);
  });
});
