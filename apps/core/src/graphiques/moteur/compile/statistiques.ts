// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/statistiques.ts — nuages, matrices, calendrier, boîtes, histogramme et chandeliers (port de _chart/compile_echarts.py). */
import {
  arrondiPy,
  cleHashPy,
  comparePointsDeCode,
  ErreurPython,
  fixePy,
  formatValeur,
  minPy,
  maxPy,
  strPy,
  stripPy,
} from "@elpis/commun";

import { num, toDate } from "../normalise";
import {
  el,
  ceilPy,
  enFlottant,
  fl,
  floorPy,
  fmeanPy,
  lg,
  maxListe,
  medianePy,
  minListe,
  plancherLog10,
  puissance10,
  quartilesExclusifs,
  quartilesInclusifs,
  sommePy,
  triee,
  truncPy,
} from "../py";
import type { Ligne } from "../py";
import { byName, dims, MAX_SERIES, measures, SpecError } from "../spec";
import type { Spec } from "../spec";
import { base, fr, grid, label, legend, markLines, MONTHS_FR, OTHER, regression, zoom } from "./commun";
import type { Opt } from "./commun";
import type { Column } from "../normalise";

/** `len({r.get(col) for r in rows})` : valeurs distinctes à l'égalité de Python. */
function distincts(rows: readonly Ligne[], nom: string): number {
  return new Set(rows.map((r) => cleHashPy(lg(r, nom)))).size;
}

/** `statistics.StatisticsError`. */
class ErreurStatistique extends Error {
  override name = "StatisticsError";
}

