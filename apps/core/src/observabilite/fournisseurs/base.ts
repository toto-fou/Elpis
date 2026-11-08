// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/fournisseurs/base.ts — contrat d'un widget du tableau de bord et requêtes communes : fenêtre, compteurs, moyennes, percentiles, tailles (shared_infra/observability/metrics/engine.py). */
import { statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, opendir, stat } from "node:fs/promises";
import path from "node:path";

import { arrondiPy, estErreurPython, FlottantPy, intPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { jsonGet } from "@elpis/db";
import type { Executeur } from "@elpis/db";

import type { PointSysteme } from "../moniteur";
import type { FrequenceCpu, MemoireVirtuelle, UsageDisque } from "../sondes";

/** Mesures du système lues par les widgets « ressources » (sondes /proc par défaut, figées dans les tests). */
export interface SystemeMetriques {
  virtualMemory(): MemoireVirtuelle;
  diskUsage(chemin: string): UsageDisque;
  cpuCountLogical(): number | null;
  cpuCountCores(): number | null;
  cpuFreq(): FrequenceCpu | null;
  /** Date de création du process (`Process.create_time()`). */
  createTime(): number;
  /** `_db_size_bytes` : base SQLite et ses fichiers -wal/-shm. */
  tailleBase(): number;
  /** `_dir_size_bytes` d'un dossier (chemin relatif au répertoire courant du process). */
  tailleDossier(chemin: string): Promise<number>;
}

export interface ContexteMetriques {
  readonly base: Executeur;
  readonly systeme: SystemeMetriques;
  /** Historique du moniteur de fond (10 min) du process qui sert le tableau de bord. */
  readonly historique: () => readonly PointSysteme[];
  /** `get_llm_health_sync` du serveur d'inférence intégré. */
  readonly santeLlm: () => Promise<Dict>;
  /** Résultats gardés quelques secondes par widget et période (contexte du process ; absent = toujours recalculés). */
  readonly garderResultats?: boolean;
}

export interface Fournisseur {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly width: string;
  readonly icon: string;
  readonly color: string;
  readonly category: string;
  readonly eventTypes: readonly string[];
  readonly purgeSpec: Dict | null;
  /** Durée de vie d'un résultat gardé, en ms ; absente = selon la période (20, 30 ou 60 s). */
  readonly ttlMs?: number;
  /** Vrai si le résultat ne dépend pas de la période : un seul résultat gardé pour toutes les périodes. */
  readonly sansPeriode?: boolean;
  getData(ctx: ContexteMetriques, scopeHours?: unknown): Promise<Dict>;
}

export interface DefinitionFournisseur {
  id: string;
  title: string;
  type: string;
  width?: string;
  icon?: string;
  color?: string;
  category?: string;
  eventTypes?: readonly string[];
  purgeSpec?: Dict | null;
  ttlMs?: number;
  sansPeriode?: boolean;
  getData(ctx: ContexteMetriques, scopeHours?: unknown): Promise<Dict>;
}

/** Valeurs par défaut de `MetricProvider` : demi-largeur, catégorie générale, purge par les types d'événements suivis. */
export function fournisseur(d: DefinitionFournisseur): Fournisseur {
  const eventTypes = d.eventTypes ?? [];
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    width: d.width ?? "1/2",
    icon: d.icon ?? "ph-chart-bar",
    color: d.color ?? "blue",
    category: d.category ?? "general",
    eventTypes,
    purgeSpec:
      d.purgeSpec !== undefined
        ? d.purgeSpec
        : eventTypes.length
          ? { target: "metric_events", event_types: [...eventTypes] }
          : null,
    ...(d.ttlMs !== undefined ? { ttlMs: d.ttlMs } : {}),
    ...(d.sansPeriode ? { sansPeriode: true } : {}),
    getData: d.getData,
  };
}

export const SCOPE_HOURS_CHOICES = [24, 168, 720] as const;

/** `int(v)` ou le défaut si la valeur est illisible. */
export function entierOu(v: unknown, defaut: number): number {
  try {
    return intPy(v);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return defaut;
    throw e;
  }
}

