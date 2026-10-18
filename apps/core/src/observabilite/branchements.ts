// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/branchements.ts — ports posés au démarrage : registre et contexte d'usage de la boucle, métriques d'événements et d'appels d'outils, portées d'un sous-agent et d'un run de routine, usage versé dans l'exécution courante. */
import type { Executeur } from "@elpis/db";

import {
  installerContexteUsage,
  installerMetriquesBoucle,
  installerMetriquesOutils,
  installerPorteeExecution,
  installerRegistreUsage,
} from "../boucle/ports";
import type { PorteeExecution, UsageTour } from "../boucle/ports";
import { currentRun, runScope } from "../executions/registre";
import { installerPorteeRoutine } from "../routines/ports";
import type { IssueRoutine, PorteeRoutine } from "../routines/ports";
import { logMetric } from "./metriques-evenements";
import { enregistrerAppelOutil } from "./outils-metriques";
import { currentUsageCtx, installerExecutionUsage, recordTurnUsage, usageScope } from "./usage-contexte";
import type { TourUsage } from "./usage-contexte";

/** `run_scope` des exécutions autour d'un sous-agent (registre du process par défaut) ; `null`, seule la portée d'usage s'applique. */
export type PorteeRun = <T>(p: PorteeExecution, fn: () => Promise<T>) => Promise<T>;

/** `run_scope(genre…)` du registre des exécutions, comme le posait B1-20b avant l'usage. */
const porteeRunDuProcess: PorteeRun = (p, fn) =>
  runScope(p.genre, { userId: p.userId, chatId: p.chatId, model: p.model, engine: p.engine }, () => fn());

let porteeRun: PorteeRun | null = porteeRunDuProcess;

export function installerPorteeRun(f: PorteeRun | null): void {
  porteeRun = f;
}

/** Source d'usage d'un genre d'exécution : la compaction se compte en « compression », comme en Python. */
const SOURCE_DU_GENRE: Readonly<Record<string, string>> = { compaction: "compression" };

/** `run_scope(genre…)` puis `usage_scope(source, user_id, origin_id=chat, parent_id)` autour de `fn`. */
export function dansPortee<T>(p: PorteeExecution, fn: () => Promise<T>): Promise<T> {
  const source = Object.hasOwn(SOURCE_DU_GENRE, p.genre) ? (SOURCE_DU_GENRE[p.genre] as string) : p.genre;
  const usage = (): Promise<T> =>
    usageScope(source, { userId: p.userId, originId: p.chatId, parentId: p.parentId ?? "" }, fn);
  return porteeRun ? porteeRun(p, usage) : usage();
}

/** `_execute_routine_run_mesure` : `run_scope("routine"…)`, `set_usage_context(source, user_id, origin_id=clé du run)` dans le run, puis moteur visé et statut final relus. */
export function dansPorteeRoutine(
  p: PorteeRoutine,
  fn: () => Promise<void>,
  issue: () => Promise<IssueRoutine>,
): Promise<void> {
  return runScope(
    "routine",
    { userId: p.userId, routineId: p.routineId, chatId: p.chatId, model: p.model },
    async (e) => {
      await usageScope(p.source, { userId: p.userId, originId: p.chatId, inheritUser: false }, fn);
      const fin = await issue();
      e.engine = fin.moteur;
      if (fin.statut) e.finish(fin.statut);
    },
  );
}

/** `current_run()` vu par le registre d'usage : chaque tour est versé dans l'exécution courante. */
function executionPourUsage() {
  const e = currentRun();
  return e === null
    ? null
    : { id: e.id, ajouterUsage: (u: Parameters<typeof e.addUsage>[0]) => e.addUsage(u) };
}

/** Un tour de la boucle : sa portée (`title`, `compression`…) s'ouvre autour de l'enregistrement, contexte courant hérité. */
export function enregistrerTour(x: Executeur, u: UsageTour): Promise<boolean> {
  const tour: TourUsage = {
    usage: u.usage,
    model: u.model,
    path: u.path,
    durationMs: u.durationMs,
    iterations: u.iterations,
    status: u.status,
    errorKind: u.errorKind ?? "",
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    submittedTokens: u.submittedTokens,
    thinkingTokens: u.thinkingTokens,
  };
  return u.scope ? usageScope(u.scope, {}, () => recordTurnUsage(x, tour)) : recordTurnUsage(x, tour);
}

/** Pose les ports de la boucle sur la base du process. */
export function brancherObservabilite(x: Executeur): void {
  installerRegistreUsage((u) => enregistrerTour(x, u));
  installerContexteUsage({ utilisateurCourant: () => currentUsageCtx().userId });
  installerMetriquesBoucle((type, valeur, tags, userId) => logMetric(x, type, valeur, tags, userId));
  installerMetriquesOutils((ligne) => enregistrerAppelOutil(x, ligne));
  installerPorteeExecution(dansPortee);
  installerExecutionUsage(executionPourUsage);
  installerPorteeRoutine(dansPorteeRoutine);
}