export function cScatter(spec: Spec): [Opt, string] {
  const cols = spec.cols;
  const m = measures(cols);
  let xs = spec.x;
  let ys = spec.ys[0] ?? null;
  const pool = m.filter((c) => c !== xs && c !== ys && c !== spec.size);
  if (xs === null) xs = pool.shift() ?? null;
  if (ys === null) ys = pool.shift() ?? null;
  if (xs === null || ys === null)
    throw new SpecError(
      `${spec.kind}: needs two numeric columns (x and y); columns: ${cols.map((c) => c.repr()).join(", ")}`,
      "",
      [
        { surface: 45, prix: 210000 },
        { surface: 70, prix: 305000 },
      ],
    );
  let size = spec.size;
  if (spec.kind === "bubble" && size === null) {
    size = pool.shift() ?? null;
    if (size === null) spec.notes.warn("bubble without a third measure: equal sizes");
  }
  const d = dims(cols);
  let group = spec.group;
  if (group === null && d.length > 0) {
    const cand = el(d, 0);
    const nUnique = distincts(spec.rows, cand.name);
    if (nUnique <= MAX_SERIES && nUnique < spec.rows.length) {
      group = cand;
      spec.notes.fix(`colour by '${group.name}'`);
    }
  }
  const nameCol = d.find((c) => c !== group && distincts(spec.rows, c.name) === spec.rows.length) ?? null;
  const xIsDate = xs.kind === "date";
  /** Un point : son élément ECharts et ses valeurs numériques (pour la tendance). */
  interface Point {
    it: Opt;
    x: number | null;
    y: number;
  }
  const groups = new Map<string, Point[]>();
  const smax = size !== null ? maxListe(spec.rows.map((r) => num(lg(r, size.name)) || 0)) : 1;
  for (const r of spec.rows) {
    const gx = lg(r, xs.name);
    const xv = xIsDate ? toDate(gx) : num(gx);
    const yv = num(lg(r, ys.name));
    if (xv === null || yv === null) continue;
    const g = group !== null ? strPy(lg(r, group.name)) : ys.name;
    const valeur: unknown[] = [typeof xv === "string" ? xv : fl(xv), fl(yv)];
    const it: Opt = { value: valeur };
    if (size !== null) {
      const sv = num(lg(r, size.name)) || 0;
      valeur.push(sv ? fl(sv) : 0);
      it["symbolSize"] = smax ? fl(arrondiPy(8 + 40 * Math.sqrt(Math.max(sv, 0) / smax), 1)) : 10;
    }
    if (nameCol !== null) it["name"] = strPy(lg(r, nameCol.name));
    const pt: Point = { it, x: typeof xv === "string" ? null : xv, y: yv };
    const pts = groups.get(g);
    if (pts === undefined) groups.set(g, [pt]);
    else pts.push(pt);
  }
  if (groups.size > MAX_SERIES) {
    const keys = [...groups.keys()];
    const rest = keys.slice(MAX_SERIES - 1);
    const merged = rest.flatMap((k) => {
      const pts = groups.get(k) ?? [];
      groups.delete(k);
      return pts;
    });
    groups.set(OTHER, merged);
    spec.notes.fix(`${rest.length} groups folded into '${OTHER}'`);
  }
  const o = base(spec);
  const series: Opt[] = [];
  for (const [g, pts] of groups) {
    const ser: Opt = {
      type: "scatter",
      name: g,
      data: pts.map((p) => p.it),
      symbolSize: 9,
      emphasis: { focus: "series" },
      itemStyle: { opacity: spec.kind === "scatter" ? 0.8 : 0.6, borderColor: "@surface", borderWidth: 1 },
    };
    if (g === OTHER) ser["itemStyle"].color = "@muted";
    series.push(ser);
  }
  if (spec.opts.trend && !xIsDate) {
    const allp = [...groups.values()].flat();
    const reg = regression(
      allp.map((p) => p.x),
      allp.map((p) => p.y),
    );
    if (reg !== null) {
      const [a, b, r2] = reg;
      const xsNum = allp.map((p) => p.x ?? 0);
      const x0 = minListe(xsNum);
      const x1 = maxListe(xsNum);
      series.push({
        type: "line",
        name: `Tendance (R² = ${fixePy(r2, 2)})`,
        symbol: "none",
        data: [
          [fl(x0), fl(a * x0 + b)],
          [fl(x1), fl(a * x1 + b)],
        ],
        lineStyle: { type: "dashed", width: 1.5, color: "@ink2" },
        itemStyle: { color: "@ink2" },
        tooltip: { show: false },
        silent: true,
      });
      spec.notes.fix(
        `trend: y = ${formatValeur(fl(a), ".3g")}*x + ${formatValeur(fl(b), ".3g")} (R² = ${fixePy(r2, 2)})`,
      );
    }
  }
  if (spec.opts.trend && !xIsDate && !series.some((x) => String(x["name"]).startsWith("Tendance")))
    spec.notes.warn("trend needs at least 3 numeric points: skipped");
  const ml = markLines(spec, "yAxis");
  if (ml !== null) el(series, 0)["markLine"] = ml;
  o["series"] = series;
  o["xAxis"] = {
    type: xIsDate ? "time" : "value",
    scale: true,
    name: xs.name,
    nameLocation: "middle",
    nameGap: 26,
    _fmt: !xIsDate,
    splitLine: { show: true },
  };
  o["yAxis"] = { type: "value", scale: true, name: ys.name, _fmt: true };
  o["tooltip"] = { trigger: "item" };
  o["_elpis"].axes = [xs.name, ys.name, ...(size !== null ? [size.name] : [])];
  legend(o, series.length);
  grid(o, 40);
  const n = [...groups.values()].reduce((acc, p) => acc + p.length, 0);
  return [
    o,
    `${spec.kind} · ${n} points · x=${xs.name} · y=${ys.name}` +
      (size !== null ? ` · taille=${size.name}` : "") +
      (group !== null ? ` · couleur=${group.name}` : ""),
  ];
}

/** « Lundi matin », « Lundi après-midi »… → (jours, créneaux) si cela forme une grille. */
function splitDim(vals: readonly unknown[]): [string[], string[], string] | null {
  for (const sep of [" × ", " x ", " / ", " - ", " – ", ", ", " "]) {
    const parts = vals.map((v): [string, string] | null => {
      if (v === null || !strPy(v).includes(sep)) return null;
      const s = strPy(v);
      const i = s.indexOf(sep);
      return [s.slice(0, i), s.slice(i + sep.length)];
    });
    if (!parts.every((p) => p !== null && stripPy(p[0]) !== "" && stripPy(p[1]) !== "")) continue;
    const a = parts.map((p) => stripPy(p?.[0] ?? ""));
    const b = parts.map((p) => stripPy(p?.[1] ?? ""));
    const [na, nb] = [new Set(a).size, new Set(b).size];
    const paires = new Set(a.map((x, i) => JSON.stringify([x, b[i]])));
    if (na >= 2 && nb >= 2 && paires.size === vals.length && na * nb <= 2 * vals.length) return [a, b, sep];
  }
  return null;
}