/** `_scope_hours` : 24, 168 ou 720 ; toute autre fenêtre retombe sur 24 h. */
export function scopeHours(override: unknown = null): number {
  const h = override === null || override === undefined ? 24 : entierOu(override, Number.NaN);
  return (SCOPE_HOURS_CHOICES as readonly number[]).includes(h) ? h : 24;
}

export function scopeLabel(hours: number): string {
  const libelles: Record<number, string> = { 24: "24 h", 168: "7 j", 720: "30 j" };
  return libelles[hours] ?? `${hours} h`;
}

export function flt(x: number): FlottantPy {
  return new FlottantPy(x);
}

export function maintenant(): number {
  return Date.now() / 1000;
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

/** `_count_metric` : événements d'un type sur la fenêtre. */
export async function countMetric(x: Executeur, eventType: string, hours = 24): Promise<number> {
  const [r] = await x.valeurs("SELECT COUNT(*) FROM metric_events WHERE event_type=? AND created_at>?", [
    eventType,
    maintenant() - hours * 3600,
  ]);
  return r ? entier(r[0]) : 0;
}

/** `_avg_metric` : moyenne arrondie à 0,1 (flottant), 0 entier sans événement. */
export async function avgMetric(
  x: Executeur,
  eventType: string,
  hours = 24,
  positiveOnly = true,
): Promise<number | FlottantPy> {
  let q = "SELECT AVG(value) FROM metric_events WHERE event_type=? AND created_at>?";
  if (positiveOnly) q += " AND value>0";
  const [r] = await x.valeurs(q, [eventType, maintenant() - hours * 3600]);
  const v = r?.[0];
  return v === null || v === undefined ? 0 : flt(arrondiPy(Number(v), 1));
}

const BRUT_SQLITE = "CAST((SELECT n FROM c) * ? / 100.0 AS INTEGER)";
const RANG_SQLITE = `(CASE WHEN ${BRUT_SQLITE} > (SELECT n FROM c) - 1 THEN (SELECT n FROM c) - 1 ELSE ${BRUT_SQLITE} END)`;

/** Valeurs de rang `floor(n × p / 100)` des valeurs triées, arrondies à 0,01 (0 sans donnée) : le tri reste dans la base, seules les lignes visées remontent. */
export async function percentilesMetric(
  x: Executeur,
  eventType: string,
  hours: number,
  percentiles: readonly number[],
  positiveOnly = true,
): Promise<(number | FlottantPy)[]> {
  const filtre = "event_type=? AND created_at>?" + (positiveOnly ? " AND value>0" : "");
  const params = [eventType, maintenant() - hours * 3600];
  const lignes =
    x.dialecte === "postgres"
      ? await x.valeurs(
          `WITH c AS (SELECT COUNT(*) AS n FROM metric_events WHERE ${filtre}), ` +
            `r AS (SELECT CASE WHEN FLOOR(c.n * v.p / 100.0) > c.n - 1 THEN c.n - 1 ELSE FLOOR(c.n * v.p / 100.0) END AS k ` +
            `FROM (${percentiles.map((_, i) => (i === 0 ? "SELECT CAST(? AS INTEGER) AS p" : "SELECT CAST(? AS INTEGER)")).join(" UNION ALL ")}) v CROSS JOIN c) ` +
            "SELECT t.rn, t.value, c.n FROM (SELECT value, ROW_NUMBER() OVER (ORDER BY value) - 1 AS rn " +
            `FROM metric_events WHERE ${filtre}) t JOIN r ON t.rn = r.k CROSS JOIN c`,
          [...params, ...percentiles, ...params],
        )
      : await x.valeurs(
          `WITH c AS (SELECT COUNT(*) AS n FROM metric_events WHERE ${filtre}) ` +
            "SELECT rn, value, (SELECT n FROM c) FROM (SELECT value, ROW_NUMBER() OVER (ORDER BY value) - 1 AS rn " +
            `FROM metric_events WHERE ${filtre}) t WHERE rn IN (${percentiles.map(() => RANG_SQLITE).join(",")})`,
          [...params, ...params, ...percentiles.flatMap((p) => [p, p])],
        );
  const n = lignes[0] ? entier(lignes[0][2]) : 0;
  if (n <= 0) return percentiles.map(() => 0);
  const rangs = percentiles.map((p) => Math.max(0, Math.min(n - 1, Math.trunc((n * p) / 100))));
  const parRang = new Map(lignes.map((l) => [Number(l[0]), l[1]]));
  return rangs.map((r) => {
    const v = parRang.get(r);
    return typeof v === "number" ? flt(arrondiPy(v, 2)) : 0;
  });
}

/** `_percentile_metric` : un seul percentile (voir `percentilesMetric`). */
export async function percentileMetric(
  x: Executeur,
  eventType: string,
  hours: number,
  percentile: number,
  positiveOnly = true,
): Promise<number | FlottantPy> {
  const [v] = await percentilesMetric(x, eventType, hours, [percentile], positiveOnly);
  return v ?? 0;
}

/** `_distinct_users` : comptes distincts (tag `user`) ayant envoyé un message sur la fenêtre. */
export async function distinctUsers(x: Executeur, hours: number): Promise<number> {
  const user = jsonGet("tags_json", "user", x.dialecte);
  const [r] = await x.valeurs(
    `SELECT COUNT(DISTINCT ${user}) FROM metric_events WHERE event_type='message_sent' AND created_at>? ` +
      `  AND ${user} IS NOT NULL   AND ${user} != ''`,
    [maintenant() - hours * 3600],
  );
  return r ? entier(r[0]) : 0;
}

/** `_db_size_bytes` : fichier SQLite et ses fichiers -wal et -shm ; 0 si illisible. */
export function dbSizeBytes(chemin: string): number {
  try {
    let total = 0;
    for (const suffixe of ["", "-wal", "-shm"]) {
      try {
        total += statSync(chemin + suffixe).size;
      } catch (e) {
        if ((e as { code?: unknown }).code !== "ENOENT") throw e;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** `_dir_size_bytes` : parcours comme `os.walk` (liens vers des dossiers ni suivis ni comptés), arrêt dès 32 000 entrées lues (dossiers compris), 4 000 dossiers ouverts ou 1 s de parcours, la valeur partielle est alors rendue ; E/S asynchrones par lots, la boucle n'est jamais gelée. */
export async function dirSizeBytes(racine: string): Promise<number> {
  const PLAFOND = 32000;
  const MAX_DOSSIERS = 4000;
  const BUDGET_MS = 1000;
  const limite = performance.now() + BUDGET_MS;
  let total = 0;
  let vus = 0;
  let ouverts = 0;
  const parcourir = async (dossier: string): Promise<boolean> => {
    const entrees: Dirent[] = [];
    let plein = false;
    if (++ouverts > MAX_DOSSIERS || performance.now() > limite) return false;
    try {
      for await (const e of await opendir(dossier, { bufferSize: 1024 })) {
        entrees.push(e);
        if (++vus >= PLAFOND) {
          plein = true;
          break;
        }
      }
    } catch {
      // dossier illisible : on garde ce qui a été lu
    }
    const sousDossiers: string[] = [];
    const fichiers: string[] = [];
    for (const e of entrees) {
      const p = path.join(dossier, e.name);
      let estDossier = e.isDirectory();
      if (!estDossier && e.isSymbolicLink())
        estDossier = await stat(p).then(
          (x) => x.isDirectory(),
          () => false,
        );
      if (!estDossier) fichiers.push(p);
      else if (!e.isSymbolicLink()) sousDossiers.push(p);
    }
    for (let i = 0; i < fichiers.length; i += 64) {
      const tailles = await Promise.all(
        fichiers.slice(i, i + 64).map((f) =>
          lstat(f).then(
            (x) => x.size,
            () => 0,
          ),
        ),
      );
      for (const t of tailles) total += t;
    }
    if (plein) return false;
    for (const d of sousDossiers) if (!(await parcourir(d))) return false;
    return true;
  };
  await parcourir(racine);
  return total;
}

/** `_fill_state` : remplissage d'une ressource → état affiché (`null` = normal). */
export function fillState(percent: number): string | null {
  if (percent >= 90) return "danger";
  if (percent >= 80) return "warn";
  return null;
}

/** Texte tronqué à 16 points de code suivis de « … » au-delà de 18. */
export function nomCourt(nom: string): string {
  const points = Array.from(nom);
  return points.length > 18 ? points.slice(0, 16).join("") + "…" : nom;
}
