// SPDX-License-Identifier: MIT
/** apps/core/test/executions/registre.test.ts — exécutions : mesures tolérantes, familles d'outils, échantillonnage de la sandbox, écriture finale relancée, ports de la boucle, des fournisseurs et des sous-agents. */
import "../moteur-environnement";

import { initialiserBase } from "@elpis/db";
import type { Executeur } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dansPorteeExecution,
  executionEnCours,
  installerExecutionCourante,
  installerPorteeExecution,
} from "../../src/boucle/ports";
import { brancherExecutions } from "../../src/executions/branchements";
import {
  currentRun,
  Execution,
  getRun,
  installerBaseExecutions,
  installerEchantillonneurBac,
  markLostRuns,
  purgeRuns,
  reglerExecutionsPourTests,
  runScope,
} from "../../src/executions/registre";
import { executions, installerExecutions } from "../../src/llm/ports";

let t: BaseDeTest;

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
});

afterEach(async () => {
  installerBaseExecutions(null);
  installerEchantillonneurBac(null);
  installerExecutionCourante(null);
  installerExecutions(null);
  installerPorteeExecution(null);
  reglerExecutionsPourTests({ horloge: null });
  await t.fermer();
});

describe("mesures d'une exécution", () => {
  it("jetons, timings et attentes tolérants (illisible ou négatif ignoré), familles d'outils en JSON ASCII trié", () => {
    const e = new Execution({ id: "chat-x", kind: "chat" });
    e.addUsage({ source: "chat", status: " ", input_tokens: "12", output_tokens: "1.5", tool_tokens: -3 });
    e.addLlmCall({ prompt_ms: "12.7", predicted_ms: -5 });
    e.addLlmCall({ prompt_ms: "abc", predicted_ms: true });
    e.addLlmCall([1]);
    e.addWait([]);
    e.addWait("40");
    e.addToolCall("é", "error");
    e.addToolCall("", "success");
    e.addFiles([{ path: "a" }, "a", 3, { path: "" }, "b"]);
    e.finish();
    const ligne = e.row();
    expect([ligne["input_tokens"], ligne["output_tokens"], ligne["tool_tokens"], ligne["status"]]).toEqual([
      12,
      0,
      0,
      "ok",
    ]);
    expect([ligne["llm_calls"], ligne["prefill_ms"], ligne["decode_ms"], ligne["wait_ms"]]).toEqual([
      3, 12, 1, 40,
    ]);
    expect([ligne["tool_families"], ligne["tool_errors"], ligne["files_changed"]]).toEqual([
      '{"other": 1, "\\u00e9": 1}',
      1,
      2,
    ]);
  });

  it("réflexion bornée par la sortie, outils bornés par l'entrée", () => {
    const e = new Execution({ id: "chat-y", kind: "chat" });
    e.addUsage({
      source: "autre",
      status: "ok",
      input_tokens: 5,
      output_tokens: 2,
      thinking_tokens: 9,
      tool_tokens: 9,
    });
    expect([e.row()["tool_tokens"], e.row()["thinking_tokens"]]).toEqual([5, 2]);
  });

  it("purge et pertes : rien sans durée de rétention ; base absente sans erreur", async () => {
    expect(await purgeRuns(t.base, 0)).toBe(0);
    const panne = { run: () => Promise.reject(new Error("panne")) } as unknown as Executeur;
    expect([await purgeRuns(panne, 1), await markLostRuns(panne)]).toEqual([0, 0]);
  });
});

describe("portée d'exécution", () => {
  it("sandbox échantillonnée pour une exécution de premier niveau d'un compte, jamais pour ses filles", async () => {
    const vus: number[] = [];
    installerEchantillonneurBac(async (uid) => (vus.push(uid), { cpu_pct: vus.length * 10, mem_mb: 64 }));
    reglerExecutionsPourTests({ dormir: () => new Promise((ok) => setImmediate(ok)) });
    let fille: Execution | null = null;
    const e = await runScope("chat", { userId: "7" }, async (ex) => {
      await runScope("subagent", { userId: 7 }, async (f) => {
        fille = f;
        await new Promise((ok) => setTimeout(ok, 20));
      });
      return ex;
    });
    expect(vus.length).toBeGreaterThan(0);
    expect(new Set(vus)).toEqual(new Set([7]));
    expect([e.sandbox_cpu_peak, e.sandbox_mem_peak_mb]).toEqual([vus.length * 10, 64]);
    expect([fille!.parent_id, fille!.sandbox_cpu_peak]).toEqual([e.id, null]);
    const n = vus.length;
    await new Promise((ok) => setTimeout(ok, 20));
    expect(vus.length).toBe(n);
  });

  it("ligne « running » écrite une fois, finale relancée jusqu'à trois fois, dans l'ordre", async () => {
    const ecrits: string[] = [];
    let echecs = 2;
    installerBaseExecutions({
      run: async (_sql: string, params: unknown[]) => {
        const statut = String(params[10]);
        if (statut !== "running" && echecs-- > 0) throw new Error("database is locked");
        ecrits.push(statut);
        return { changes: 1 };
      },
    } as unknown as Executeur);
    reglerExecutionsPourTests({ dormir: () => Promise.resolve() });
    let e: Execution | null = null;
    await runScope("chat", { runId: "chat-ordre" }, async (ex) => {
      e = ex;
    });
    await e!.ecrituresTerminees();
    expect(ecrits).toEqual(["running", "ok"]);
  });

  it("une erreur qui traverse pose l'issue et remonte ; l'issue posée avant l'emporte", async () => {
    installerBaseExecutions(t.base);
    await expect(
      runScope("chat", { runId: "chat-err" }, () => Promise.reject(new TypeError("boum"))),
    ).rejects.toThrow("boum");
    await runScope("chat", { runId: "chat-issue" }, async (ex) => {
      ex.finish("cancelled", "stop");
    });
    await new Promise((ok) => setTimeout(ok, 20));
    expect([
      (await getRun(t.base, "chat-err"))?.["status"],
      (await getRun(t.base, "chat-issue"))?.["error_kind"],
    ]).toEqual(["error", "stop"]);
  });
});

describe("branchements", () => {
  it("la boucle, les fournisseurs et les sous-agents voient l'exécution courante ; rien hors portée", async () => {
    brancherExecutions(t.base);
    expect(executionEnCours()).toBeNull();
    let sousAgent: Execution | null = null;
    const e = await runScope(
      "chat",
      { runId: "chat-b", userId: 1, chatId: "c1", sampleSandbox: false },
      async (ex) => {
        executionEnCours()!.ajouterAttente(250);
        executionEnCours()!.ajouterAppelOutil("fs", "success");
        executionEnCours()!.ajouterFichiers([{ path: "x.py" }]);
        executions().ajouterAppelLlm({ prompt_ms: 3 });
        await dansPorteeExecution(
          {
            genre: "subagent",
            userId: 1,
            chatId: "c1#task-1",
            model: "m",
            engine: "builtin",
            parentId: "c1",
          },
          async () => {
            sousAgent = currentRun();
          },
        );
        return ex;
      },
    );
    expect(executionEnCours()).toBeNull();
    expect([e.wait_ms, e.tool_calls, e.filesChanged, e.llm_calls, e.prefill_ms]).toEqual([250, 1, 1, 1, 3]);
    expect([sousAgent!.parent_id, sousAgent!.chat_id, sousAgent!.kind, sousAgent!.engine]).toEqual([
      "chat-b",
      "c1#task-1",
      "subagent",
      "builtin",
    ]);
  });
});
