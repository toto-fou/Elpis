// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/reseaux.ts — flux, cordes et graphes de liens (port de _chart/compile_echarts.py). */
import { arrondiPy, strPy } from "@elpis/commun";

import { num } from "../normalise";
import { el, fl, lg, maxListe } from "../py";
import { byName, dims, MAX_SERIES, measures, SpecError } from "../spec";
import type { Spec } from "../spec";
import { base, legend } from "./commun";
import type { Opt } from "./commun";

type Lien = [string, string, number];

function edges(spec: Spec): [Lien[], string, string] {
  const cols = spec.cols;
  const d = dims(cols);
  const src =
    byName(cols, "source", ["text", "date"]) ??
    (spec.x !== null && d.includes(spec.x) ? spec.x : null) ??
    d[0] ??
    null;
  const tgt = byName(cols, "target", ["text", "date"]) ?? d.find((c) => c !== src) ?? null;
  if (src === null || tgt === null || src === tgt)
    throw new SpecError(
      `${spec.kind}: needs two name columns (source, target); columns received: ${cols.map((c) => c.name).join(", ")}`,
      "one row per link: source, target, value",
      [
        { source: "Budget", target: "Salaires", value: 60 },
        { source: "Budget", target: "Locaux", value: 25 },
      ],
    );
  const vcol = (spec.ys.length > 0 ? spec.ys : measures(cols))[0] ?? null;
  const agg = new Map<string, Lien>();
  let selfLoops = 0;
  for (const r of spec.rows) {
    const [a0, b0] = [lg(r, src.name), lg(r, tgt.name)];
    if (a0 === null || a0 === "" || b0 === null || b0 === "") continue;
    const [a, b] = [strPy(a0), strPy(b0)];
    if (a === b) {
      selfLoops += 1;
      continue;
    }
    const v = vcol !== null ? num(lg(r, vcol.name)) : 1;
    if (v === null || v <= 0) continue;
    const cle = JSON.stringify([a, b]);
    const lien = agg.get(cle);
    if (lien === undefined) agg.set(cle, [a, b, 0 + v]);
    else lien[2] = lien[2] + v;
  }
  if (selfLoops > 0) spec.notes.warn(`${selfLoops} self-link(s) ignored`);
  return [[...agg.values()], src.name, tgt.name];
}

function hasCycle(liens: readonly Lien[]): boolean {
  const g = new Map<string, string[]>();
  for (const [a, b] of liens) {
    const suivants = g.get(a);
    if (suivants === undefined) g.set(a, [b]);
    else suivants.push(b);
  }
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    state.set(n, 1);
    for (const m of g.get(n) ?? []) {
      if (state.get(m) === 1 || (state.get(m) === undefined && visit(m))) return true;
    }
    state.set(n, 2);
    return false;
  };
  return [...g.keys()].some((n) => state.get(n) === undefined && visit(n));
}

function noeuds(liens: readonly Lien[]): string[] {
  return [...new Set([...liens.map((e) => e[0]), ...liens.map((e) => e[1])])];
}

export function cSankey(spec: Spec): [Opt, string] {
  const [liens, s, t] = edges(spec);
  if (hasCycle(liens)) {
    spec.notes.fix("the flows form a loop (A -> B -> A): impossible in a sankey, drawn as a network");
    spec.kind = "graph";
    return cGraph(spec);
  }
  const nodes = noeuds(liens);
  const o = base(spec);
  o["series"] = [
    {
      type: "sankey",
      data: nodes.map((n) => ({ name: n })),
      links: liens.map(([a, b, v]) => ({ source: a, target: b, value: fl(v) })),
      top: o["title"] ? 60 : 16,
      bottom: 16,
      left: 8,
      right: 110,
      nodeWidth: 14,
      nodeGap: 12,
      layoutIterations: 64,
      draggable: true,
      emphasis: { focus: "adjacency" },
      lineStyle: { color: "gradient", curveness: 0.5, opacity: 0.32 },
      itemStyle: { borderWidth: 0, borderRadius: 2 },
      label: { color: "@ink", fontSize: 12 },
    },
  ];
  o["tooltip"] = { trigger: "item" };
  return [o, `sankey · ${nodes.length} nodes · ${liens.length} flows · ${s} -> ${t}`];
}