type Cellule = [string, string, number | null];

/** Au plus 3 cellules absentes, dans l'ordre x puis y : arrêt au 3e, jamais |xs|×|ys| paires parcourues pour rien. */
function exemplesAbsents(
  xs: readonly string[],
  ys: readonly string[],
  presentes: ReadonlySet<string>,
): string[] {
  const ex: string[] = [];
  for (const a of xs)
    for (const b of ys) {
      if (presentes.has(JSON.stringify([a, b]))) continue;
      ex.push(`${a} × ${b}`);
      if (ex.length === 3) return ex;
    }
  return ex;
}

export function cHeatmap(spec: Spec): [Opt, string] {
  const { cols, rows } = spec;
  const d = dims(cols);
  const m = measures(cols);
  let xcol = spec.x !== null && d.includes(spec.x) ? spec.x : null;
  let ycol: Column | null = null;
  let vcol: Column | null = null;
  for (const c of spec.ys) {
    if (d.includes(c) && ycol === null) ycol = c;
    else if (m.includes(c) && vcol === null) vcol = c;
  }
  const restD = d.filter((c) => c !== xcol && c !== ycol);
  xcol = xcol ?? restD.shift() ?? null;
  ycol = ycol ?? restD.shift() ?? null;
  vcol = vcol ?? m[0] ?? null;
  const cells: Cellule[] = [];
  if (xcol !== null && ycol === null && m.length >= 2) {
    const vs = spec.ys.length > 0 && spec.ys.every((c) => m.includes(c)) ? spec.ys : m;
    for (const r of rows)
      for (const c of vs) cells.push([label(lg(r, xcol.name)), c.name, num(lg(r, c.name))]);
    spec.notes.fix("wide format: one numeric column per heatmap row");
  } else if (xcol !== null && ycol === null && xcol.kind === "date") {
    spec.kind = "calendar";
    spec.notes.fix("a single date column: calendar instead of a heatmap");
    return cCalendar(spec);
  } else if (
    xcol !== null &&
    ycol === null &&
    vcol !== null &&
    splitDim(rows.map((r) => lg(r, xcol.name))) !== null
  ) {
    const [a, b] = splitDim(rows.map((r) => lg(r, xcol.name))) ?? [[], [], ""];
    rows.forEach((r, i) => cells.push([el(a, i), el(b, i), num(lg(r, vcol.name))]));
    spec.notes.fix(
      `'${xcol.name}' held both dimensions ('${strPy(lg(el(rows, 0), xcol.name))}'): split into rows x columns`,
    );
  } else if (xcol === null || ycol === null || vcol === null) {
    throw new SpecError(
      "heatmap: needs two category columns (x, y) and a value; received: " +
        cols.map((c) => c.repr()).join(", "),
      "one row per cell: row name, column name and value (NAMES, not indexes)",
      [
        { jour: "lun.", heure: "9 h", appels: 12 },
        { jour: "lun.", heure: "10 h", appels: 18 },
      ],
    );
  } else {
    for (const r of rows)
      cells.push([label(lg(r, xcol.name)), label(lg(r, ycol.name)), num(lg(r, vcol.name))]);
  }
  const xs = [...new Set(cells.map((c) => c[0]))];
  const ys = [...new Set(cells.map((c) => c[1]))];
  const presentes = new Set(cells.map((c) => JSON.stringify([c[0], c[1]])));
  const nAbsentes = xs.length * ys.length - presentes.size;
  if (nAbsentes > 0)
    spec.notes.warn(
      `${nAbsentes} cell(s) missing (${exemplesAbsents(xs, ys, presentes).join(", ")}): left empty`,
    );
  const vals = cells.map((c) => c[2]).filter((v): v is number => v !== null);
  if (vals.length === 0) throw new SpecError("heatmap: no numeric value");
  const [lo, hi] = [minListe(vals), maxListe(vals)];
  const o = base(spec);
  const diverging = lo < 0 && 0 < hi;
  const vmin = diverging ? -maxPy(Math.abs(lo), hi) : lo;
  const vmax = diverging ? maxPy(Math.abs(lo), hi) : hi;
  o["visualMap"] = {
    min: fl(vmin),
    max: fl(vmax),
    calculable: true,
    orient: "horizontal",
    left: "center",
    bottom: 2,
    itemWidth: 12,
    itemHeight: 160,
    inRange: { color: diverging ? "@div" : "@seq" },
    textStyle: { color: "@ink2" },
  };
  o["xAxis"] = {
    type: "category",
    data: xs,
    splitArea: { show: false },
    axisTick: { show: false },
    axisLine: { show: false },
  };
  o["yAxis"] = {
    type: "category",
    data: ys,
    inverse: true,
    axisTick: { show: false },
    axisLine: { show: false },
  };
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, i) => [y, i]));
  const cell = (a: string, b: string, v: number | null): unknown => {
    if (v === null) return [xi.get(a), yi.get(b), "-"];
    const r = vmax > vmin ? (v - vmin) / (vmax - vmin) : 0.5;
    const strong = diverging ? Math.abs(r - 0.5) > 0.3 : r > 0.55;
    return {
      value: [xi.get(a), yi.get(b), fl(v)],
      name: `${a} · ${b} : ${fr(v, spec.opts.unit)}`,
      label: { color: strong ? "@onhi" : "@onlo" },
    };
  };
  o["series"] = [
    {
      type: "heatmap",
      data: cells.map(([a, b, v]) => cell(a, b, v)),
      label: { show: cells.length <= 120, fontSize: 10 },
      _lbl: { v: 2 },
      itemStyle: { borderColor: "@surface", borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: "@ink", borderWidth: 1 } },
      tooltip: { formatter: "{b}" },
    },
  ];
  o["tooltip"] = { trigger: "item" };
  grid(o, 64);
  const hot = cells.reduce((meilleur, c) =>
    (c[2] ?? -Infinity) > (meilleur[2] ?? -Infinity) ? c : meilleur,
  );
  return [
    o,
    `heatmap · ${xs.length}x${ys.length} cells · max ${fr(hot[2], spec.opts.unit)} (${hot[0]}, ${hot[1]})`,
  ];
}

