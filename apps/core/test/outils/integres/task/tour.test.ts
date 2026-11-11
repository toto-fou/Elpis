// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/tour.test.ts — bornes des sous-agents malgré les réglages : aucun `task` imbriqué même si `llm.task.subagent_depth` vaut 3, `max_parallel` non bridé par LLAMA_TOOL_PARALLELISM. */
import "../../../moteur-environnement";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { executeToolBatch } from "../../../../src/boucle/execution-outils";
import type { OptionsRun } from "../../../../src/boucle/orchestrateur";
import type { SortieRun } from "../../../../src/boucle/sortie";
import type * as C from "../../../../src/llm/constantes";
import * as T from "../../../../src/outils/integres/task";
import { installerManifesteMcp } from "../../../../src/outils/ports";
import type { Dict } from "../../../../src/python";

vi.mock("../../../../src/llm/constantes", async (orig) => ({
  ...(await orig<typeof C>()),
  LLAMA_TOOL_PARALLELISM: 2,
}));

let dossier = "";
let restaurer: () => void = () => undefined;

beforeEach(() => {
  restaurer = surchargerConfig({ TASK_SUBAGENT_DEPTH: 3 });
  installerManifesteMcp({ defaultOnCategories: () => [] });
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-reprise-"));
  process.env["ELPIS_TASK_RESUME_DIR"] = dossier;
});
afterEach(() => {
  restaurer();
  installerManifesteMcp(null);
  delete process.env["ELPIS_TASK_RESUME_DIR"];
  rmSync(dossier, { recursive: true, force: true });
});

function outils(runner: (o: OptionsRun) => Promise<SortieRun>) {
  return T.buildTaskBuiltinTool({
    username: "alice",
    chatId: "c1",
    model: "m",
    samplingOverride: null,
    isCancelled: null,
    onEvent: null,
    usageSink: {},
    runner,
    hote: {
      santeNavigateur: async () => null,
      fermerNavigateur: async () => true,
      sauverRapport: async () => true,
      brancheCourante: async () => null,
    },
  });
}

it("profondeur 3 réglée : le sous-agent (lecture seule ou non) ne reçoit aucun outil task et task reste refusé", async () => {
  const vus: OptionsRun[] = [];
  const t = outils(async (o) => {
    vus.push(o);
    return ["Status: done\n## Answer\nok", [], {}];
  });
  await t["task"]!.handler({
    subagent_type: "explore",
    prompt: "lis",
    read_only: true,
  });
  await t["task"]!.handler({ subagent_type: "implement", prompt: "écris" });
  expect(vus).toHaveLength(2);
  for (const o of vus) {
    expect(Object.keys(o.builtinTools ?? {})).not.toContain("task");
    expect([...(o.denyToolNames ?? [])]).toContain("task");
  }
  expect(String((vus[0]!.messages as Dict[])[0]!["content"])).toContain("You cannot launch sub-agents");
});

it("borne propre 3 avec LLAMA_TOOL_PARALLELISM=2 : les trois sous-agents tournent ensemble", async () => {
  let enCours = 0;
  let pic = 0;
  const t = outils(async () => {
    pic = Math.max(pic, ++enCours);
    await new Promise((r) => setTimeout(r, 60));
    enCours--;
    return ["Status: done", [], {}];
  });
  const prepared = [0, 1, 2].map((i) => ({
    call_id: `c${i}`,
    tool_name: "task",
    final_args: { subagent_type: "explore", prompt: `mission ${i}` },
    meta: null,
  }));
  await executeToolBatch(prepared, {
    executeSingle: (_nom, args, r) =>
      t["task"]!.handler(args, { callId: r.callId ?? null }) as Promise<string>,
    recordMetric: () => undefined,
    isToolFailure: () => false,
    onEvent: null,
    username: "alice",
    chatId: "c1",
    onCancelSnapshot: async () => undefined,
    iteration: 0,
    emitProgressLog: false,
    bornes: new Map([["task", 3]]),
  });
  expect(pic).toBe(3);
});
