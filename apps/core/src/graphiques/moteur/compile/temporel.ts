// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/temporel.ts — cascade et diagramme de Gantt (port de _chart/compile_echarts.py). */
import { arrondiPy, ErreurCle, strPy } from "@elpis/commun";

import { fold, num, toDate } from "../normalise";
import { el, flottant, lg } from "../py";
import type { Terme } from "../py";
import { byName, dims, MAX_SERIES, measures, SpecError } from "../spec";
import type { Spec } from "../spec";
import { base, cartesian, fr, grid, label, MONTHS_FR, ou0, sortieTerme, valN } from "./commun";
import type { Nb, Opt } from "./commun";
import {
  dateIso,
  dureeFois,
  dureeJours,
  ecart,
  jour,
  joursDeDuree,
  mois,
  moins,
  ms,
  naifDepuisIso,
  naifLocal,
  plus,
  UN_JOUR,
} from "../temps";
import type { Duree, Naif } from "../temps";

const TOTAL_NAMES = new Set([
  "total",
  "solde",
  "resultat",
  "net",
  "final",
  "cloture",
  "fin",
  "ending",
  "solde_final",
  "resultat_net",
  "total_general",
  "realise",
  "reel",
  "arrivee",
  "sous_total",
  "subtotal",
  "budget_final",
  "montant_final",
]);
const START_WORDS = ["initial", "depart", "debut", "ouverture", "solde_initial", "report", "base"];
const DELTA_NAMES = new Set([
  "variation",
  "ecart",
  "delta",
  "variance",
  "montant",
  "impact",
  "mouvement",
  "flux",
  "change",
  "diff",
  "difference",
  "evolution",
  "effet",
  "contribution",
]);
const KIND_COL_NAMES = new Set(["type", "nature", "kind", "role", "sens", "categorie_ligne", "genre"]);
const LEVEL_VALUES = new Set([
  "base",
  "total",
  "sous_total",
  "subtotal",
  "solde",
  "initial",
  "depart",
  "debut",
  "fin",
  "final",
  "realise",
  "cloture",
  "start",
  "end",
  "niveau",
  "level",
  "absolute",
]);

/** `max(0.01, 0.005 * abs(x))`. */
function tolerance(x: number): number {
  return Math.max(0.01, 0.005 * Math.abs(x));
}

/** Choisit la colonne d'ÉCARTS : un modèle envoie souvent écarts ET cumuls. */
function waterfallColumns(spec: Spec): void {
  const m = measures(spec.cols);
  const named = m.find((c) => DELTA_NAMES.has(fold(c.name))) ?? null;
  const cand = spec.ys[0] ?? named ?? m[0] ?? null;
  if (cand === null) return;
  const vals = new Map(m.map((c) => [c.name, spec.rows.map((r) => num(lg(r, c.name)))] as const));
  const valeurs = (nom: string): (number | null)[] => {
    const v = vals.get(nom);
    if (v === undefined) throw new ErreurCle(`'${nom}'`);
    return v;
  };
  const cumule = (cum: readonly (number | null)[], d: readonly (number | null)[]): boolean => {
    const pas = cum.slice(1).map((a, i) => [a, cum[i] ?? null, d[i + 1] ?? null] as const);
    const bons = pas.filter(
      ([a, b, c]) => a !== null && b !== null && c !== null && Math.abs(a - (b + c)) <= tolerance(a),
    ).length;
    return pas.length >= 2 && bons >= pas.length - 1 && bons >= 2;
  };
  for (const b of m.filter((o) => o !== cand)) {
    if (cumule(valeurs(cand.name), valeurs(b.name))) {
      spec.notes.fix(`'${cand.name}' is a running total: steps read from '${b.name}'`);
      spec.ys = [b];
      spec.opts.wfCum = valeurs(cand.name);
      return;
    }
    if (cumule(valeurs(b.name), valeurs(cand.name))) {
      spec.ys = [cand];
      spec.opts.wfCum = valeurs(b.name);
      return;
    }
  }
  spec.ys = [cand];
}

