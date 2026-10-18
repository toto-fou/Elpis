// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/series.ts — séries temporelles : calendrier explicite des seaux (frise datée, seaux vides à 0), agrégats SQL et rendu Chart.js (shared_infra/observability/metrics/series.py). */
import { arrondiPy, comparePointsDeCode, FlottantPy, intPy, stripPy, strPy } from "@elpis/commun";
import { config } from "@elpis/config";
import { castInt, localStrftime, utcStrftime } from "@elpis/db";
import type { Executeur, Valeur } from "@elpis/db";

import { journal } from "../journal";
import { heureLocale, zoneNommee } from "./fuseau";
import type { Zone } from "./fuseau";

const log = journal("metrics");

export const HOUR = 3600;
export const DAY = 86400;

/** Fuseau d'affichage : zone nommée (`metrics.timezone`) ou décalage fixe du serveur, pris à l'instant de la résolution. */
export interface Fuseau {
  readonly zone: Zone | null;
  readonly decalageFixe: number;
  readonly nom: string;
  readonly serveur: boolean;
}

/** `resolve_tz` : zone nommée valide, sinon le fuseau du serveur (abréviation courante, « local » à défaut). */
export function resolveTz(nom: string = config.METRICS_TIMEZONE): Fuseau {
  const cle = stripPy(nom || "");
  if (cle) {
    try {
      return { zone: zoneNommee(cle), decalageFixe: 0, nom: cle, serveur: false };
    } catch {
      log.warn(`[metrics] fuseau ${JSON.stringify(cle)} inconnu — repli sur le serveur`);
    }
  }
  const ici = heureLocale(Date.now() / 1000);
  return { zone: null, decalageFixe: ici.decalage, nom: ici.abbr || "local", serveur: true };
}

/** Heure murale (secondes « locales » depuis 1970) et repli d'un instant UTC. */
function versMural(f: Fuseau, t: number): [number, 0 | 1] {
  if (f.zone === null) return [t + f.decalageFixe, 0];
  const i = f.zone.versLocal(Math.floor(t));
  return [t + i.decalage, i.fold];
}

/** `datetime.timestamp()` d'une heure murale. */
function versUtc(f: Fuseau, mural: number, fold: 0 | 1): number {
  if (f.zone === null) return mural - f.decalageFixe;
  return mural - f.zone.decalageMural(Math.floor(mural), fold);
}

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

