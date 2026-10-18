// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/echantillonneur.ts — échantillon persisté du process toutes les 5 min (une ligne `proc_sample`, dix jauges), lecture des deux formats (shared_infra/observability/metrics/process_sampler.py). */
import { existsSync, statSync } from "node:fs";

import { arrondiPy, FlottantPy } from "@elpis/commun";
import { config } from "@elpis/config";
import { jsonGetParamNum } from "@elpis/db";
import type { Dialecte, Executeur, Valeur } from "@elpis/db";

import { journal } from "../journal";
import { logMetric } from "./metriques-evenements";
import { SondeProcessus } from "./sondes";

const log = journal("metrics");

export const SAMPLE_INTERVAL_SECONDS = 300;
export const PROC_SAMPLE_EVENT = "proc_sample";
const MIO = 1024 * 1024;

/** Compteurs applicatifs du process, posés par les lots qui les tiennent ; absent = jauge omise de l'échantillon. */
export interface CompteursProcessus {
  /** Tâches de chat actives (`_active_chat_tasks`, B1-20b). */
  tachesChat?: () => number;
  /** Terminaux PTY ouverts. */
  terminaux?: () => number;
  /** Clients des flux `system_events` et `pipeline_events`. */
  clientsSse?: () => number;
  /** Tâches de fond suivies par le cycle de vie. */
  tachesFond?: () => number;
  /** Exécutions de routines en cours (B1-24). */
  routines?: () => number;
  /** Planificateur leader et vivant (`scheduler_alive`, B1-24). */
  planificateurVivant?: () => boolean;
}

const compteurs: Record<string, (() => number | boolean) | undefined> = {};

export function installerCompteurProcessus<K extends keyof CompteursProcessus>(
  nom: K,
  f: CompteursProcessus[K] | null,
): void {
  compteurs[nom] = f ?? undefined;
}

function compteur(nom: keyof CompteursProcessus): number {
  const f = compteurs[nom];
  if (f === undefined) throw new Error(`${nom} indisponible`);
  const v = f();
  return typeof v === "boolean" ? (v ? 1.0 : 0.0) : v;
}

/** `_c_sqlite_wal_mb` : taille du fichier -wal en Mo (0 s'il n'existe pas). */
export function walMo(chemin: string = config.DB_PATH): number {
  const wal = `${chemin}-wal`;
  if (!existsSync(wal)) return 0.0;
  return arrondiPy(statSync(wal).size / MIO, 2);
}

export type Echantillons = readonly (readonly [string, () => number])[];

/** `_SAMPLES` : les dix jauges dans l'ordre Python ; un accesseur qui lève est omis de l'échantillon. */
export function echantillonsDuProcess(proc: SondeProcessus | null = new SondeProcessus()): Echantillons {
  const exigerProc = (): SondeProcessus => {
    if (proc === null) throw new Error("psutil indisponible");
    return proc;
  };
  return [
    ["proc_active_chat_tasks", () => compteur("tachesChat")],
    ["proc_pty_terminals", () => compteur("terminaux")],
    ["proc_sse_clients", () => compteur("clientsSse")],
    ["proc_bg_tasks", () => compteur("tachesFond")],
    ["proc_routine_tasks", () => compteur("routines")],
    ["proc_rss_mb", () => arrondiPy(exigerProc().rss() / MIO, 1)],
    ["proc_num_fds", () => exigerProc().numFds()],
    ["proc_num_threads", () => exigerProc().numThreads()],
    ["proc_sqlite_wal_mb", () => walMo()],
    ["proc_scheduler_alive", () => compteur("planificateurVivant")],
  ];
}

/** `sample_once` : toutes les jauges en UNE ligne `proc_sample` taguée par le PID ; rend les valeurs collectées. */
export async function sampleOnce(
  x: Executeur,
  echantillons: Echantillons = echantillonsDuProcess(),
  pid: number = process.pid,
): Promise<Record<string, number>> {
  const collectees: Record<string, number> = {};
  for (const [nom, accesseur] of echantillons) {
    try {
      collectees[nom] = Number(accesseur());
    } catch (e) {
      log.debug(`[PROC_SAMPLER] ${nom} indisponible : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!Object.keys(collectees).length) return collectees;
  const tags: Record<string, unknown> = { pid };
  for (const [nom, v] of Object.entries(collectees)) tags[nom] = new FlottantPy(v);
  await logMetric(x, PROC_SAMPLE_EVENT, 1.0, tags);
  return collectees;
}

/** `gauge_union_sql` : sous-requête `(h, ts, v)` sur l'ancien format (une ligne par jauge) et le format groupé. */
export function gaugeUnionSql(selectExpr: string, d: Dialecte): string {
  return `
        SELECT ${selectExpr} AS h, created_at AS ts, value AS v
          FROM metric_events WHERE event_type=? AND created_at>?
        UNION ALL
        SELECT ${selectExpr} AS h, created_at AS ts,
               ${jsonGetParamNum("tags_json", d)} AS v
          FROM metric_events WHERE event_type='${PROC_SAMPLE_EVENT}' AND created_at>?
    `;
}

export function gaugeUnionParams(gauge: string, since: number): Valeur[] {
  return [gauge, since, gauge, since];
}

/** `last_heartbeat_at` : date du dernier échantillon où la jauge était non nulle, 0.0 si jamais. */
export async function lastHeartbeatAt(x: Executeur, gauge = "proc_scheduler_alive"): Promise<number> {
  const [row] = await x.valeurs(
    `SELECT MAX(ts) FROM (
              SELECT created_at AS ts FROM metric_events
                WHERE event_type=? AND value>0
              UNION ALL
              SELECT created_at AS ts FROM metric_events
                WHERE event_type='${PROC_SAMPLE_EVENT}'
                  AND ${jsonGetParamNum("tags_json", x.dialecte)} > 0
            ) AS t`,
    [gauge, gauge],
  );
  const v = row?.[0];
  return typeof v === "number" && v ? v : 0.0;
}

/** Échantillonneur du process : un échantillon toutes les 5 min, minuterie qui ne retient pas le process. */
export class Echantillonneur {
  private minuterie: NodeJS.Timeout | null = null;
  private readonly x: Executeur;
  private readonly echantillons: Echantillons;
  private readonly suivre: (tache: Promise<unknown>) => void;

  /** `suivre` : l'échantillon en vol est attendu par l'arrêt (tâche de fond du cycle) avant la fermeture de la base. */
  constructor(
    x: Executeur,
    echantillons: Echantillons = echantillonsDuProcess(),
    suivre: (tache: Promise<unknown>) => void = () => undefined,
  ) {
    this.x = x;
    this.echantillons = echantillons;
    this.suivre = suivre;
  }

  get actif(): boolean {
    return this.minuterie !== null;
  }

  demarrer(intervalleMs = SAMPLE_INTERVAL_SECONDS * 1000): void {
    if (this.minuterie !== null) return;
    this.minuterie = setInterval(() => {
      this.suivre(
        sampleOnce(this.x, this.echantillons).catch((e: unknown) =>
          log.warn(`[PROC_SAMPLER] erreur de boucle : ${e instanceof Error ? e.message : String(e)}`),
        ),
      );
    }, intervalleMs);
    this.minuterie.unref();
    log.info(`[PROC_SAMPLER] démarré (intervalle=${Math.round(intervalleMs / 1000)}s, pid=${process.pid})`);
  }

  arreter(): void {
    if (this.minuterie !== null) clearInterval(this.minuterie);
    this.minuterie = null;
  }
}