function isLevel(spec: Spec, libelle: string, idx: number, n: number, v: number, running: number): boolean {
  const f = fold(libelle);
  const kc = dims(spec.cols).find((c) => KIND_COL_NAMES.has(fold(c.name))) ?? null;
  if (kc !== null && spec.x !== null && kc !== spec.x) {
    const x = spec.x;
    const row = spec.rows.find((r) => label(lg(r, x.name)) === libelle);
    if (row !== undefined && LEVEL_VALUES.has(fold(lg(row, kc.name)))) return true;
  }
  if (TOTAL_NAMES.has(f) || ["total", "solde", "resultat", "sous_total"].some((p) => f.startsWith(p)))
    return true;
  if (idx === 0 && START_WORDS.some((w) => f.includes(w))) return true;
  return idx === n - 1 && idx > 1 && Math.abs(v - running) <= tolerance(running);
}

/** `round(x, 6)` d'un nombre typé : un entier reste entier. */
function arrondi6(t: Terme): Nb {
  return t.f ? sortieTerme(flottant(arrondiPy(t.v, 6))) : t.v;
}

export function cWaterfall(spec: Spec): [Opt, string] {
  waterfallColumns(spec);
  if (spec.x === null) {
    const d = dims(spec.cols).filter((c) => !KIND_COL_NAMES.has(fold(c.name)));
    spec.x = d[0] ?? null;
  }
  const [cats0, series] = cartesian(spec, false);
  let cats = cats0;
  const vals = el(series, 0).data;
  const unit = spec.opts.unit;
  const baseS: unknown[] = [];
  const up: unknown[] = [];
  const down: unknown[] = [];
  const tot: unknown[] = [];
  let running: Terme = flottant(0);
  let totals = 0;
  const cum = spec.opts.wfCum;
  const cumOf = new Map<string, number | null>();
  if (cum !== undefined && spec.x !== null) {
    const x = spec.x;
    spec.rows.forEach((r, i) => {
      if (i < cum.length) cumOf.set(label(lg(r, x.name)), cum[i] ?? null);
    });
  }
  cats.forEach((c, i) => {
    let v: Terme = ou0(valN(vals[i] ?? null));
    const level =
      isLevel(spec, c, i, cats.length, v.v, running.v) || (i === 0 && cum !== undefined && v.v === 0);
    const cumulC = cumOf.get(c);
    if (level && cumulC !== undefined && cumulC !== null) v = flottant(cumulC);
    if (level && i > 0 && Math.abs(v.v - running.v) > tolerance(running.v))
      spec.notes.warn(
        `'${c}' = ${fr(v.v, unit)} but the steps add up to ${fr(running.v, unit)}: check the data`,
      );
    if (level) {
      baseS.push("-");
      up.push("-");
      down.push("-");
      tot.push({ value: sortieTerme(v), label: { formatter: fr(v.v, unit) } });
      running = v;
      totals += i === cats.length - 1 || i > 0 ? 1 : 0;
      return;
    }
    const somme: Terme = { v: running.v + v.v, f: running.f || v.f };
    const lo = somme.v < running.v ? somme : running;
    baseS.push(arrondi6(lo));
    if (v.v >= 0) {
      up.push({ value: sortieTerme(v), label: { formatter: "+" + fr(v.v, unit) } });
      down.push("-");
    } else {
      down.push({ value: sortieTerme({ v: -v.v, f: v.f }), label: { formatter: fr(v.v, unit) } });
      up.push("-");
    }
    tot.push("-");
    running = somme;
  });
  if (!totals || tot[tot.length - 1] === "-") {
    cats = [...cats, "Total"];
    baseS.push("-");
    up.push("-");
    down.push("-");
    tot.push({ value: arrondi6(running), label: { formatter: fr(running.v, unit) } });
    spec.notes.fix("a 'Total' bar was added at the end");
  }
  const o = base(spec);
  const lab = { show: true, position: "top", color: "@ink2", fontSize: 11 };
  o["xAxis"] = {
    type: "category",
    data: cats,
    axisTick: { show: false },
    axisLabel: { interval: 0, width: 96, overflow: "break", lineHeight: 14 },
  };
  o["yAxis"] = { type: "value", _fmt: true };
  const common = { type: "bar", stack: "w", barMaxWidth: 52 };
  o["series"] = [
    {
      ...common,
      name: "_base",
      data: baseS,
      itemStyle: { color: "transparent" },
      emphasis: { disabled: true },
      tooltip: { show: false },
      silent: true,
    },
    {
      ...common,
      name: "Hausse",
      data: up,
      label: lab,
      itemStyle: { color: "@up", borderRadius: [3, 3, 0, 0] },
    },
    {
      ...common,
      name: "Baisse",
      data: down,
      label: { ...lab, position: "bottom" },
      itemStyle: { color: "@down", borderRadius: [3, 3, 0, 0] },
    },
    {
      ...common,
      name: "Total",
      data: tot,
      label: lab,
      itemStyle: { color: "@neutral", borderRadius: [3, 3, 0, 0] },
    },
  ];
  o["tooltip"] = { trigger: "axis", axisPointer: { type: "shadow" } };
  o["legend"] = {
    data: ["Hausse", "Baisse", "Total"],
    top: o["title"] ? 30 : 4,
    icon: "roundRect",
    itemWidth: 12,
    itemHeight: 8,
  };
  grid(o);
  return [o, `waterfall · ${cats.length} steps · final total ${fr(running.v, unit)}`];
}

