// SPDX-License-Identifier: MIT
/** apps/core/src/ops/entretien.ts — passe d'entretien quotidienne de main (purges, balayages, checkpoint WAL, digest), boucle de fond résiliente (shared_infra/ops/maintenance.py). */
import { setTimeout as attendre } from "node:timers/promises";

import { intPy, reprPy, veritePy } from "@elpis/commun";
import { config, liveConfigValue } from "@elpis/config";
import { walCheckpoint } from "@elpis/db";
import type { Base } from "@elpis/db";

import { logMetric } from "../boucle/ports";
import type { CycleDeVie } from "../cycle";
import { markLostRuns, purgeRuns } from "../executions/registre";
import type { Journal } from "../journal";
import { sweep as balayerJournauxRuns } from "../tour/journal-run";

export const TICK_SECONDS = 1800;

/** Purges et balayages portés par d'autres lots (métriques, usage, routines, mémoire, bureau, toolhost, images, digest). */
export type NomPurge =
  | "metric_events"
  | "usage_events"
  | "tool_call_metrics"
  | "routine_runs"
  | "webhook_deliveries"
  | "daily_reports"
  | "session_messages"
  | "action_cache"
  | "stale_locks"
  | "orphan_parts"
  | "office_cache"
  | "generated_images";

/** Une purge reçoit la rétention (jours) quand le Python lui en passe une. */
export type Purge = (retentionJours: number) => number | Promise<number>;

const purges = new Map<NomPurge, Purge>();
let digest: (() => unknown) | null = null;

/** `purge_session_messages` (memory/store.py) : messages de session au-delà de la rétention (`<= 0` : rien), miroir plein texte nettoyé par la base ; ne lève jamais. */
export async function purgeSessionMessages(
  base: Base,
  retentionJours = 180,
  journal?: Journal,
): Promise<number> {
  if (retentionJours <= 0) return 0;
  try {
    const n = (
      await base.run("DELETE FROM session_messages WHERE ts < ?", [
        Date.now() / 1000 - retentionJours * 86400,
      ])
    ).changes;
    if (n) journal?.info(`[maintenance] ${n} session_messages purgé(s) (>${retentionJours}j).`);
    return n;
  } catch (e) {
    journal?.debug({ err: e }, "[maintenance] purge_session_messages failed (non-fatal)");
    return 0;
  }
}

/** Inscrit (ou retire avec `null`) une purge ; absente, la passe la saute comme l'`except` correspondant du Python. */
export function inscrirePurge(nom: NomPurge, f: Purge | null): void {
  if (f === null) purges.delete(nom);
  else purges.set(nom, f);
}

/** `generate_and_store_daily_digest` (B1-32) ; absent, le digest est sauté comme un module introuvable. */
export function inscrireDigest(f: (() => unknown) | null): void {
  digest = f;
}

export interface OptionsEntretien {
  readonly journal?: Journal;
  /** Faux sous les tests : balayages des dossiers partagés sautés (`"pytest" in sys.modules`). */
  readonly balayagesFs?: boolean;
}

