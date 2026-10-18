// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile/hierarchie.ts — treemap, sunburst et arbre (port de _chart/compile_echarts.py). */
import { strPy } from "@elpis/commun";

import { fold, num } from "../normalise";
import { el, entier, estDictOuLigne, flottant, lg, paires, sommeTermes } from "../py";
import type { Terme } from "../py";
import { byName, dims, measures, SpecError } from "../spec";
import type { Spec } from "../spec";
import { base, fr, ou0, sortieTerme } from "./commun";
import type { Opt } from "./commun";
import type { Column } from "../normalise";

/** Nœud d'une hiérarchie : `value` absent (undefined), `None` (null) ou un nombre Python typé. */
interface Noeud {
  name: string;
  children?: Noeud[];
  value?: Terme | null;
}

/** `x or 0` sur la valeur d'un nœud. */
function ouZero(v: Terme | null | undefined): Terme {
  return v === null || v === undefined || v.v === 0 ? entier(0) : v;
}

/** `a + b` de Python sur deux nombres typés. */
function plus(a: Terme, b: Terme): Terme {
  return { v: a.v + b.v, f: a.f || b.f };
}

function terme(x: number | null): Terme | null {
  return x === null ? null : flottant(x);
}

function nest(spec: Spec, levels: readonly Column[], valueCol: Column | null): Noeud[] {
  interface Interne {
    name: string;
    children: Map<string, Interne>;
    value: Terme | null;
  }
  const root: Interne = { name: "", children: new Map(), value: null };
  for (const r of spec.rows) {
    let node = root;
    for (const lv of levels) {
      const key = lg(r, lv.name);
      if (key === null || key === "") break;
      const nom = strPy(key);
      let enfant = node.children.get(nom);
      if (enfant === undefined) {
        enfant = { name: nom, children: new Map(), value: flottant(0) };
        node.children.set(nom, enfant);
      }
      node = enfant;
    }
    const v = valueCol !== null ? num(lg(r, valueCol.name)) : 1;
    node.value = plus(ouZero(node.value), ou0(v));
  }
  const conv = (n: Interne): Noeud => {
    const kids = [...n.children.values()].map(conv);
    const out: Noeud = { name: n.name };
    if (kids.length > 0) {
      out.children = kids;
      out.value = sommeTermes(kids.map((k) => k.value ?? entier(0)));
    } else out.value = n.value ?? entier(0);
    return out;
  };
  return [...root.children.values()].map(conv);
}

function depth(nodes: readonly Noeud[]): number {
  if (nodes.length === 0) return 0;
  const profondeurs = nodes
    .filter((n) => n.children && n.children.length > 0)
    .map((n) => depth(n.children ?? []));
  return 1 + profondeurs.reduce((m, p) => Math.max(m, p), 0);
}

function norm(n: unknown): Noeud {
  const entrees = paires(n as Record<string, unknown>);
  const nomEntree = entrees.find(([k]) => ["name", "nom", "label", "libelle"].includes(fold(k)));
  const valEntree = entrees.find(([k]) => ["value", "valeur", "v", "size"].includes(fold(k)));
  const val = valEntree === undefined ? null : num(valEntree[1]);
  const kids = entrees.find(([k]) => fold(k) === "children")?.[1];
  const out: Noeud = { name: nomEntree === undefined ? "" : strPy(nomEntree[1]) };
  if (Array.isArray(kids) && kids.length > 0) {
    out.children = kids.filter((k: unknown) => estDictOuLigne(k)).map(norm);
    out.value = sommeTermes(out.children.map((c) => ouZero(c.value)));
  } else out.value = val !== null ? flottant(val) : entier(1);
  return out;
}

function treeFromRows(spec: Spec): [Noeud[], number] {
  if (spec.tree !== null) {
    const nodes = spec.tree.map(norm);
    return [nodes, depth(nodes)];
  }
  const parent = byName(spec.cols, "parent");
  if (parent !== null) {
    const d = dims(spec.cols).filter((c) => c !== parent);
    const nameCol = spec.x !== null && spec.x !== parent ? spec.x : (d[0] ?? null);
    if (nameCol === null)
      throw new SpecError("tree: needs a name column and a parent column", "", [
        { nom: "Direction", parent: "" },
        { nom: "Ventes", parent: "Direction" },
      ]);
    const vcol = (spec.ys.length > 0 ? spec.ys : measures(spec.cols))[0] ?? null;
    interface Brut {
      name: string;
      children: Brut[];
      p: unknown;
      value: Terme | null;
    }
    const nodes = new Map<string, Brut>();
    const doublons = new Set<string>();
    for (const r of spec.rows) {
      const n = strPy(lg(r, nameCol.name));
      if (nodes.has(n)) doublons.add(n);
      nodes.set(n, {
        name: n,
        children: [],
        p: lg(r, parent.name),
        value: vcol !== null ? terme(num(lg(r, vcol.name))) : entier(1),
      });
    }
    const roots: Brut[] = [];
    for (const n of nodes.values()) {
      const p = n.p;
      const parentNode = p !== null && p !== "" ? nodes.get(strPy(p)) : undefined;
      if (parentNode !== undefined && strPy(p) !== n.name) parentNode.children.push(n);
      else roots.push(n);
    }
    if (doublons.size > 0)
      spec.notes.warn(
        `duplicate node name(s) merged, last row wins: ${[...doublons].slice(0, 5).join(", ")}`,
      );
    const atteints = new Set<Brut>();
    const parcourir = (n: Brut): void => {
      if (atteints.has(n)) return;
      atteints.add(n);
      n.children.forEach(parcourir);
    };
    roots.forEach(parcourir);
    const perdus = [...nodes.values()].filter((n) => !atteints.has(n));
    if (perdus.length > 0)
      spec.notes.warn(
        `${perdus.length} node(s) not drawn (cycle in the parents): ${perdus
          .slice(0, 5)
          .map((n) => n.name)
          .join(", ")}`,
      );
    const clean = (n: Brut): Noeud => {
      const out: Noeud = { name: n.name };
      if (n.children.length > 0) out.children = n.children.map(clean);
      out.value = n.value;
      return out;
    };
    const resultat = roots.map(clean);
    return [resultat, depth(resultat)];
  }
  const levels = spec.levels.length > 0 ? spec.levels : dims(spec.cols);
  const vcol = (spec.ys.length > 0 ? spec.ys : measures(spec.cols))[0] ?? null;
  if (levels.length === 0)
    throw new SpecError("hierarchy: needs at least one text column (one level)", "", [
      { région: "Nord", ville: "Lille", ventes: 120 },
    ]);
  if (levels.length > 1 && spec.levels.length === 0)
    spec.notes.fix("levels: " + levels.map((c) => c.name).join(" > "));
  return [nest(spec, levels, vcol), levels.length];
}

