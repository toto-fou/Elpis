// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/branchements.test.ts — observabilité branchée sur les autres lots : run de routine (exécution + contexte d'usage), usage versé dans l'exécution courante, tour du compresseur, compteurs du process. */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { portCompresseur } from "../../src/contexte/ports";
import { brancherContexte } from "../../src/contexte/branchements";
import type { Evenements } from "../../src/evenements";
import { CycleDeVie } from "../../src/cycle";
import { currentRun, getRun, installerBaseExecutions, runScope } from "../../src/executions/registre";
import { brancherObservabilite } from "../../src/observabilite/branchements";
import { brancherMoteurMetriques } from "../../src/observabilite/demarrage";
import {
  echantillonsDuProcess,
  installerCompteurProcessus,
  sampleOnce,
} from "../../src/observabilite/echantillonneur";
import { currentUsageCtx, recordTurnUsage, usageScope } from "../../src/observabilite/usage-contexte";
import { dansPorteeRoutine } from "../../src/routines/ports";
import { journalMuet } from "../aides";

let t: BaseDeTest;

beforeAll(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  installerBaseExecutions(t.base);
  brancherObservabilite(t.base);
});

afterAll(async () => {
  installerBaseExecutions(null);
  for (const nom of [
    "tachesChat",
    "terminaux",
    "clientsSse",
    "tachesFond",
    "routines",
    "planificateurVivant",
  ] as const)
    installerCompteurProcessus(nom, null);
  await t.fermer();
});

describe("observabilité branchée", () => {
  it("run de routine : exécution « routine » (moteur et statut relus à la fin), contexte d'usage du run", async () => {
    let vu: unknown = null;
    let execution: ReturnType<typeof currentRun> = null;
    await dansPorteeRoutine(
      { source: "webhook", userId: 3, routineId: 7, chatId: "routine:7:run:2", model: "m" },
      async () => {
        vu = currentUsageCtx();
        execution = currentRun();
      },
      async () => ({ statut: "error", moteur: "builtin" }),
    );
    expect(vu).toEqual({ source: "webhook", userId: 3, originId: "routine:7:run:2", parentId: "" });
    const e = execution as unknown as NonNullable<ReturnType<typeof currentRun>>;
    await e.ecrituresTerminees();
    expect(await getRun(t.base, e.id)).toMatchObject({
      kind: "routine",
      user_id: 3,
      routine_id: 7,
      chat_id: "routine:7:run:2",
      model: "m",
      engine: "builtin",
      status: "error",
    });
  });

  it("tour d'usage versé dans l'exécution courante", async () => {
    await runScope("chat", { userId: 2, chatId: "c1" }, async (e) => {
      await recordTurnUsage(t.base, { model: "m", inputTokens: 120, outputTokens: 30 });
      expect([e.input_tokens, e.output_tokens]).toEqual([120, 30]);
    });
  });

  it("tour de chat sous sa portée : l'exécution prend l'issue de son dernier tour LLM (limite d'outils)", async () => {
    let execution: ReturnType<typeof currentRun> = null;
    await runScope("chat", { userId: 2, chatId: "c2" }, (e) => {
      execution = e;
      return usageScope("chat", { userId: 2, originId: "c2" }, () =>
        recordTurnUsage(t.base, { model: "m", inputTokens: 10, outputTokens: 5, status: "tool_limit" }),
      );
    });
    const e = execution as unknown as NonNullable<ReturnType<typeof currentRun>>;
    await e.ecrituresTerminees();
    expect(await getRun(t.base, e.id)).toMatchObject({ kind: "chat", user_id: 2, status: "tool_limit" });
  });

  it("compresseur (endpoint dédié) : un tour compté en « compression »", async () => {
    brancherContexte(t.base);
    portCompresseur().recordTurnUsage(
      { prompt_tokens: 900, completion_tokens: 80 },
      { model: "ext", path: "compression", durationMs: 1200, iterations: 1 },
    );
    for (let i = 0; i < 100 && !(await t.base.get("SELECT 1 FROM usage_events WHERE model='ext'")); i++)
      await new Promise((r) => setTimeout(r, 20));
    const [ligne] = await t.base.all(
      "SELECT source, model, path, input_tokens, output_tokens, duration_ms FROM usage_events WHERE model='ext'",
    );
    expect(ligne).toEqual({
      source: "compression",
      model: "ext",
      path: "compression",
      input_tokens: 900,
      output_tokens: 80,
      duration_ms: 1200,
    });
  });

  it("compteurs du process : tours de chat, terminaux, runs de routine, planificateur (absent → 0)", async () => {
    const evenements = {
      systemEvents: { nombreClients: 0 },
      pipelineEvents: { nombreClients: 0 },
    } as unknown as Evenements;
    brancherMoteurMetriques({
      mode: "main",
      base: t.base,
      cycle: new CycleDeVie(journalMuet),
      evenements,
      journal: journalMuet,
    });
    const collectees = await sampleOnce(t.base, echantillonsDuProcess(null), 1);
    expect(collectees).toMatchObject({
      proc_active_chat_tasks: 0,
      proc_pty_terminals: 0,
      proc_routine_tasks: 0,
      proc_scheduler_alive: 0,
    });
  });
});