export function cCalendar(spec: Spec): [Opt, string] {
  const majoriteDates = (c: Column): boolean => {
    const vus = spec.rows.map((r) => lg(r, c.name)).filter((v) => v !== null && v !== "");
    return vus.length > 0 && vus.filter((v) => toDate(v) !== null).length * 2 > vus.length;
  };
  const dcol =
    spec.x !== null && spec.x.kind === "date"
      ? spec.x
      : (spec.cols.find((c) => c.kind === "date") ??
        spec.cols.find((c) => c.kind !== "number" && majoriteDates(c)) ??
        null);
  const vcol = (spec.ys.length > 0 ? spec.ys : measures(spec.cols))[0] ?? null;
  if (dcol === null || vcol === null)
    throw new SpecError("calendar: needs a date column (YYYY-MM-DD) and a value", "", [
      { date: "2026-01-05", visites: 34 },
    ]);
  const pts = new Map<string, number>();
  const illisibles: string[] = [];
  let slash = false;
  for (const r of spec.rows) {
    const brut = lg(r, dcol.name);
    const date = toDate(brut);
    const v = num(lg(r, vcol.name));
    if (date && v !== null) {
      const jour = date.slice(0, 10);
      pts.set(jour, (pts.get(jour) ?? 0) + v);
      if (typeof brut === "string" && /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(brut.trim())) slash = true;
    } else if (brut !== null && brut !== "") illisibles.push(strPy(brut));
  }
  if (illisibles.length > 0)
    spec.notes.warn(
      `${illisibles.length} row(s) skipped, unreadable date or value: ${illisibles.slice(0, 5).join(", ")}`,
    );
  if (slash) spec.notes.fix("dates written 05/01/2026 read as DD/MM/YYYY");
  const years = [...new Set([...pts.keys()].map((d) => d.slice(0, 4)))].sort(comparePointsDeCode).slice(0, 3);
  const o = base(spec);
  const calendar: Opt[] = [];
  const series: Opt[] = [];
  o["calendar"] = calendar;
  o["series"] = series;
  const top = o["title"] ? 70 : 40;
  const tries = [...pts].sort((p, q) => comparePointsDeCode(p[0], q[0]));
  years.forEach((y, i) => {
    calendar.push({
      range: y,
      top: top + i * 150,
      left: 36,
      right: 12,
      cellSize: ["auto", 15],
      splitLine: { show: false },
      itemStyle: { borderColor: "@surface", borderWidth: 2, color: "@track" },
      yearLabel: { show: years.length > 1, color: "@ink2" },
      dayLabel: { firstDay: 1, nameMap: ["D", "L", "M", "M", "J", "V", "S"], color: "@ink2", fontSize: 10 },
      monthLabel: { nameMap: MONTHS_FR, color: "@ink2", fontSize: 11 },
    });
    series.push({
      type: "heatmap",
      coordinateSystem: "calendar",
      calendarIndex: i,
      tooltip: { formatter: "{b}" },
      data: tries
        .filter(([d]) => d.startsWith(y))
        .map(([d, v]) => ({
          value: [d, fl(v)],
          name: `${Number(d.slice(8))} ${el(MONTHS_FR, Number(d.slice(5, 7)) - 1)} ${d.slice(0, 4)} : ${fr(v, spec.opts.unit)}`,
        })),
    });
  });
  const vals = [...pts.values()];
  if (vals.length === 0) throw new ErreurPython("ValueError", "min() iterable argument is empty");
  o["visualMap"] = {
    min: fl(minListe(vals)),
    max: fl(maxListe(vals)),
    calculable: false,
    orient: "horizontal",
    left: "center",
    top: top + years.length * 150 - 24,
    itemWidth: 12,
    itemHeight: 140,
    inRange: { color: "@seq" },
    textStyle: { color: "@ink2" },
  };
  o["tooltip"] = { trigger: "item" };
  o["_elpis"].height = top + years.length * 150 + 20;
  const best = [...pts].reduce((meilleur, kv) => (kv[1] > meilleur[1] ? kv : meilleur));
  return [
    o,
    `calendar · ${pts.size} days · ${years.join(", ")} · max ${fr(best[1], spec.opts.unit)} on ${best[0]}`,
  ];
}