/** Texte inséré dans un `formatter` d'infobulle ECharts, qui est du HTML : `&`, `<`, `>`, `"` et `'` échappés. */
export function echapperHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface Tache {
  name: string;
  sd: Naif;
  ed: Naif;
  groupe: string;
}

export function cGantt(spec: Spec, maintenant: Date): [Opt, string] {
  const cols = spec.cols;
  const dates = cols.filter((c) => c.kind === "date");
  const st = byName(cols, "start", ["date"]) ?? dates[0] ?? null;
  const en = byName(cols, "end", ["date"]) ?? dates.find((c) => c !== st) ?? null;
  const dur =
    measures(cols).find((c) =>
      ["duree", "duration", "jours", "days", "nb_jours", "duree_jours"].includes(fold(c.name)),
    ) ?? null;
  const task =
    spec.x !== null && spec.x.kind === "text" ? spec.x : (dims(cols).find((c) => c.kind === "text") ?? null);
  if (st === null || task === null || (en === null && dur === null))
    throw new SpecError("gantt: needs a task, a start date and an end date (or a duration in days)", "", [
      { tâche: "Cadrage", début: "2026-01-05", fin: "2026-01-16" },
      { tâche: "Développement", début: "2026-01-19", fin: "2026-03-13" },
    ]);
  const group = spec.group ?? dims(cols).find((c) => c.kind === "text" && c !== task) ?? null;
  const items: Tache[] = [];
  for (const r of spec.rows) {
    const s = toDate(lg(r, st.name));
    if (!s) continue;
    let sd = naifDepuisIso(s.slice(0, 10));
    let ed: Naif;
    const fin = en !== null ? toDate(lg(r, en.name)) : null;
    const duree = dur !== null ? num(lg(r, dur.name)) : null;
    if (en !== null && fin) ed = plus(naifDepuisIso(fin.slice(0, 10)), UN_JOUR);
    else if (dur !== null && duree) ed = plus(sd, dureeJours(duree || 1));
    else continue;
    if (ed <= sd) {
      spec.notes.warn(`'${strPy(lg(r, task.name))}': end before start, swapped`);
      [sd, ed] = [moins(ed, UN_JOUR), plus(sd, UN_JOUR)];
    }
    items.push({
      name: strPy(lg(r, task.name)),
      sd,
      ed,
      groupe: group !== null ? strPy(lg(r, group.name)) : "",
    });
  }
  if (items.length === 0) throw new SpecError("gantt: no readable date (YYYY-MM-DD or DD/MM/YYYY)");
  const tasks = [...new Set(items.map((i) => i.name))];
  const groups = [...new Set(items.map((i) => i.groupe))].slice(0, MAX_SERIES);
  const t0 = items.reduce((mn, i) => (i.sd < mn ? i.sd : mn), el(items, 0).sd);
  const t1 = items.reduce((mx, i) => (i.ed > mx ? i.ed : mx), el(items, 0).ed);
  const marge: Duree = dureeFois(ecart(t1, t0), 0.02);
  const pad: Duree = marge > UN_JOUR ? marge : UN_JOUR;
  const o = base(spec);
  const series: Opt[] = [];
  const indexTache = new Map(tasks.map((t, i) => [t, i] as const));
  for (const g of groups) {
    const baseS: unknown[] = new Array<unknown>(tasks.length).fill("-");
    const span: unknown[] = new Array<unknown>(tasks.length).fill("-");
    for (const { name, sd, ed, groupe } of items) {
      if (groupe !== g) continue;
      const i = indexTache.get(name) ?? 0;
      baseS[i] = ms(sd);
      const days = joursDeDuree(ecart(ed, sd));
      const veille = moins(ed, UN_JOUR);
      span[i] = {
        value: ms(ed) - ms(sd),
        tooltip: {
          formatter:
            `${echapperHtml(name)}<br/>${jour(sd)} ${el(MONTHS_FR, mois(sd) - 1)} → ` +
            `${jour(veille)} ${el(MONTHS_FR, mois(veille) - 1)} (${days} j)`,
        },
      };
    }
    series.push({
      type: "bar",
      stack: `g${g}`,
      data: baseS,
      silent: true,
      itemStyle: { color: "transparent" },
      emphasis: { disabled: true },
      tooltip: { show: false },
      barGap: "-100%",
      name: `_base${g}`,
    });
    series.push({
      type: "bar",
      stack: `g${g}`,
      name: g || "Tâches",
      data: span,
      barGap: "-100%",
      barMaxWidth: 18,
      itemStyle: { borderRadius: 4 },
      emphasis: { focus: "series" },
    });
  }
  const today = naifLocal(maintenant);
  if (t0 <= today && today <= t1)
    el(series, 1)["markLine"] = {
      symbol: "none",
      silent: true,
      lineStyle: { color: "@down", type: "solid", width: 1.5 },
      label: { formatter: "aujourd'hui", color: "@down", fontSize: 10 },
      data: [{ xAxis: ms(today) }],
    };
  o["series"] = series;
  o["xAxis"] = {
    type: "value",
    min: ms(moins(t0, pad)),
    max: ms(plus(t1, pad)),
    position: "top",
    splitLine: { show: true },
    axisLabel: { hideOverlap: true },
    _date: true,
    splitNumber: 6,
    axisLine: { show: false },
    axisTick: { show: false },
  };
  o["yAxis"] = { type: "category", data: tasks, inverse: true, axisTick: { show: false } };
  o["tooltip"] = { trigger: "item" };
  if (!(groups.length === 1 && groups[0] === ""))
    o["legend"] = {
      data: [...groups],
      top: o["title"] ? 30 : 4,
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 8,
    };
  grid(o, 12);
  o["grid"].top += 24;
  o["_elpis"].height = Math.max(260, 90 + 30 * tasks.length);
  return [
    o,
    `gantt · ${tasks.length} tasks · from ${dateIso(t0)} to ${dateIso(moins(t1, UN_JOUR))} ` +
      `(${joursDeDuree(ecart(t1, t0))} days)`,
  ];
}