function jour(mural: number): string {
  const d = new Date(Math.floor(mural) * 1000);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${deux(d.getUTCMonth() + 1)}-${deux(d.getUTCDate())}`;
}

function heure(mural: number): string {
  return `${jour(mural)}T${deux(new Date(Math.floor(mural) * 1000).getUTCHours())}:00`;
}

/** `a // b` de Python sur des flottants (algorithme de `float_floor_div`). */
export function divisionEntierePy(a: number, b: number): number {
  const mod = a % b;
  let div = (a - mod) / b;
  if (mod !== 0 && b < 0 !== mod < 0) div -= 1.0;
  if (div === 0) return a / b < 0 || Object.is(a / b, -0) ? -0 : 0;
  let entier = Math.floor(div);
  if (div - entier > 0.5) entier += 1.0;
  return entier;
}

export interface PlanSeaux {
  readonly granularity: "hour" | "day";
  readonly edges: number[];
  readonly keys: (number | string)[];
  readonly labels: string[];
  readonly tzName: string;
  readonly isServerTz: boolean;
  readonly origin: number;
  readonly fuseau: Fuseau;
}

/** `plan_buckets` : tous les seaux de la fenêtre, vides compris ; journalier par jour civil, horaire borné à 31 jours. */
export function planBuckets(
  since: number,
  until: number | null = null,
  granularity: "hour" | "day" = "hour",
  fuseau: Fuseau = resolveTz(),
): PlanSeaux {
  let end = until ?? Date.now() / 1000;
  const start = since;
  if (end <= start) end = start + 1;
  const base = { tzName: fuseau.nom, isServerTz: fuseau.serveur, fuseau };
  if (granularity === "day") {
    const [mural, fold] = versMural(fuseau, start);
    let courant = Math.floor(mural / DAY) * DAY;
    let replis: 0 | 1 = fold;
    const edges: number[] = [];
    const keys: string[] = [];
    for (let ts = versUtc(fuseau, courant, replis); ts < end; ts = versUtc(fuseau, courant, replis)) {
      edges.push(ts);
      keys.push(jour(courant));
      courant = Math.floor((courant + DAY + 2 * HOUR) / DAY) * DAY;
      replis = 0;
    }
    return { ...base, granularity: "day", edges, keys, labels: [...keys], origin: edges[0] ?? start };
  }
  const [mural, fold] = versMural(fuseau, start);
  const origin = versUtc(fuseau, Math.floor(mural / HOUR) * HOUR, fold);
  let n = Math.max(1, Math.trunc(divisionEntierePy(end - origin, HOUR)) + 1);
  n = Math.min(n, 24 * 31);
  const edges = Array.from({ length: n }, (_v, i) => origin + i * HOUR);
  return {
    ...base,
    granularity: "hour",
    edges,
    keys: edges.map((_e, i) => i),
    labels: edges.map((e) => heure(versMural(fuseau, e)[0])),
    origin,
  };
}

/** `_bucket_expr` : clé de seau SQL et ses paramètres. */
function expressionSeau(plan: PlanSeaux, tsCol: string, x: Executeur): [string, Valeur[]] {
  if (plan.granularity === "day") {
    if (plan.isServerTz) return [localStrftime("%Y-%m-%d", tsCol, x.dialecte), []];
    const off = plan.fuseau.zone ? plan.fuseau.zone.versLocal(Math.floor(Date.now() / 1000)).decalage : 0;
    return [utcStrftime("%Y-%m-%d", `${tsCol} + ?`, x.dialecte), [off]];
  }
  return [castInt(`(${tsCol} - ?) / ${HOUR}`, x.dialecte), [plan.origin]];
}

/** Agrégats par série puis par seau ; la série d'un agrégat sans regroupement est la clé « ». */
export type Agregat = Map<unknown, Map<unknown, number>>;

/** `aggregate_series` : table, colonnes et expressions viennent toujours du code appelant ; une erreur rend un agrégat vide. */
export async function aggregateSeries(
  x: Executeur,
  o: {
    table: string;
    tsCol: string;
    valueExpr: string;
    plan: PlanSeaux;
    whereSql?: string;
    params?: readonly Valeur[];
    groupCol?: string | null;
  },
): Promise<Agregat> {
  const { plan } = o;
  if (!plan.edges.length) return new Map();
  const [cle, parametresCle] = expressionSeau(plan, o.tsCol, x);
  const lo = plan.edges[0] as number;
  const hi = (plan.edges[plan.edges.length - 1] as number) + (plan.granularity === "day" ? DAY : HOUR);
  const selGrp = o.groupCol ? `, ${o.groupCol} AS grp` : "";
  const grpBy = o.groupCol ? `, ${o.groupCol}` : "";
  const sql =
    `SELECT ${cle} AS bkey${selGrp}, ${o.valueExpr} AS val ` +
    `FROM ${o.table} ` +
    `WHERE (${o.whereSql ?? "1=1"}) AND ${o.tsCol} >= ? AND ${o.tsCol} < ? ` +
    `GROUP BY bkey${grpBy}`;
  const sortie: Agregat = new Map();
  let lignes: Record<string, unknown>[];
  try {
    lignes = await x.all(sql, [...parametresCle, ...(o.params ?? []), lo, hi]);
  } catch (e) {
    log.debug({ err: e }, `[metrics] aggregate_series a échoué (${o.table})`);
    return sortie;
  }
  for (const l of lignes) {
    const serie = o.groupCol ? (l["grp"] ?? "") : "";
    let points = sortie.get(serie);
    if (points === undefined) sortie.set(serie, (points = new Map()));
    const val = l["val"];
    points.set(l["bkey"], typeof val === "number" && val ? val : 0);
  }
  return sortie;
}

/** Palette alignée sur les accents de l'application : elle distingue des séries, jamais ne décore. */
export const PALETTE = [
  "59,130,246",
  "16,185,129",
  "245,158,11",
  "139,92,246",
  "239,68,68",
  "6,182,212",
  "249,115,22",
  "132,204,22",
] as const;

export function couleur(i: number): string {
  return PALETTE[i % PALETTE.length] as string;
}

/** `to_chart` : verse les agrégats dans le calendrier (seau absent = 0.0), séries triées par leur texte. */
export function toChart(
  plan: PlanSeaux,
  data: Agregat,
  o: {
    kind?: "line" | "bar";
    labelsMap?: Readonly<Record<string, string>>;
    stacked?: boolean;
    roundTo?: number | null;
  } = {},
): Record<string, unknown> {
  const kind = o.kind ?? "line";
  const stacked = o.stacked ?? false;
  const index = new Map<unknown, number>(plan.keys.map((k, i) => [k, i]));
  const series = [...data.entries()].sort(([a], [b]) => comparePointsDeCode(strPy(a), strPy(b)));
  const datasets: Record<string, unknown>[] = series.map(([serie, points], i) => {
    const valeurs: unknown[] = plan.keys.map(() => new FlottantPy(0.0));
    for (const [cle, val] of points) {
      const pos = index.get(cle);
      if (pos === undefined) continue;
      const arrondir = o.roundTo !== null && o.roundTo !== undefined && !Number.isInteger(val);
      valeurs[pos] = arrondir ? new FlottantPy(arrondiPy(val, o.roundTo as number)) : val;
    }
    const c = couleur(i);
    const etiquettes = o.labelsMap ?? {};
    const parDefaut = serie !== "" ? strPy(serie) : "Total";
    const label =
      typeof serie === "string" && Object.hasOwn(etiquettes, serie)
        ? (etiquettes[serie] as string)
        : parDefaut;
    const ds: Record<string, unknown> = { label, data: valeurs };
    if (kind === "bar") Object.assign(ds, { backgroundColor: `rgba(${c},0.75)`, borderRadius: 4 });
    else
      Object.assign(ds, {
        borderColor: `rgb(${c})`,
        backgroundColor: `rgba(${c},0.12)`,
        tension: 0.35,
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
      });
    if (stacked) ds["stack"] = "all";
    return ds;
  });
  if (!datasets.length) {
    datasets.push({
      label: "Total",
      data: plan.keys.map(() => new FlottantPy(0.0)),
      borderColor: `rgb(${PALETTE[0]})`,
      backgroundColor: `rgba(${PALETTE[0]},0.12)`,
      tension: 0.35,
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
    });
  }
  return {
    labels: plan.labels,
    datasets,
    meta: {
      granularity: plan.granularity,
      timezone: plan.tzName,
      start: plan.edges.length ? new FlottantPy(plan.edges[0] as number) : 0,
      end: plan.edges.length ? new FlottantPy(plan.edges[plan.edges.length - 1] as number) : 0,
      stacked,
    },
  };
}

/** `granularity_for` : horaire jusqu'à 48 h, journalier au-delà. */
export function granularityFor(hours: number): "hour" | "day" {
  return intPy(hours) <= 48 ? "hour" : "day";
}
