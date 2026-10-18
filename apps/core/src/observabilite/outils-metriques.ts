// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/outils-metriques.ts — table `tool_call_metrics` : une ligne par appel d'outil, best-effort, purge de rétention (shared_infra/observability/tool_metrics_store.py). */
import { floatPy, intPy, prefixePy, strPy, veritePy } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { getUser } from "@elpis/auth";

import type { LigneMetriqueOutil } from "../boucle/ports";
import { journal } from "../journal";

const log = journal("tool_call_metrics");

export interface AppelOutil {
  runId: string;
  userId: number;
  toolName: string;
  pipelineId?: number | null;
  nodeId?: unknown;
  memberId?: string | null;
  serverName?: string | null;
  status?: string;
  durationMs?: number;
  errorShort?: string | null;
  callId?: unknown;
  startedAt?: number | null;
  category?: string | null;
  exitCode?: number | null;
  argsBytes?: number | null;
  resultBytes?: number | null;
}

function present<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

/** `record_tool_call_metric` : erreur courte bornée à 500, identifiant d'appel à 128, famille à 64 ; jamais d'exception. */
export async function recordToolCallMetric(x: Executeur, a: AppelOutil): Promise<void> {
  try {
    await x.run(
      "INSERT INTO tool_call_metrics(run_id, user_id, pipeline_id, node_id, member_id, " +
        "tool_name, server_name, status, duration_ms, error_short, ts, " +
        "call_id, started_at, category, exit_code, args_bytes, result_bytes) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        a.runId,
        intPy(a.userId),
        a.pipelineId ?? null,
        present(a.nodeId) ? strPy(a.nodeId) : null,
        a.memberId ?? null,
        a.toolName,
        a.serverName ?? null,
        a.status ?? "success",
        intPy(veritePy(a.durationMs) ? a.durationMs : 0),
        a.errorShort ? prefixePy(a.errorShort, 500) : null,
        Date.now() / 1000,
        veritePy(a.callId) ? prefixePy(strPy(a.callId), 128) : null,
        present(a.startedAt) ? floatPy(a.startedAt) : null,
        a.category ? prefixePy(strPy(a.category), 64) : null,
        present(a.exitCode) ? intPy(a.exitCode) : null,
        present(a.argsBytes) ? intPy(a.argsBytes) : null,
        present(a.resultBytes) ? intPy(a.resultBytes) : null,
      ],
    );
  } catch (e) {
    log.debug({ err: e }, "[tool_call_metrics] write failed (non-fatal)");
  }
}

/** `purge_tool_call_metrics` : rétention de la maintenance, `<= 0` désactive ; ne lève jamais. */
export async function purgeToolCallMetrics(x: Executeur, retentionDays = 90): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    const r = await x.run("DELETE FROM tool_call_metrics WHERE ts < ?", [
      Date.now() / 1000 - retentionDays * 86400,
    ]);
    const count = r.changes || 0;
    if (count) log.info(`[maintenance] ${count} tool_call_metrics purgé(s) (>${retentionDays}j).`);
    return count;
  } catch (e) {
    log.debug({ err: e }, "[maintenance] purge_tool_call_metrics failed (non-fatal)");
    return 0;
  }
}

const uidParCompte = new Map<string, number>();

/** Tests : oublie les comptes résolus (une autre base). */
export function viderCacheComptesOutils(): void {
  uidParCompte.clear();
}

/** `_record_tool_call_metric_safe` : compte résolu par son nom (cache du process), ligne écrite ; compte inconnu = rien. */
export async function enregistrerAppelOutil(x: Executeur, l: LigneMetriqueOutil): Promise<void> {
  try {
    let uid = uidParCompte.get(l.username);
    if (uid === undefined) {
      const ligne = await getUser(x, l.username);
      if (!ligne) return;
      uid = intPy(ligne.id);
      uidParCompte.set(l.username, uid);
    }
    await recordToolCallMetric(x, {
      runId: l.run_id,
      userId: uid,
      toolName: l.tool_name,
      status: l.status,
      durationMs: Math.trunc(l.duration_ms),
      errorShort: l.error_short,
      category: l.category,
      callId: l.call_id,
      startedAt: l.started_at,
      exitCode: l.exit_code,
      argsBytes: l.args_bytes,
      resultBytes: l.result_bytes,
    });
  } catch (e) {
    log.debug({ err: e }, "[tool_call_metrics] record failed (non-fatal)");
  }
}
