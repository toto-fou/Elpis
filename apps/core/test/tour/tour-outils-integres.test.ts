// SPDX-License-Identifier: MIT
/** apps/core/test/tour/tour-outils-integres.test.ts — activation par tour des outils intégrés routine_save, agent_save et ask_user : réglage, sous-agents coupés par l'administrateur, outils coupés, mode plan, tour éphémère, tour de réveil (les refus routine et sous-agent sont dans outils/integres/routine.test.ts et agent-save.test.ts). */
import "../moteur-environnement";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeUserSettings } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setChatPlanMode, upsertChat } from "../../src/chats/stockage";
import type { OutilIntegre } from "../../src/outils/catalogue";
import { installerBaseExecutions } from "../../src/executions/registre";
import { ouvrirTour } from "../../src/familles/chat";
import { brancherLlm } from "../../src/llm/branchement";
import { reglerExecutionPourTests, runTurn } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";

let t: BaseDeTest;
let dossier: string;
let restaurer: () => void;
let n = 0;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-tour-integres-"));
  restaurer = surchargerConfig({ DB_PATH: join(dossier, "user_db", "app.db") });
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  brancherLlm(t.base);
  installerBaseExecutions(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
    ["alice", "s", "h", 0, 0],
  );
});

afterAll(async () => {
  restaurer();
  reglerExecutionPourTests(null);
  await t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

/** Joue un tour et rend les outils intégrés proposés et le refus transmis à la boucle. */
async function tour(
  reglages: Dict,
  o: { plan?: boolean; ephemeral?: boolean; reveil?: boolean } = {},
): Promise<{ proposes: string[]; deny: string[]; outils: Readonly<Record<string, OutilIntegre>> }> {
  const chat = `integres${(n += 1)}`;
  await mergeUserSettings(
    t.base,
    1,
    (r) => void Object.assign(r, { enable_mcp: true, routine_tool_enabled: true }, reglages),
  );
  if (o.plan) {
    await upsertChat(t.base, 1, chat, "t", [{ role: "user", content: "x" }], Date.now() / 1000);
    await setChatPlanMode(t.base, 1, chat, true);
  }
  const vu = {
    proposes: [] as string[],
    deny: [] as string[],
    outils: {} as Readonly<Record<string, OutilIntegre>>,
  };
  reglerExecutionPourTests({
    etatFile: async () => ({ kind: "ready" }),
    contexteModele: async () => 0,
    admission: async (_o, fn) => fn(null),
    titre: async () => null,
    boucle: async (b) => {
      vu.outils = (b.builtinTools ?? {}) as Readonly<Record<string, OutilIntegre>>;
      vu.proposes = Object.keys(vu.outils);
      vu.deny = [...(b.denyToolNames ?? [])];
      return ["ok", [], {}];
    },
  });
  const r = await ouvrirTour(
    { base: t.base },
    1,
    {
      chat_id: chat,
      messages: [{ role: "user", content: "crée une routine" }],
      ...(o.ephemeral ? { ephemeral: true } : {}),
    },
    o.reveil ? { origin: "job_wake", wake: {}, depth: 1 } : null,
  );
  for await (const _ev of runTurn({ base: t.base }, r.plan, r.res, r.base, new AbortController().signal));
  return vu;
}

describe("ask_user intégré au tour", () => {
  it("proposé dès que les outils sont actifs, mode plan compris ; absent outils coupés", async () => {
    expect((await tour({})).proposes).toContain("ask_user");
    expect((await tour({}, { plan: true })).proposes).toContain("ask_user");
    expect((await tour({ enable_mcp: false })).proposes).not.toContain("ask_user");
  });

  it("absent d'un tour éphémère (Studio)", async () => {
    expect((await tour({}, { ephemeral: true })).proposes).not.toContain("ask_user");
  });
});

describe("routine_save intégré au tour", () => {
  it("proposé par défaut, absent réglage coupé, outils coupés ou mode plan", async () => {
    expect((await tour({})).proposes).toContain("routine_save");
    expect((await tour({ routine_tool_enabled: true })).proposes).toContain("routine_save");
    expect((await tour({ routine_tool_enabled: false })).proposes).not.toContain("routine_save");
    expect((await tour({ enable_mcp: false })).proposes).not.toContain("routine_save");
    const plan = await tour({}, { plan: true });
    expect(plan.proposes).not.toContain("routine_save");
    expect(plan.deny).toContain("routine_save");
  });

  it("absent d'un tour éphémère (Studio)", async () => {
    expect((await tour({}, { ephemeral: true })).proposes).not.toContain("routine_save");
  });
});

describe("agent_save intégré au tour", () => {
  it("proposé par défaut, absent sous-agents coupés par l'administrateur, outils coupés ou mode plan", async () => {
    expect((await tour({})).proposes).toContain("agent_save");
    expect((await tour({ enable_mcp: false })).proposes).not.toContain("agent_save");
    const plan = await tour({}, { plan: true });
    expect(plan.proposes).not.toContain("agent_save");
    expect(plan.deny).toContain("agent_save");
    const remettre = surchargerConfig({ AGENTS_ENABLED: false });
    try {
      expect((await tour({})).proposes).not.toContain("agent_save");
    } finally {
      remettre();
    }
  });

  it("absent d'un tour éphémère (Studio)", async () => {
    expect((await tour({}, { ephemeral: true })).proposes).not.toContain("agent_save");
  });

  it("tour de réveil (job_wake) : proposé (outils du tour inchangés) mais refusé, une injection ne réécrit pas un agent", async () => {
    const r = await tour({}, { reveil: true });
    expect(r.proposes).toContain("agent_save");
    const sortie = JSON.parse(
      String(await r.outils["agent_save"]!.handler({ name: "x", prompt: "y" })),
    ) as Dict;
    expect(sortie).toMatchObject({ ok: false, error: "unavailable" });
    expect(String(sortie["message"])).toContain("wake-up turn");
  });
});
