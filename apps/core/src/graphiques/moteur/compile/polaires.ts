// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/polaires.ts — coordonnées parallèles, radar, barres polaires et tableau (port de _chart/compile_echarts.py). */
import { cleHashPy, strPy } from "@elpis/commun";

import { num } from "../normalise";
import { fl, lg } from "../py";
import { dims, MAX_SERIES, measures, SpecError } from "../spec";
import type { Spec } from "../spec";
import { base, cartesian, label, legend, niceCeil, val } from "./commun";
import type { Nb, Opt, Serie } from "./commun";

export function cParallel(spec: Spec): [Opt, string] {
  const m = spec.ys.length > 0 ? spec.ys : measures(spec.cols);
  if (m.length < 2)
    throw new SpecError("parallel: needs at least two numeric columns", "", [
      { modèle: "A", prix: 21000, conso: 5.2, puissance: 110 },
    ]);
  const d = dims(spec.cols);
  const d0 = d[0];
  const group =
    spec.group ??
    (d0 !== undefined && new Set(spec.rows.map((r) => cleHashPy(lg(r, d0.name)))).size <= MAX_SERIES
      ? d0
      : null);
  const o = base(spec);
  o["parallelAxis"] = m.map((c, i) => ({
    dim: i,
    name: c.name,
    nameTextStyle: { color: "@ink2" },
    _fmt: true,
  }));
  o["parallel"] = {
    left: 40,
    right: 60,
    top: o["title"] ? 70 : 46,
    bottom: 30,
    parallelAxisDefault: {
      nameLocation: "end",
      nameGap: 14,
      axisLine: { lineStyle: { color: "@grid" } },
      axisLabel: { color: "@ink2" },
      splitLine: { show: false },
    },
  };
  const groups = new Map<string, unknown[][]>();
  for (const r of spec.rows) {
    const g = group !== null ? strPy(lg(r, group.name)) : "lignes";
    const ligne = m.map((c) => {
      const v = num(lg(r, c.name));
      return v === null ? null : fl(v);
    });
    const lignes = groups.get(g);
    if (lignes === undefined) groups.set(g, [ligne]);
    else lignes.push(ligne);
  }
  o["series"] = [...groups].map(([g, lignes]) => ({
    type: "parallel",
    name: g,
    data: lignes,
    smooth: false,
    lineStyle: { width: 1.6, opacity: 0.55 },
    emphasis: { lineStyle: { width: 3, opacity: 1 } },
  }));
  legend(o, groups.size);
  if (o["legend"]) {
    delete o["legend"].top;
    o["legend"].bottom = 0;
    o["parallel"].bottom = 40;
  }
  return [o, `parallel · ${spec.rows.length} rows · ${m.length} axes`];
}

export function cRadar(spec: Spec): [Opt, string] {
  const d = dims(spec.cols);
  const m = measures(spec.cols);
  const ys = spec.ys.length > 0 ? spec.ys : m;
  let axes: string[];
  let series: Serie[];
  if (ys.length >= 3 && spec.rows.length < ys.length && spec.group === null) {
    const ent = spec.x ?? d[0] ?? null;
    axes = ys.map((c) => c.name);
    series = spec.rows.map((r, i) => ({
      name: ent !== null ? label(lg(r, ent.name)) : `#${i + 1}`,
      data: ys.map((c) => {
        const v = num(lg(r, c.name));
        return v === null ? null : fl(v);
      }),
    }));
    spec.notes.fix("one row per entity: axes = numeric columns");
  } else [axes, series] = cartesian(spec);
  const valeurs = series.flatMap((s) => s.data.filter((v): v is Nb => v !== null).map(val));
  const mx = valeurs.length > 0 ? valeurs.reduce((a, b) => (b > a ? b : a)) : 1;
  const top = niceCeil(mx).sortie;
  const o = base(spec);
  o["radar"] = {
    indicator: axes.map((a) => ({ name: a, max: top })),
    radius: "62%",
    center: ["50%", "57%"],
    splitNumber: 4,
    axisName: { color: "@ink2", fontSize: 12 },
    splitLine: { lineStyle: { color: "@grid" } },
    splitArea: { show: false },
    axisLine: { lineStyle: { color: "@grid" } },
  };
  o["series"] = [
    {
      type: "radar",
      symbolSize: 5,
      data: series.slice(0, MAX_SERIES).map((s) => ({
        name: s.name,
        value: s.data,
        areaStyle: { opacity: 0.12 },
        lineStyle: { width: 2 },
      })),
      emphasis: { focus: "self" },
    },
  ];
  o["tooltip"] = { trigger: "item" };
  legend(o, series.length);
  return [o, `radar · ${axes.length} axes · ${series.length} series`];
}

export function cPolarBar(spec: Spec): [Opt, string] {
  const [cats, series] = cartesian(spec);
  const o = base(spec);
  o["polar"] = { radius: ["14%", "74%"], center: ["50%", "56%"] };
  o["angleAxis"] = {
    type: "category",
    data: cats,
    startAngle: 90,
    axisLine: { lineStyle: { color: "@grid" } },
    axisTick: { show: false },
    axisLabel: { color: "@ink2" },
  };
  o["radiusAxis"] = {
    axisLabel: { show: false },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: "@grid" } },
  };
  o["series"] = series.map((s) => ({
    type: "bar",
    name: s.name,
    data: s.data,
    coordinateSystem: "polar",
    stack: spec.opts.stack !== "none" ? "p" : null,
    roundCap: true,
    emphasis: { focus: "series" },
  }));
  o["tooltip"] = { trigger: "item" };
  legend(o, series.length);
  return [o, `polar_bar · ${cats.length} categories · ${series.length} series`];
}

export function cTable(spec: Spec): [Opt, string] {
  const o = base(spec);
  o["_elpis"].render = "table";
  return [o, `table · ${spec.rows.length} rows · ${spec.cols.length} columns`];
}
