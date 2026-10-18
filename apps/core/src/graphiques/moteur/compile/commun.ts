// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/commun.ts — briques communes des compilateurs ECharts : mise en forme française, catégories × séries, options de base (port de _chart/compile_echarts.py, début). */
import { comparePointsDeCode, ErreurPython, FlottantPy, formatValeur, rstripPy, strPy } from "@elpis/commun";

import type { Column } from "../normalise";
import { monthKey, num, toDate } from "../normalise";
import {
  el,
  enFlottant,
  entier,
  fl,
  flottant,
  lg,
  plancherLog10,
  puissance10,
  sommePy,
  sommeTermes,
} from "../py";
import type { Terme } from "../py";
import { dims, MAX_SERIES, measures, SpecError } from "../spec";
import type { Spec } from "../spec";

/** Option ECharts : JSON pur construit par morceaux (clés dans l'ordre d'insertion Python). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Opt = Record<string, any>;

/** Nombre prêt à écrire : un `float` entier est un `FlottantPy`, un nombre JS entier est un `int` Python. */
export type Nb = number | FlottantPy;

export const OTHER = "Autres";
export const MONTHS_FR = [
  "janv.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];
export const ORDINAL_RAMP = ["#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];

/** Valeur numérique d'un `Nb`. */
export function val(x: Nb): number {
  return x instanceof FlottantPy ? x.valeur : x;
}

/** Valeur numérique d'un `Nb` ou null. */
export function valN(x: Nb | null): number | null {
  return x === null ? null : val(x);
}

/** `x or 0` : un zéro (entier ou flottant) ou l'absence donne l'entier 0. */
export function ou0(x: number | null): Terme {
  return x === null || x === 0 ? entier(0) : flottant(x);
}

/** Résultat d'une somme Python prêt à écrire. */
export function sortieTerme(t: Terme): Nb {
  return t.f ? fl(t.v) : t.v;
}

const ESPACE_FINE = " ";

export function fr(v: number | null, unit = "", digits = 2): string {
  if (v === null) return "—";
  const a = Math.abs(v);
  let s = v;
  let suf = "";
  if (a >= 1e9) [s, suf] = [v / 1e9, " Md"];
  else if (a >= 1e6) [s, suf] = [v / 1e6, " M"];
  else if (a >= 1e4) [s, suf] = [v / 1e3, " k"];
  let txt = digits
    ? rstripPy(rstripPy(formatValeur(fl(s), `,.${digits}f`), "0"), ".")
    : formatValeur(fl(s), ",.0f");
  txt = txt.replaceAll(",", ESPACE_FINE).replaceAll(".", ",").replaceAll("-", "−");
  const sep = unit ? ESPACE_FINE : "";
  return !suf || !unit ? `${txt}${suf}${sep}${unit}` : `${txt}${suf}${unit}`;
}

/** `int >= flottant` exact. */
function entierSuperieur(r: bigint, v: number): boolean {
  return r >= BigInt(Number.isInteger(v) ? v : Math.ceil(v));
}

/** Plafond « rond » d'une valeur : forme à écrire (int, float ou grand entier) et valeur flottante, convertie seulement à la demande comme Python. */
export function niceCeil(v: number): { valeur: () => number; sortie: number | bigint | FlottantPy } {
  if (v <= 0) return { valeur: () => 1, sortie: fl(1) };
  const e = puissance10(plancherLog10(v));
  const multiples = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const m of multiples) {
    if (typeof e === "bigint") {
      if (Number.isInteger(m)) {
        const r = BigInt(m) * e;
        if (entierSuperieur(r, v)) return { valeur: () => enFlottant(r), sortie: r };
      } else {
        const x = m * enFlottant(e);
        if (x >= v) return { valeur: () => x, sortie: fl(x) };
      }
    } else {
      const x = m * e;
      if (x >= v) return { valeur: () => x, sortie: fl(x) };
    }
  }
  if (typeof e === "bigint") return { valeur: () => enFlottant(10n * e), sortie: 10n * e };
  return { valeur: () => 10 * e, sortie: fl(10 * e) };
}

/** Libellé d'une catégorie : « (vide) », entier sans « .0 », sinon `str`. */
export function label(v: unknown): string {
  if (v === null || v === undefined) return "(vide)";
  if (v instanceof FlottantPy && Number.isFinite(v.valeur)) return BigInt(v.valeur).toString();
  return strPy(v);
}

export interface Serie {
  name: string;
  data: (Nb | null)[];
}

/** Catégories à mettre en avant qui existent vraiment ; les inconnues sont annoncées, et si aucune n'existe rien n'est grisé. */
export function highlightConnu(spec: Spec, cats: readonly string[]): Set<string> {
  const voulus = spec.opts.highlight ?? [];
  const connus = voulus.filter((h) => cats.includes(h));
  const inconnus = voulus.filter((h) => !cats.includes(h));
  if (inconnus.length > 0)
    spec.notes.warn(
      `highlight not found among the categories: ${inconnus.join(", ")}` +
        (connus.length === 0 ? " (nothing greyed out)" : ""),
    );
  return new Set(connus);
}

export function cartesian(spec: Spec, multi = true): [string[], Serie[], string, string[]] {
  const { rows, cols, notes } = spec;
  const d = dims(cols);
  const m = measures(cols);
  const explicites = new Set(spec.ys.map((c) => c.name));
  const x =
    spec.x ??
    d.find((c) => !explicites.has(c.name) && (c.dates || c.months)) ??
    d.find((c) => !explicites.has(c.name)) ??
    null;
  const used = new Set([x, spec.group, spec.size].filter((c) => c !== null).map((c) => c.name));
  let ys = spec.ys.length > 0 ? spec.ys : m.filter((c) => !used.has(c.name));
  if (ys.length === 0) {
    const mi = (c: Column): boolean => {
      const vus = rows.map((r) => lg(r, c.name)).filter((v) => v !== null && v !== "");
      return vus.length > 0 && vus.filter((v) => num(v) !== null).length * 2 > vus.length;
    };
    const quasi = d.find((c) => c.kind === "text" && !used.has(c.name) && mi(c));
    if (quasi !== undefined) {
      ys = [quasi];
      notes.warn(`'${quasi.name}' is mostly numeric: read as numbers, the other cells are ignored`);
    }
  }
  if (ys.length === 0)
    throw new SpecError(
      `no numeric column to plot (columns: ${cols.map((c) => c.name).join(", ")})`,
      'add a column of numbers, or name it with y=["column"]',
      [
        { catégorie: "A", valeur: 12 },
        { catégorie: "B", valeur: 7 },
      ],
    );
  let group = spec.group;
  if (group !== null && (group === x || ys.length > 1)) {
    spec.notes.fix(
      `group '${group.name}' ignored: ` +
        (group === x ? "it is already the category (x)" : "one column per series, all plotted"),
    );
    group = null;
  }
  if (multi && group === null && ys.length === 1 && x !== null) {
    const others = d.filter((c) => c !== x && !ys.includes(c));
    if (others.length > 0 && !["pie", "donut", "rose", "funnel", "waterfall"].includes(spec.kind)) {
      group = others[0] ?? null;
      if (group !== null) notes.fix(`long format: series = column '${group.name}'`);
    }
  }
  spec.group = group;
  if (group !== null && ys.length > 1) {
    notes.warn(`group + several y: only '${el(ys, 0).name}' is plotted`);
    ys = ys.slice(0, 1);
  }

  const cats = new Map<string, unknown>();
  rows.forEach((r, i) => {
    const key = x !== null ? label(lg(r, x.name)) : `#${i + 1}`;
    if (!cats.has(key)) cats.set(key, x !== null ? lg(r, x.name) : key);
  });
  let keys = [...cats.keys()];
  if (x !== null && (x.dates || x.months)) {
    const sk = (k: string): string => (x.dates ? toDate(cats.get(k)) : monthKey(cats.get(k))) ?? "";
    const triees = [...keys].sort((a, b) => comparePointsDeCode(sk(a), sk(b)));
    if (keys.some((k, i) => k !== triees[i])) {
      keys = triees;
      notes.fix(`'${x.name}' sorted chronologically`);
    }
  }

  const series = new Map<string, Map<string, number | null>>();
  const vides = new Map<string, { n: number; ex: string[] }>();
  let dup = false;
  rows.forEach((r, i) => {
    const key = x !== null ? label(lg(r, x.name)) : `#${i + 1}`;
    const noms: [string, (typeof ys)[number]][] =
      group !== null ? [[label(lg(r, group.name)), el(ys, 0)]] : ys.map((c) => [c.name, c]);
    for (const [sname, col] of noms) {
      const v = num(lg(r, col.name));
      if (v === null) {
        const brut = lg(r, col.name);
        const e = vides.get(col.name) ?? { n: 0, ex: [] };
        e.n++;
        if (brut !== null && brut !== "" && e.ex.length < 5) e.ex.push(strPy(brut));
        vides.set(col.name, e);
      }
      let s = series.get(sname);
      if (s === undefined) {
        s = new Map();
        series.set(sname, s);
      }
      const prec = s.get(key);
      if (s.has(key) && prec !== null && prec !== undefined && v !== null) {
        s.set(key, (prec ? prec : 0) + v);
        dup = true;
      } else if (!s.has(key) || prec === null) s.set(key, v);
    }
  });
  for (const [nom, e] of vides)
    notes.warn(
      `${e.n} empty or non-numeric value(s) in '${nom}': not drawn` +
        (e.ex.length > 0 ? ` (${e.ex.join(", ")})` : ""),
    );
  if (dup) notes.warn(`several rows share the same '${x !== null ? x.name : "x"}': summed`);

  let out: Serie[] = [...series].map(([name, s]) => ({
    name,
    data: keys.map((k) => {
      const v = s.get(k);
      return v === undefined || v === null ? null : fl(v);
    }),
  }));

  const totals = keys.map((_, i) => sommeTermes(out.map((s) => ou0(abs(el(s.data, i))))).v);
  let order = keys.map((_, i) => i);
  if (spec.opts.sort === "asc" || spec.opts.sort === "desc") {
    const desc = spec.opts.sort === "desc";
    order = [...order].sort((a, b) => (desc ? el(totals, b) - el(totals, a) : el(totals, a) - el(totals, b)));
  }
  const top = spec.opts.top;
  if (top > 0 && keys.length > top) {
    const best = new Set([...order].sort((a, b) => el(totals, b) - el(totals, a)).slice(0, top));
    const keep = order.filter((i) => best.has(i));
    const rest = order.filter((i) => !best.has(i));
    const newKeys = [...keep.map((i) => el(keys, i)), OTHER];
    for (const s of out)
      s.data = [
        ...keep.map((i) => el(s.data, i)),
        sortieTerme(sommeTermes(rest.map((i) => ou0(valN(el(s.data, i)))))),
      ];
    notes.fix(`top ${top}: ${rest.length} categories folded into '${OTHER}'`);
    keys = newKeys;
  } else {
    keys = order.map((i) => el(keys, i));
    for (const s of out) s.data = order.map((i) => el(s.data, i));
  }

  if (out.length > MAX_SERIES) {
    const poids = (s: Serie): number => sommePy(s.data.map((v) => Math.abs(valN(v) ?? 0)));
    const ranked = [...out].sort((a, b) => poids(b) - poids(a));
    const keepS = new Set(ranked.slice(0, MAX_SERIES - 1));
    const restS = ranked.slice(MAX_SERIES - 1);
    const other: Serie = {
      name: OTHER,
      data: keys.map((_, i) => sortieTerme(sommeTermes(restS.map((s) => ou0(valN(el(s.data, i))))))),
    };
    out = [...out.filter((s) => keepS.has(s)), other];
    notes.fix(`${restS.length} series folded into '${OTHER}' (8 colours max)`);
  }

  if (out.length === 2 && group === null) {
    const echelle = (s: Serie): number =>
      s.data.reduce<number>((mx, v) => (v === null ? mx : Math.max(mx, Math.abs(val(v)))), 0);
    const a = echelle(el(out, 0));
    const b = echelle(el(out, 1));
    if (a && b && Math.max(a, b) / Math.min(a, b) > 25)
      notes.warn("two series with very different scales: one chart per series would read better");
  }
  return [keys, out, x !== null ? x.name : "", ys.map((c) => c.name)];
}

function abs(x: Nb | null): number | null {
  return x === null ? null : Math.abs(val(x));
}

export function base(spec: Spec): Opt {
  const o: Opt = { animationDuration: 500, animationEasing: "cubicOut" };
  const t = spec.opts.title;
  if (t || spec.opts.subtitle) o["title"] = { text: t, subtext: spec.opts.subtitle, left: 4, top: 2 };
  o["_elpis"] = { kind: spec.kind, unit: spec.opts.unit, table: table(spec) };
  return o;
}

function table(spec: Spec): Opt {
  const names = spec.cols.map((c) => c.name);
  return {
    columns: names,
    rows: spec.rows.slice(0, 500).map((r) => names.map((n) => lg(r, n))),
    truncated: spec.rows.length > 500,
  };
}

export function legend(o: Opt, n: number, force = false): void {
  if (n > 1 || force)
    o["legend"] = {
      type: "scroll",
      top: o["title"] ? 30 : 4,
      left: "center",
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 8,
    };
}

export function grid(o: Opt, bottom = 28): void {
  let top = 34;
  if (o["title"]) top += 26 + (o["title"].subtext ? 16 : 0);
  if (o["legend"]) top += 26;
  o["grid"] = { top, left: 12, right: 20, bottom };
}

export function zoom(o: Opt, n: number, axis = "x", threshold = 30): number {
  if (n <= threshold) return 28;
  const key = axis === "x" ? "xAxisIndex" : "yAxisIndex";
  o["dataZoom"] = [
    { type: "inside", [key]: 0 },
    { type: "slider", [key]: 0, height: 18, bottom: 6, showDetail: false, brushSelect: false },
  ];
  return 56;
}

export function valueLabel(pos = "top"): Opt {
  return { show: true, position: pos, color: "@ink2", fontSize: 11 };
}

export function markLines(spec: Spec, axis: string): Opt | null {
  if (spec.opts.lines.length === 0) return null;
  return {
    symbol: "none",
    silent: false,
    lineStyle: { type: "dashed", color: "@ink2", width: 1.5 },
    label: { position: "insideEndTop", color: "@ink2", fontSize: 11 },
    data: spec.opts.lines.map((ln) => {
      const texte = ln.label || fr(ln.value, spec.opts.unit);
      return { [axis]: fl(ln.value), name: texte, label: { formatter: texte } };
    }),
  };
}

/** `x ** 2` : OverflowError quand le carré d'un flottant fini sort des flottants. */
function carre(x: number): number {
  const r = x * x;
  if (!Number.isFinite(r) && Number.isFinite(x))
    throw new ErreurPython("OverflowError", "(34, 'Numerical result out of range')");
  return r;
}

/** Régression linéaire : pente, ordonnée et R². */
export function regression(
  xs: readonly (number | null)[],
  ys: readonly (number | null)[],
): [number, number, number] | null {
  const pts: [number, number][] = [];
  xs.forEach((a, i) => {
    const b = ys[i];
    if (a !== null && b !== null && b !== undefined) pts.push([a, b]);
  });
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = sommePy(pts.map((p) => p[0])) / n;
  const my = sommePy(pts.map((p) => p[1])) / n;
  const sxx = sommePy(pts.map((p) => carre(p[0] - mx)));
  if (sxx === 0) return null;
  const sxy = sommePy(pts.map((p) => (p[0] - mx) * (p[1] - my)));
  const a = sxy / sxx;
  const b = my - a * mx;
  const ssTot = sommePy(pts.map((p) => carre(p[1] - my))) || 1;
  const ssRes = sommePy(pts.map((p) => carre(p[1] - (a * p[0] + b))));
  return [a, b, 1 - ssRes / ssTot];
}