/** Boîte (min, Q1, médiane, Q3, max) et valeurs atypiques d'une série. */
function quartiles(donnees: readonly number[]): [number, number, number, number, number, number[]] {
  const xs = triee(donnees);
  if (xs.length === 0) throw new ErreurStatistique("must have at least one data point");
  if (xs.length === 1) {
    const v = el(xs, 0);
    return [v, v, v, v, v, []];
  }
  const [q1, med, q3] = quartilesInclusifs(xs);
  const iqr = q3 - q1;
  const [loF, hiF] = [q1 - 1.5 * iqr, q3 + 1.5 * iqr];
  const inside = xs.filter((v) => loF <= v && v <= hiF);
  const out = xs.filter((v) => v < loF || v > hiF);
  if (inside.length === 0) throw new ErreurPython("ValueError", "min() iterable argument is empty");
  return [minListe(inside), q1, med, q3, maxListe(inside), out];
}

export function cBoxplot(spec: Spec): [Opt, string] {
  const cols = spec.cols;
  const pre = {
    min_: byName(cols, "min_", ["number"]),
    q1: byName(cols, "q1", ["number"]),
    median: byName(cols, "median", ["number"]),
    q3: byName(cols, "q3", ["number"]),
  };
  const mxc = byName(cols, "max", ["number"]);
  const d = dims(cols);
  const m = measures(cols);
  const groups = new Map<string, number[]>();
  const boxes: (unknown[] | null)[] = [];
  const outliers: unknown[][] = [];
  const rawPts: unknown[][] = [];
  let names: string[];
  const nombre = (x: number | null): unknown => (x === null ? null : fl(x));
  const boxesNum: (number | null)[][] = [];
  if (pre.min_ !== null && pre.q1 !== null && pre.median !== null && pre.q3 !== null && mxc !== null) {
    const g = d[0] ?? null;
    const colonnes = [pre.min_, pre.q1, pre.median, pre.q3, mxc];
    names = [];
    spec.rows.forEach((r, i) => {
      names.push(g !== null ? label(lg(r, g.name)) : `#${i + 1}`);
      const valeurs = colonnes.map((c) => num(lg(r, c.name)));
      boxesNum.push(valeurs);
      boxes.push(valeurs.map(nombre));
    });
    spec.notes.fix("precomputed quartiles used as given");
  } else {
    const g = spec.group ?? spec.x ?? d[0] ?? null;
    const vcols = spec.ys.length > 0 ? spec.ys : m;
    if (g !== null && vcols.length > 0) {
      for (const r of spec.rows) {
        const v = num(lg(r, el(vcols, 0).name));
        if (v !== null) {
          const cle = label(lg(r, g.name));
          const xs = groups.get(cle);
          if (xs === undefined) groups.set(cle, [v]);
          else xs.push(v);
        }
      }
    } else if (vcols.length >= 1) {
      for (const c of vcols)
        groups.set(
          c.name,
          spec.rows.map((r) => num(lg(r, c.name))).filter((v): v is number => v !== null),
        );
      if (vcols.length > 1) spec.notes.fix("one box per numeric column");
    }
    if (groups.size === 0)
      throw new SpecError("boxplot: needs raw values (one row per measurement)", "", [
        { équipe: "A", délai: 3.2 },
        { équipe: "A", délai: 4.1 },
        { équipe: "B", délai: 2.7 },
      ]);
    names = [...groups.keys()];
    [...groups.values()].forEach((xs, gi) => {
      const [lo, q1, med, q3, hi, out] = quartiles(xs);
      const arrondies = [lo, q1, med, q3, hi].map((v) => arrondiPy(v, 4));
      boxesNum.push(arrondies);
      boxes.push(arrondies.map((v) => fl(v)));
      for (const v of out) outliers.push([gi, fl(v)]);
      if (xs.length <= 60) for (const v of xs) rawPts.push([gi, fl(v)]);
    });
  }
  const o = base(spec);
  const axeX = spec.group ?? spec.x ?? d[0] ?? null;
  o["xAxis"] = {
    type: "category",
    data: names,
    axisTick: { show: false },
    name: axeX !== null ? axeX.name : "",
  };
  const axeY = (spec.ys.length > 0 ? spec.ys : m)[0] ?? null;
  o["yAxis"] = { type: "value", scale: true, _fmt: true, name: axeY !== null ? axeY.name : "" };
  o["series"] = [
    {
      type: "boxplot",
      name: "Distribution",
      data: boxes,
      boxWidth: [12, 46],
      itemStyle: { color: "@series1a", borderColor: "@series1", borderWidth: 1.5 },
    },
  ];
  if (rawPts.length > 0) {
    o["series"].push({
      type: "scatter",
      name: "Valeurs",
      data: rawPts,
      symbolSize: 5,
      itemStyle: { color: "@ink2", opacity: 0.35 },
      z: 3,
    });
    o["xAxis"].jitter = 22;
    o["xAxis"].jitterOverlap = false;
  }
  if (outliers.length > 0)
    o["series"].push({
      type: "scatter",
      name: "Valeurs atypiques",
      data: outliers,
      symbolSize: 7,
      itemStyle: { color: "@down" },
      z: 4,
    });
  const ml = markLines(spec, "yAxis");
  if (ml !== null) o["series"][0].markLine = ml;
  o["tooltip"] = { trigger: "item" };
  legend(o, o["series"].length);
  grid(o, 36);
  const medianes = names.slice(0, 4).map((n, i) => `${n} ${fr(el(boxesNum, i)[2] ?? null, spec.opts.unit)}`);
  return [o, `boxplot · ${names.length} groups · medians: ` + medianes.join(", ")];
}

