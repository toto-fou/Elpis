// SPDX-License-Identifier: MIT
/** apps/core/test/tour/enfants-interrompus.test.ts — sous-agents d'un run coupé net : annoncés s'ils ont un enregistrement de reprise ; un enfant lancé en fond ne l'est jamais ici (son job l'annonce). */
import "../moteur-environnement";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { put } from "../../src/outils/integres/task/magasin-reprise";
import { enfantsInterrompus } from "../../src/tour/enfants-interrompus";
import { reglerJournalPourTests, RunJournal } from "../../src/tour/journal-run";

let dossier = "";

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-interrompus-"));
  process.env["ELPIS_TASK_RESUME_DIR"] = path.join(dossier, "reprise");
  reglerJournalPourTests({ dossier: path.join(dossier, "runs"), balayage: false });
});

afterEach(() => {
  reglerJournalPourTests(null);
  delete process.env["ELPIS_TASK_RESUME_DIR"];
  rmSync(dossier, { recursive: true, force: true });
});

describe("sous-agents d'un run coupé", () => {
  it("annoncé : enfant synchrone sans étape finale ; jamais : enfant en fond (annoncé par son job), enfant fini", async () => {
    const j = new RunJournal(1, "c1", "r1");
    expect(await j.open({ type: "run_started" })).toBe(true);
    const lance = (id: string, appel: string, fond = false): void => {
      j.append({ type: "tool_call", name: "task", call_id: appel, args: { description: `mission ${id}` } });
      j.append({
        type: "task_step",
        child_id: id,
        agent: "explore",
        call_id: appel,
        status: "spawned",
        resumed: false,
        depth: 0,
        ...(fond ? { background: true } : {}),
      });
    };
    lance("t1-aa", "a1");
    lance("t2-bb", "a2", true);
    lance("t3-cc", "a3");
    j.append({ type: "task_step", child_id: "t3-cc", agent: "explore", call_id: "a3", status: "final" });
    await j.flush();
    for (const id of ["t1-aa", "t2-bb", "t3-cc"])
      put("alice", id, { agent: "explore", messages: [], ts: Date.now() / 1000 });
    expect(enfantsInterrompus(1, "c1", "alice")).toEqual([
      { id: "t1-aa", agent: "explore", label: "mission t1-aa", run: "r1" },
    ]);
  });
});