/** `run_maintenance_once` : purges dans l'ordre du Python, WAL compacté en dernier, trace `maintenance_pass` ; rend les nombres par table. */
export async function runMaintenanceOnce(
  base: Base,
  options: OptionsEntretien = {},
): Promise<Record<string, number>> {
  const journal = options.journal;
  const out: Record<string, number> = {
    metric_events: 0,
    usage_events: 0,
    runs: 0,
    tool_call_metrics: 0,
    routine_runs: 0,
    daily_reports: 0,
    webhook_deliveries: 0,
    session_messages: 0,
  };
  const tenter = async (nom: NomPurge, cle: string, retention: number): Promise<void> => {
    const f = purges.get(nom);
    if (!f) return;
    try {
      out[cle] = intPy(await f(retention));
    } catch (e) {
      journal?.debug({ err: e }, `[maintenance] ${nom} failed`);
    }
  };
  if (config.METRICS_RETENTION_DAYS > 0)
    await tenter("metric_events", "metric_events", config.METRICS_RETENTION_DAYS);
  const usage = purges.get("usage_events");
  if (usage) out["usage_events"] = intPy(await usage(config.USAGE_EVENTS_RETENTION_DAYS));
  out["runs"] = await purgeRuns(base, config.USAGE_EVENTS_RETENTION_DAYS);
  out["runs_lost"] = await markLostRuns(base);
  await tenter("tool_call_metrics", "tool_call_metrics", config.TOOL_METRICS_RETENTION_DAYS);
  await tenter("routine_runs", "routine_runs", config.ROUTINE_RUNS_RETENTION_DAYS);
  await tenter("webhook_deliveries", "webhook_deliveries", 0);
  await tenter("daily_reports", "daily_reports", config.DAILY_REPORT_RETENTION_DAYS);
  await tenter("session_messages", "session_messages", config.SESSION_MESSAGES_RETENTION_DAYS);
  await tenter("action_cache", "action_cache", 0);
  if (options.balayagesFs ?? true) {
    await tenter("stale_locks", "stale_locks", 0);
    await tenter("orphan_parts", "orphan_parts", 0);
    try {
      out["run_journals"] = balayerJournauxRuns();
    } catch (e) {
      journal?.debug({ err: e }, "[maintenance] run_journal.sweep failed");
    }
    await tenter("office_cache", "office_cache", 0);
    await tenter("generated_images", "generated_images", 0);
  }
  try {
    await walCheckpoint(base);
  } catch (e) {
    journal?.debug({ err: e }, "[maintenance] wal_checkpoint failed");
  }
  logMetric("maintenance_pass", 1, { ...out });
  journal?.info(`[maintenance] passe quotidienne : ${reprPy(out)}`);
  return out;
}

/** `_maybe_run_daily_digest` : `maintenance.daily_digest_enabled` relu sur disque (vrai par défaut), jamais d'exception. */
export async function maybeRunDailyDigest(journal?: Journal): Promise<void> {
  const section = liveConfigValue("maintenance", {});
  const actif =
    section !== null && typeof section === "object" && !Array.isArray(section)
      ? veritePy(
          Object.hasOwn(section, "daily_digest_enabled")
            ? (section as Record<string, unknown>)["daily_digest_enabled"]
            : true,
        )
      : true;
  if (!actif || digest === null) return;
  try {
    await digest();
  } catch (e) {
    journal?.warn(
      `[maintenance] digest quotidien non généré : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function jourLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DependancesBoucleEntretien {
  readonly base: Base;
  readonly journal: Journal;
  readonly arret: AbortSignal;
  /** Élection du process qui entretient (`try_acquire_cron_lock`) ; défaut : ce process (un seul main). */
  readonly leader?: () => boolean | Promise<boolean>;
  readonly tickMs?: number;
  readonly maintenant?: () => Date;
}

/** `_maintenance_loop` : un tour toutes les 30 min, une passe par jour à partir de `MAINTENANCE_HOUR`, sortie à l'arrêt du process. */
export async function boucleEntretien(dep: DependancesBoucleEntretien): Promise<void> {
  let dernierJour: string | null = null;
  for (;;) {
    try {
      await attendre(dep.tickMs ?? TICK_SECONDS * 1000, undefined, { signal: dep.arret });
    } catch {
      return;
    }
    try {
      if (dep.leader && !(await dep.leader())) continue;
      const maintenant = dep.maintenant ? dep.maintenant() : new Date();
      const jour = jourLocal(maintenant);
      if (dernierJour === jour || maintenant.getHours() < config.MAINTENANCE_HOUR) continue;
      dernierJour = jour;
      await runMaintenanceOnce(dep.base, { journal: dep.journal });
      await maybeRunDailyDigest(dep.journal);
    } catch (e) {
      dep.journal.warn(`[maintenance] erreur de boucle : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** `start_maintenance_scheduler` : boucle de fond de main, arrêtée avec le process. */
export function demarrerEntretien(
  cycle: CycleDeVie,
  base: Base,
  journal: Journal,
  leader?: () => boolean | Promise<boolean>,
): void {
  cycle.auDemarrage(
    "entretien quotidien",
    () => {
      journal.info(
        `[maintenance] scheduler d'entretien démarré (heure quotidienne=${config.MAINTENANCE_HOUR}h).`,
      );
      return boucleEntretien({ base, journal, arret: cycle.signalArret, ...(leader ? { leader } : {}) });
    },
    { modes: ["main"], arrierePlan: true },
  );
}
