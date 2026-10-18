// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/parametres.ts — schémas des paramètres, valeurs par défaut et description des 30 outils `chart_<type>` (port de _chart/__init__.py). */
/** Schéma JSON d'une ligne de données. */
export const ROW_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: { type: ["string", "number", "boolean", "null"] },
};

/** Schéma annoncé au modèle pour chaque paramètre (la validation côté serveur reste permissive). */
export const PARAM_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  data: {
    type: "array",
    items: ROW_SCHEMA,
    minItems: 1,
    description: "Rows of the table: one object per row, same keys in every row, numbers as numbers.",
  },
  title: { type: "string" },
  x: { type: "string", description: "Column for categories, labels or dates." },
  y: {
    type: "array",
    items: { type: "string" },
    description: "Numeric column(s) to plot. Default: every numeric column.",
  },
  group: { type: "string", description: "Column that splits rows into series / colours." },
  size: { type: "string", description: "Numeric column for the bubble size." },
  unit: { type: "string", description: "Unit of the values: €, %, h, kg…" },
  stack: { type: "string", enum: ["none", "stacked", "percent"] },
  horizontal: { type: "boolean" },
  sort: { type: "string", enum: ["none", "asc", "desc"] },
  top: { type: "integer", description: "Keep the N largest categories, fold the rest into « Autres »." },
  show_values: { type: "boolean" },
  highlight: { type: "string", description: "Category to emphasise (others greyed)." },
  lines: {
    type: "array",
    description: "Reference lines (target, threshold).",
    items: {
      type: "object",
      properties: { value: { type: "number" }, label: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  trend: { type: "boolean", description: "Add a linear trend (moving average for candlestick)." },
};

/** Valeur par défaut neutre des paramètres facultatifs (absente de l'appel). */
export const PARAM_DEFAULTS: Readonly<Record<string, unknown>> = {
  title: "",
  x: null,
  y: null,
  group: null,
  size: null,
  unit: "",
  stack: "none",
  horizontal: false,
  sort: "none",
  top: null,
  show_values: false,
  highlight: null,
  lines: null,
  trend: false,
};

/** Type → rôle en une phrase, forme d'une ligne, options propres au type. */
export const PER_TYPE: ReadonlyMap<string, readonly [string, string, readonly string[]]> = new Map([
  [
    "bar",
    [
      "Bar chart: compare values across categories.",
      '{"month":"Jan","sales":12,"costs":8} (one column per series), or long format {"month","region","sales"} + group="region"',
      [
        "x",
        "y",
        "group",
        "unit",
        "stack",
        "horizontal",
        "sort",
        "top",
        "show_values",
        "highlight",
        "lines",
        "trend",
      ],
    ],
  ],
  [
    "line",
    [
      "Line chart: evolution over time or an ordered axis.",
      '{"month":"Jan","sales":12}',
      ["x", "y", "group", "unit", "lines", "trend", "show_values"],
    ],
  ],
  [
    "area",
    [
      "Area chart: evolution of volumes (stack=stacked for parts of a total).",
      '{"month":"Jan","files":40,"backups":55}',
      ["x", "y", "group", "unit", "stack", "lines"],
    ],
  ],
  [
    "stream",
    [
      "Streamgraph: evolution of several categories over dates.",
      '{"month":"2026-01","channel":"Phone","requests":120}',
      ["x", "y", "group", "unit"],
    ],
  ],
  [
    "radar",
    [
      "Radar chart: profile of entities across several criteria.",
      '{"solution":"A","cost":7,"security":9,"support":8}',
      ["x", "y", "group"],
    ],
  ],
  [
    "polar_bar",
    [
      "Polar bar chart: values around a circle (days, hours, directions).",
      '{"day":"Mon","logins":820}',
      ["x", "y", "group", "unit", "stack"],
    ],
  ],
  [
    "waterfall",
    [
      "Waterfall: how a starting value becomes a final one, step by step.",
      '{"step":"Initial budget","amount":1200}, then the deltas {"step":"Hiring","amount":-180}',
      ["x", "y", "unit"],
    ],
  ],
  [
    "pie",
    [
      "Pie chart: share of a whole (up to 8 parts).",
      '{"label":"Windows","value":1240}',
      ["x", "y", "unit", "top", "highlight"],
    ],
  ],
  [
    "donut",
    [
      "Donut chart: share of a whole, total in the centre.",
      '{"label":"Windows","value":1240}',
      ["x", "y", "unit", "top", "highlight"],
    ],
  ],
  [
    "rose",
    [
      "Nightingale rose: shares drawn as radii.",
      '{"cause":"Network","incidents":28}',
      ["x", "y", "unit", "top"],
    ],
  ],
  [
    "treemap",
    [
      "Treemap: sizes of a hierarchy as nested rectangles.",
      '{"direction":"Tech","service":"Infra","budget":820} (one text column per level)',
      ["x", "y", "unit"],
    ],
  ],
  [
    "sunburst",
    [
      "Sunburst: a hierarchy as rings.",
      '{"channel":"Search","source":"Engine A","visits":4200}',
      ["x", "y", "unit"],
    ],
  ],
  [
    "funnel",
    ["Funnel: successive stages of a process.", '{"stage":"Visits","count":12000}', ["x", "y", "unit"]],
  ],
  [
    "histogram",
    [
      "Histogram: distribution of raw values (bins computed for you).",
      '{"age":34}, one row per raw value',
      ["y", "group", "unit"],
    ],
  ],
  [
    "boxplot",
    [
      "Box plot: spread of raw values per group.",
      '{"team":"A","delay":3.2}, one row per raw value',
      ["x", "y", "group", "unit", "lines"],
    ],
  ],
  [
    "scatter",
    [
      "Scatter plot: relation between two measures.",
      '{"surface":45,"price":210}',
      ["x", "y", "group", "unit", "trend", "lines"],
    ],
  ],
  [
    "bubble",
    [
      "Bubble chart: two measures and a size.",
      '{"surface":45,"price":210,"rooms":2}',
      ["x", "y", "group", "size", "unit"],
    ],
  ],
  [
    "heatmap",
    [
      "Heatmap: a value for each pair of two categories.",
      '{"day":"Mon","hour":"9 h","calls":12} (names, not indexes)',
      ["x", "y", "unit"],
    ],
  ],
  [
    "calendar",
    ["Calendar heatmap: one value per day.", '{"date":"2026-01-05","commits":7}', ["x", "y", "unit"]],
  ],
  [
    "parallel",
    [
      "Parallel coordinates: compare items on several measures.",
      '{"model":"A","cores":8,"ram":32,"price":3.2}',
      ["y", "group"],
    ],
  ],
  [
    "sankey",
    [
      "Sankey: flows between stages (no loops).",
      '{"source":"Budget","target":"Salaries","value":780}',
      ["unit"],
    ],
  ],
  [
    "chord",
    ["Chord diagram: exchanges between members.", '{"source":"HR","target":"Finance","value":30}', ["unit"]],
  ],
  ["graph", ["Network graph: links between nodes.", '{"source":"Portal","target":"Directory"}', ["group"]]],
  ["tree", ["Tree / org chart.", '{"name":"Studies","parent":"CIO"}', ["x"]]],
  [
    "gantt",
    [
      "Gantt chart: tasks over time.",
      '{"task":"Pilot","start":"2026-10-05","end":"2026-10-23"}',
      ["x", "group"],
    ],
  ],
  [
    "candlestick",
    [
      "Candlestick: open/high/low/close per date (trend = moving average).",
      '{"date":"2026-03-02","open":101.2,"high":104,"low":100.5,"close":103.1}',
      ["x", "trend"],
    ],
  ],
  [
    "gauge",
    ["Gauge: one value against a maximum.", '{"label":"Availability","value":99.2,"max":100}', ["unit"]],
  ],
  [
    "progress",
    ["Progress bars: done vs total per item.", '{"item":"MFA","done":1210,"total":1500}', ["x", "y", "unit"]],
  ],
  [
    "kpi",
    [
      "Key figures as tiles, with the change vs a previous value.",
      '{"label":"Tickets","value":1284,"previous":1190}',
      ["unit"],
    ],
  ],
  [
    "table",
    ["Table of exact figures (sortable in the UI).", '{"measure":"Latency","value":8,"unit":"ms"}', []],
  ],
]);

/** Description annoncée au modèle pour l'outil d'un type. */
export function toolDescription(kind: string): string {
  const entree = PER_TYPE.get(kind);
  if (entree === undefined) throw new Error(`KeyError: '${kind}'`);
  const [desc, row] = entree;
  return (
    `${desc}\nRows: ${row}.\n` +
    "Returns `ref` (e.g. !a1b2c3d4e5f6): write it alone on its own line where the " +
    "chart goes. `summary` says what was drawn, `fixes` what was understood for you."
  );
}
