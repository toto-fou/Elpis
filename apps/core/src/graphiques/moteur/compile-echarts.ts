// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/compile-echarts.ts — `Spec` → option Apache ECharts (JSON pur, aucune fonction) ; répartition par type (port de _chart/compile_echarts.py). */
import { cBarLine, cStream } from "./compile/cartesien";
import type { Opt } from "./compile/commun";
import { cTree, cTreemap } from "./compile/hierarchie";
import { cFunnel, cGauge, cKpi, cPie, cProgress } from "./compile/parts";
import { cParallel, cPolarBar, cRadar, cTable } from "./compile/polaires";
import { cChord, cGraph, cSankey } from "./compile/reseaux";
import { cBoxplot, cCalendar, cCandlestick, cHeatmap, cHistogram, cScatter } from "./compile/statistiques";
import { cGantt, cWaterfall } from "./compile/temporel";
import type { Spec } from "./spec";

export { fr } from "./compile/commun";
export type { Opt } from "./compile/commun";
export { echapperHtml } from "./compile/temporel";

type Compilateur = (spec: Spec, maintenant: Date) => [Opt, string];

const COMPILERS = new Map<string, Compilateur>([
  ["bar", cBarLine],
  ["line", cBarLine],
  ["area", cBarLine],
  ["stream", cStream],
  ["pie", cPie],
  ["donut", cPie],
  ["rose", cPie],
  ["funnel", cFunnel],
  ["gauge", cGauge],
  ["progress", cProgress],
  ["kpi", cKpi],
  ["treemap", cTreemap],
  ["sunburst", cTreemap],
  ["tree", cTree],
  ["sankey", cSankey],
  ["chord", cChord],
  ["graph", cGraph],
  ["scatter", cScatter],
  ["bubble", cScatter],
  ["heatmap", cHeatmap],
  ["calendar", cCalendar],
  ["boxplot", cBoxplot],
  ["histogram", cHistogram],
  ["candlestick", cCandlestick],
  ["waterfall", cWaterfall],
  ["gantt", cGantt],
  ["parallel", cParallel],
  ["radar", cRadar],
  ["polar_bar", cPolarBar],
  ["table", cTable],
]);

/** Option ECharts et résumé d'une spécification ; `maintenant` fixe l'horloge du trait « aujourd'hui » du Gantt. */
export function compileOption(spec: Spec, maintenant: Date = new Date()): [Opt, string] {
  if (spec.tree !== null && !["treemap", "sunburst", "tree", "table"].includes(spec.kind)) {
    spec.notes.fix(`nested data (children): treemap instead of '${spec.kind}'`);
    spec.kind = "treemap";
  }
  const fn = COMPILERS.get(spec.kind);
  if (fn === undefined) throw new Error(`KeyError: '${spec.kind}'`);
  return fn(spec, maintenant);
}
