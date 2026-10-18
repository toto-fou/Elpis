// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/fournisseurs/base.ts — contrat d'un widget du tableau de bord et requêtes communes : fenêtre, compteurs, moyennes, percentiles, tailles (shared_infra/observability/metrics/engine.py). */
import { lstatSync, opendirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
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
  tailleDossier(chemin: string): number;
}

export interface ContexteMetriques {
  readonly base: Executeur;
  readonly systeme: SystemeMetriques;
  /** Historique du moniteur de fond (10 min) du process qui sert le tableau de bord. */
  readonly historique: () => readonly PointSysteme[];
  /** `get_llm_health_sync` du serveur d'inférence intégré. */
  readonly santeLlm: () => Promise<Dict>;
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

/** `_percentile_metric` : valeur de rang `floor(n × p / 100)` des valeurs triées, arrondie à 0,01 ; 0 sans donnée. */
export async function percentileMetric(
  x: Executeur,
  eventType: string,
  hours: number,
  percentile: number,
  positiveOnly = true,
): Promise<number | FlottantPy> {
  let q = "SELECT value FROM metric_events WHERE event_type=? AND created_at>?";
  if (positiveOnly) q += " AND value>0";
  q += " ORDER BY value";
  const rows = await x.valeurs(q, [eventType, maintenant() - hours * 3600]);
  if (!rows.length) return 0;
  const n = rows.length;
  const idx = Math.max(0, Math.min(n - 1, Math.trunc((n * percentile) / 100)));
  const val = rows[idx]?.[0];
  return typeof val === "number" ? flt(arrondiPy(val, 2)) : 0;
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

/** `_dir_size_bytes` : parcours comme `os.walk` (ordre du répertoire, liens vers des dossiers ni suivis ni comptés), arrêt après 32 000 fichiers. */
export function dirSizeBytes(racine: string): number {
  let total = 0;
  let vus = 0;
  const parcourir = (dossier: string): boolean => {
    const entrees: Dirent[] = [];
    try {
      const d = opendirSync(dossier);
      try {
        for (let e = d.readSync(); e !== null; e = d.readSync()) entrees.push(e);
      } finally {
        d.closeSync();
      }
    } catch {
      return true;
    }
    const sousDossiers: string[] = [];
    const fichiers: string[] = [];
    for (const e of entrees) {
      const p = path.join(dossier, e.name);
      let estDossier = e.isDirectory();
      if (!estDossier && e.isSymbolicLink()) {
        try {
          estDossier = statSync(p).isDirectory();
        } catch {
          estDossier = false;
        }
      }
      if (!estDossier) fichiers.push(p);
      else if (!e.isSymbolicLink()) sousDossiers.push(p);
    }
    for (const f of fichiers) {
      vus += 1;
      if (vus > 32000) return false;
      try {
        total += lstatSync(f).size;
      } catch {
        continue;
      }
    }
    for (const d of sousDossiers) if (!parcourir(d)) return false;
    return true;
  };
  parcourir(racine);
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