/** `a // b` de Python sur des flottants. */
export function divEntierePy(vx: number, wx: number): number {
  const mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod && wx < 0 !== mod < 0) div -= 1;
  if (div) {
    const plancher = Math.floor(div);
    return div - plancher > 0.5 ? plancher + 1 : plancher;
  }
  const quotient = vx / wx;
  return quotient < 0 || Object.is(quotient, -0) ? -0 : 0;
}

/** Pas de l'histogramme : valeur flottante et, si Python le garde `int`, sa valeur exacte. */
interface Pas {
  n: number;
  entier: bigint | null;
}

/** Pas « rond » de l'histogramme : le plus petit des 1, 2, 2,5, 5, 10 × 10^k qui couvre `step` (`int` Python quand k ≥ 0 et le multiple est entier). */
function pasRond(step: number, stepEntier: boolean): Pas {
  const mag = step > 0 ? puissance10(plancherLog10(step)) : 1n;
  for (const k of [1, 2, 2.5, 5, 10]) {
    if (typeof mag === "bigint") {
      if (Number.isInteger(k)) {
        const produit = BigInt(k) * mag;
        if (produit >= BigInt(Number.isInteger(step) ? step : Math.ceil(step)))
          return { n: enFlottant(produit), entier: produit };
      } else if (enFlottant(mag) * k >= step) return { n: enFlottant(mag) * k, entier: null };
    } else if (mag * k >= step) return { n: mag * k, entier: null };
  }
  return { n: step, entier: stepEntier ? BigInt(step) : null };
}

