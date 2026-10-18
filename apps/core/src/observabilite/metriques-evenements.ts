// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/metriques-evenements.ts — table `metric_events` : écriture best-effort d'un événement, compte rattaché par son nom, purge de rétention (shared_infra/db/_connection.py). */
import { intPy, pyJsonDumps, veritePy } from "@elpis/commun";
import type { Executeur } from "@elpis/db";

import { journal } from "../journal";

const log = journal("metrics");

const MAX_NOMS_EN_CACHE = 512;
const uidParNom = new Map<string, number | null>();

/** `_uid_for_username` : nom → id, cache borné ; une base indisponible n'est jamais mise en cache. */
export async function uidPourNomMetrique(x: Executeur, nom: unknown): Promise<number | null> {
  if (!nom || typeof nom !== "string") return null;
  if (uidParNom.has(nom)) return uidParNom.get(nom) ?? null;
  let uid: number | null;
  try {
    const ligne = await x.get<{ id: unknown }>("SELECT id FROM users WHERE username=?", [nom]);
    uid = ligne ? intPy(ligne.id) : null;
  } catch {
    return null;
  }
  if (uidParNom.size > MAX_NOMS_EN_CACHE) uidParNom.clear();
  uidParNom.set(nom, uid);
  return uid;
}

/** Tests : oublie les noms résolus (une autre base). */
export function viderCacheNomsMetriques(): void {
  uidParNom.clear();
}

function tagUtilisateur(tags: Record<string, unknown> | null | undefined): unknown {
  return tags && Object.hasOwn(tags, "user") ? tags["user"] : null;
}

/** `log_metric` : une ligne `metric_events` (tags en JSON ASCII, compte d'après `tags.user`) ; une erreur est journalisée, jamais levée. */
export async function logMetric(
  x: Executeur,
  eventType: string,
  value: number = 1.0,
  tags: Record<string, unknown> | null = null,
  userId: number | null = null,
): Promise<void> {
  try {
    const uid = userId ?? (await uidPourNomMetrique(x, tagUtilisateur(tags)));
    await x.run(
      "INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES(?,?,?,?,?)",
      [eventType, Number(value), pyJsonDumps(veritePy(tags) ? tags : {}), Date.now() / 1000, uid],
    );
  } catch (e) {
    log.error(`Metric Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `purge_old_metrics` : supprime les événements de plus de `retentionDays` jours ; rend le nombre de lignes (lève comme Python). */
export async function purgeOldMetrics(x: Executeur, retentionDays = 90): Promise<number> {
  const cutoff = Date.now() / 1000 - retentionDays * 86400;
  const r = await x.run("DELETE FROM metric_events WHERE created_at < ?", [cutoff]);
  const count = r.changes || 0;
  if (count) log.info(`[startup] ${count} metric_events purgé(s) (>${retentionDays}j).`);
  return count;
}