export function cChord(spec: Spec): [Opt, string] {
  const [liens] = edges(spec);
  const nodes = noeuds(liens);
  const o = base(spec);
  o["series"] = [
    {
      type: "chord",
      data: nodes.map((n) => ({ name: n })),
      links: liens.map(([a, b, v]) => ({ source: a, target: b, value: fl(v) })),
      center: ["50%", "55%"],
      radius: ["70%", "80%"],
      padAngle: 3,
      minAngle: 6,
      clockwise: true,
      lineStyle: { color: "gradient", opacity: 0.45 },
      itemStyle: { borderColor: "@surface", borderWidth: 1 },
      emphasis: { focus: "adjacency" },
      label: { show: true, color: "@ink", fontSize: 12, distance: 6 },
    },
  ];
  o["tooltip"] = { trigger: "item" };
  return [o, `chord · ${nodes.length} nodes · ${liens.length} links`];
}

export function cGraph(spec: Spec): [Opt, string] {
  const [liens] = edges(spec);
  const deg = new Map<string, number>();
  for (const [a, b] of liens) {
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
  }
  const nodes = noeuds(liens);
  const catOf = new Map<string, string>();
  let cats: string[] = [];
  if (spec.group !== null) {
    const srcCol = byName(spec.cols, "source", ["text", "date"]) ?? el(dims(spec.cols), 0);
    const tgtCol =
      byName(spec.cols, "target", ["text", "date"]) ??
      dims(spec.cols).find((c) => c !== srcCol && c !== spec.group) ??
      null;
    for (const col of [srcCol, tgtCol]) {
      for (const r of spec.rows) {
        const g = lg(r, spec.group.name);
        if (col !== null && g !== null && g !== "") {
          const cle = strPy(lg(r, col.name));
          if (!catOf.has(cle)) catOf.set(cle, strPy(g));
        }
      }
    }
    cats = [...new Set(catOf.values())].slice(0, MAX_SERIES);
  }
  const mx = deg.size > 0 ? maxListe([...deg.values()]) : 1;
  const vmax = liens.length > 0 ? maxListe(liens.map((e) => e[2])) : 1;
  const o = base(spec);
  const data: Opt[] = nodes.map((n) => {
    const it: Opt = {
      name: n,
      symbolSize: fl(arrondiPy(10 + 26 * Math.sqrt((deg.get(n) ?? 0) / mx), 1)),
      value: fl(deg.get(n) ?? 0),
    };
    if (cats.length > 0) {
      const c = catOf.get(n);
      it["category"] = c !== undefined && cats.includes(c) ? cats.indexOf(c) : cats.length;
    }
    return it;
  });
  const ser: Opt = {
    type: "graph",
    layout: "force",
    data,
    links: liens.map(([a, b, v]) => ({
      source: a,
      target: b,
      value: fl(v),
      lineStyle: { width: fl(arrondiPy(1 + (4 * v) / vmax, 2)) },
    })),
    roam: true,
    draggable: true,
    force: { repulsion: 220, edgeLength: [40, 110], gravity: 0.16 },
    edgeSymbol: ["none", "arrow"],
    edgeSymbolSize: 6,
    label: { show: nodes.length <= 60, position: "right", fontSize: 11, color: "@ink" },
    lineStyle: { color: "source", opacity: 0.45, curveness: 0.12 },
    emphasis: { focus: "adjacency", lineStyle: { width: 3, opacity: 0.9 } },
    top: o["title"] ? 60 : 20,
  };
  if (cats.length > 0) {
    ser["categories"] = [
      ...cats.map((c) => ({ name: c })),
      ...(data.some((d) => d["category"] === cats.length)
        ? [{ name: "autre", itemStyle: { color: "@muted" } }]
        : []),
    ];
    legend(o, cats.length, true);
  }
  o["series"] = [ser];
  o["tooltip"] = { trigger: "item" };
  const hubs = [...deg].sort((p, q) => q[1] - p[1]).slice(0, 3);
  return [
    o,
    `graph · ${nodes.length} nodes · ${liens.length} links · most connected: ` +
      hubs.map(([k, v]) => `${k} (${Math.trunc(v)})`).join(", "),
  ];
}