export function cHistogram(spec: Spec): [Opt, string] {
  const m = measures(spec.cols);
  const vcol = (spec.ys.length > 0 ? spec.ys : m)[0] ?? null;
  if (vcol === null)
    throw new SpecError("histogram: needs a column of raw values", "", [
      { âge: 34 },
      { âge: 41 },
      { âge: 29 },
    ]);
  const group = spec.group;
  const groups = new Map<string, number[]>();
  for (const r of spec.rows) {
    const v = num(lg(r, vcol.name));
    if (v !== null) {
      const cle = group !== null ? strPy(lg(r, group.name)) : vcol.name;
      const vs = groups.get(cle);
      if (vs === undefined) groups.set(cle, [v]);
      else vs.push(v);
    }
  }
  const allv = triee([...groups.values()].flat());
  if (allv.length < 2) throw new SpecError("histogram: at least 2 values");
  const [q1, , q3] = quartilesExclusifs(allv);
  const iqr = q3 - q1;
  const [lo, hi] = [el(allv, 0), el(allv, -1)];
  const width =
    iqr > 0
      ? (2 * iqr) / allv.length ** (1 / 3)
      : (hi - lo) / Math.max(1, ceilPy(Math.log2(allv.length) + 1));
  let nb = width > 0 ? Math.max(5, Math.min(40, ceilPy((hi - lo) / width))) : 1;
  const pasBrut = nb && hi > lo ? (hi - lo) / nb : 1;
  const { n: step, entier } = pasRond(pasBrut, !(nb && hi > lo));
  const startExact = entier === null ? null : BigInt(floorPy(lo / step)) * entier;
  const start = startExact === null ? floorPy(lo / step) * step : enFlottant(startExact);
  nb = Math.max(1, ceilPy((hi - start) / step + 1e-9));
  const depasse =
    startExact === null
      ? start + nb * step <= hi
      : startExact + BigInt(nb) * (entier ?? 0n) <= BigInt(Math.floor(hi));
  if (depasse) nb += 1;
  const edges = Array.from({ length: nb + 1 }, (_, i) =>
    startExact === null ? start + i * step : enFlottant(startExact + BigInt(i) * (entier ?? 0n)),
  );
  const labels = Array.from(
    { length: nb },
    (_, i) => `${fr(el(edges, i), "", 2)} – ${fr(el(edges, i + 1), "", 2)}`,
  );
  const o = base(spec);
  const series: Opt[] = [];
  for (const [g, vs] of groups) {
    const counts = new Array<number>(nb).fill(0);
    for (const v of vs) {
      const i = Math.min(nb - 1, truncPy(divEntierePy(v - start, step)));
      const idx = i < 0 ? nb + i : i;
      if (idx < 0) throw new ErreurPython("IndexError", "list index out of range");
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    series.push({
      type: "bar",
      name: g,
      data: counts,
      barCategoryGap: "4%",
      barGap: "0%",
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      emphasis: { focus: "series" },
    });
  }
  o["series"] = series;
  o["xAxis"] = {
    type: "category",
    data: labels,
    name: vcol.name,
    nameLocation: "middle",
    nameGap: 28,
    axisTick: { show: false },
    axisLabel: { hideOverlap: true },
  };
  o["yAxis"] = { type: "value", name: "effectif", minInterval: 1 };
  o["tooltip"] = { trigger: "axis", axisPointer: { type: "shadow" } };
  const mean = fmeanPy(allv);
  const med = medianePy(allv);
  o["_elpis"].unit = "";
  legend(o, series.length);
  grid(o, 44);
  return [
    o,
    `histogram · ${allv.length} values · ${nb} bins of ${fr(step)} · ` +
      `mean ${fr(mean, spec.opts.unit)} · median ${fr(med, spec.opts.unit)}`,
  ];
}

export function cCandlestick(spec: Spec): [Opt, string] {
  const cols = spec.cols;
  const nommees = ["open", "high", "low", "close"].map((k) => byName(cols, k, ["number"]));
  const m = measures(cols);
  let ohlc: Column[];
  if (nommees.every((c): c is Column => c !== null)) ohlc = nommees;
  else if (m.length === 4) {
    ohlc = m;
    spec.notes.warn("OHLC columns not named: order assumed open, high, low, close");
  } else
    throw new SpecError("candlestick: needs open, high, low, close columns", "", [
      { date: "2026-03-02", open: 101.2, high: fl(104), low: 100.5, close: 103.1 },
    ]);
  const xcol = spec.x ?? cols.find((c) => c.kind === "date") ?? dims(cols)[0] ?? null;
  let rows = spec.rows;
  if (xcol !== null && xcol.kind === "date") {
    const c = xcol;
    rows = [...rows].sort((a, b) =>
      comparePointsDeCode(toDate(lg(a, c.name)) ?? "", toDate(lg(b, c.name)) ?? ""),
    );
  }
  const cats = rows.map((r, i) => (xcol !== null ? label(lg(r, xcol.name)) : `#${i + 1}`));
  const data: ([number, number, number, number] | "-")[] = [];
  let bad = 0;
  for (const r of rows) {
    const valeurs = ohlc.map((c) => num(lg(r, c.name)));
    const [ov, hv, lv0, cv] = [el(valeurs, 0), el(valeurs, 1), el(valeurs, 2), el(valeurs, 3)];
    if (ov === null || hv === null || lv0 === null || cv === null) {
      data.push("-");
      continue;
    }
    let lv = lv0;
    let hv2 = hv;
    if (!(lv <= minPy(ov, cv) && hv >= maxPy(ov, cv))) {
      bad += 1;
      lv = minPy(ov, cv, lv);
      hv2 = maxPy(ov, cv, hv);
    }
    data.push([ov, cv, lv, hv2]);
  }
  if (bad > 0) spec.notes.warn(`${bad} inconsistent candle(s) (low above open/close...): range widened`);
  const o = base(spec);
  o["xAxis"] = { type: "category", data: cats, boundaryGap: true, axisTick: { show: false } };
  o["yAxis"] = { type: "value", scale: true, _fmt: true };
  const sortie = (d: [number, number, number, number] | "-"): unknown =>
    d === "-" ? "-" : d.map((v) => fl(v));
  o["series"] = [
    {
      type: "candlestick",
      name: spec.opts.title || "Cours",
      data: data.map(sortie),
      barMaxWidth: 14,
      itemStyle: {
        color: "@surface",
        borderColor: "@gain",
        color0: "@loss",
        borderColor0: "@loss",
        borderWidth: 1.5,
      },
    },
  ];
  if (spec.opts.trend) {
    const closes = data.map((d) => (d === "-" ? null : d[1]));
    const ma = closes.map((_, i) => {
      const win = closes.slice(Math.max(0, i - 4), i + 1).filter((v): v is number => v !== null);
      return win.length === 5 ? fl(arrondiPy(sommePy(win) / win.length, 4)) : "-";
    });
    o["series"].push({
      type: "line",
      name: "Moyenne mobile 5",
      data: ma,
      symbol: "none",
      smooth: true,
      lineStyle: { width: 1.5, color: "@series1" },
    });
    if (data.filter((d) => d !== "-").length >= 5) spec.notes.fix("trend on prices: 5-period moving average");
    else spec.notes.warn("trend on prices needs at least 5 candles: moving average not drawn");
  }
  o["tooltip"] = { trigger: "axis", axisPointer: { type: "cross" } };
  legend(o, o["series"].length);
  grid(o, zoom(o, cats.length, "x", 40));
  const bougies = data.filter((d): d is [number, number, number, number] => d !== "-");
  const first = bougies[0];
  const last = bougies.at(-1);
  const variation =
    first !== undefined && last !== undefined && first[0]
      ? `${formatValeur(fl((100 * (last[1] - first[0])) / first[0]), "+.1f")} %`
      : "—";
  return [o, `candlestick · ${cats.length} periods · change ${variation}`];
}