/** Nœud prêt à écrire : `name`, `children`, `value`. */
function sortieNoeud(n: Noeud): Opt {
  const out: Opt = { name: n.name };
  if (n.children !== undefined) out["children"] = n.children.map(sortieNoeud);
  if (n.value !== undefined) out["value"] = n.value === null ? null : sortieTerme(n.value);
  return out;
}

export function cTreemap(spec: Spec): [Opt, string] {
  const [nodes, profondeur] = treeFromRows(spec);
  const o = base(spec);
  const total = sommeTermes(nodes.map((n) => ouZero(n.value)));
  if (spec.kind === "treemap") {
    o["series"] = [
      {
        type: "treemap",
        data: nodes.map(sortieNoeud),
        roam: false,
        nodeClick: "zoomToNode",
        top: o["title"] ? 64 : 10,
        bottom: 34,
        left: 4,
        right: 4,
        breadcrumb: {
          show: profondeur > 1,
          bottom: 4,
          itemStyle: { color: "@track", textStyle: { color: "@ink" } },
        },
        label: { show: true, formatter: "{b}", fontSize: 12 },
        upperLabel: { show: profondeur > 1, height: 20, color: "#ffffff" },
        itemStyle: { borderColor: "@surface", borderWidth: 2, gapWidth: 2 },
        levels: [
          { itemStyle: { borderColor: "@surface", borderWidth: 3, gapWidth: 3 } },
          {
            colorSaturation: [0.35, 0.6],
            itemStyle: { borderColorSaturation: 0.65, gapWidth: 1, borderWidth: 1 },
          },
        ],
      },
    ];
  } else {
    o["series"] = [
      {
        type: "sunburst",
        data: nodes.map(sortieNoeud),
        radius: ["12%", "92%"],
        center: ["50%", "55%"],
        sort: null,
        nodeClick: "rootToNode",
        emphasis: { focus: "ancestor" },
        itemStyle: { borderColor: "@surface", borderWidth: 2 },
        label: { rotate: "radial", minAngle: 8, fontSize: 11, color: "#ffffff" },
        levels: [
          {},
          { r0: "12%", r: "45%" },
          { r0: "45%", r: "72%" },
          { r0: "72%", r: "92%", label: { position: "outside", color: "@ink2", rotate: "tangential" } },
        ].slice(0, profondeur + 1),
      },
    ];
  }
  o["tooltip"] = { trigger: "item" };
  return [
    o,
    `${spec.kind} · ${nodes.length} groups · ${profondeur} level(s) · total ${fr(total.v, spec.opts.unit)}`,
  ];
}

export function cTree(spec: Spec): [Opt, string] {
  const [nodes, profondeur] = treeFromRows(spec);
  const root: Noeud =
    nodes.length === 1 ? el(nodes, 0) : { name: spec.opts.title || "Racine", children: nodes };
  const count = (n: Noeud): number => 1 + (n.children ?? []).reduce((acc, c) => acc + count(c), 0);
  const n = count(root);
  const o = base(spec);
  const orient = "LR";
  o["series"] = [
    {
      type: "tree",
      data: [sortieNoeud(root)],
      orient,
      roam: true,
      top: o["title"] ? 60 : 30,
      bottom: 30,
      left: 90,
      right: 160,
      symbol: "circle",
      symbolSize: 9,
      initialTreeDepth: 3,
      expandAndCollapse: true,
      itemStyle: { color: "@series1", borderColor: "@series1" },
      lineStyle: { color: "@grid", width: 1.5, curveness: 0.5 },
      label: { position: "left", verticalAlign: "middle", align: "right", fontSize: 12, color: "@ink" },
      leaves: { label: { position: "right", align: "left" } },
      animationDurationUpdate: 500,
    },
  ];
  o["tooltip"] = { trigger: "item", triggerOn: "mousemove" };
  return [o, `tree · ${n} nodes · depth ${profondeur}`];
}
