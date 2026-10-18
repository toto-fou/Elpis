// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/spec.ts — arguments d'appel (tolérants) → spécification canonique `Spec` (port de _chart/spec.py). */
import { cleHashPy, estDict, formatValeur, strPy, stripPy, veritePy } from "@elpis/commun";

import { fold, matchColumn, Notes, num, profile, resolveKind, toRecords } from "./normalise";
import type { Column } from "./normalise";
import type { GenreColonne } from "./normalise";
import { estDictOuLigne, fl, lg, nombreBrut, paires, sommePy } from "./py";
import type { Ligne } from "./py";

export const MAX_ROWS = 10_000;
/** Au-delà : repli « Autres » (pas de 9e couleur). */
export const MAX_SERIES = 8;

const STACKS = new Set(["none", "stacked", "percent"]);
const SORTS = new Set(["none", "asc", "desc"]);

/** Arguments reconnus et leurs alias (modèles habitués à d'autres outils). */
export const ARG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  type: [
    "type",
    "chart_type",
    "kind",
    "chart",
    "graph_type",
    "charttype",
    "chart_kind",
    "graphique",
    "type_graphique",
  ],
  data: [
    "data",
    "rows",
    "records",
    "values",
    "donnees",
    "dataset",
    "data_table",
    "datatable",
    "table",
    "points",
    "items",
    "lignes",
    "datasets",
  ],
  x: [
    "x",
    "x_field",
    "xfield",
    "category",
    "categories",
    "label_column",
    "labels_column",
    "x_column",
    "dimension",
    "axe_x",
    "abscisse",
    "name_field",
  ],
  y: [
    "y",
    "y_field",
    "yfield",
    "value_field",
    "measure",
    "measures",
    "y_column",
    "y_columns",
    "metrics",
    "axe_y",
    "ordonnee",
    "value",
    "values_field",
  ],
  group: [
    "group",
    "series",
    "serie",
    "color",
    "color_field",
    "colorfield",
    "group_by",
    "groupby",
    "split",
    "legend_field",
    "groupe",
    "couleur",
    "series_field",
  ],
  size: ["size", "size_field", "r", "radius", "taille"],
  title: ["title", "titre", "name", "chart_title"],
  subtitle: ["subtitle", "sous_titre", "subtitle_text", "description"],
  unit: ["unit", "unite", "units", "suffix"],
  stack: ["stack", "stacked", "stacking", "empile", "percent", "normalize"],
  horizontal: ["horizontal", "orientation", "index_axis", "indexaxis"],
  sort: ["sort", "order", "tri", "sort_order"],
  top: ["top", "top_n", "limit", "max_items", "max_categories"],
  show_values: ["show_values", "labels_on", "show_labels", "data_labels", "datalabels", "afficher_valeurs"],
  highlight: ["highlight", "emphasis", "focus", "mettre_en_avant", "surligner"],
  lines: [
    "lines",
    "annotations",
    "reference_lines",
    "ref_lines",
    "marklines",
    "targets",
    "objectifs",
    "seuils",
  ],
  trend: ["trend", "trendline", "trend_line", "regression", "tendance"],
};

const ARG_LOOKUP = new Map<string, string>();
for (const [k, aliases] of Object.entries(ARG_ALIASES)) for (const a of aliases) ARG_LOOKUP.set(a, k);

/** Ligne de repère (cible, seuil). */
export interface LigneRepere {
  value: number;
  label: string;
}

export interface OptionsSpec {
  title: string;
  subtitle: string;
  unit: string;
  stack: string;
  horizontal: boolean;
  sort: string;
  top: number;
  showValues: boolean;
  highlight: string[] | null;
  lines: LigneRepere[];
  trend: boolean;
  smooth: boolean;
  step: boolean;
  /** Cumuls lus dans les données d'une cascade (rempli par le compilateur). */
  wfCum?: (number | null)[];
}

export class Spec {
  kind: string;
  readonly rows: Ligne[];
  readonly cols: Column[];
  readonly notes: Notes;
  x: Column | null = null;
  ys: Column[] = [];
  group: Column | null = null;
  size: Column | null = null;
  levels: Column[] = [];
  readonly opts: OptionsSpec;
  readonly tree: unknown[] | null;
  autoFrom: string | null = null;

  constructor(
    kind: string,
    rows: Ligne[],
    cols: Column[],
    notes: Notes,
    opts: OptionsSpec,
    tree: unknown[] | null,
  ) {
    this.kind = kind;
    this.rows = rows;
    this.cols = cols;
    this.notes = notes;
    this.opts = opts;
    this.tree = tree;
  }
}

export class SpecError extends Error {
  readonly fix: string;
  readonly example: unknown;

  constructor(message: string, fix = "", example: unknown = null) {
    super(message);
    this.name = "SpecError";
    this.fix = fix;
    this.example = example;
  }
}

function boolPy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const n = nombreBrut(v);
  if (n !== null) return n !== 0;
  return ["true", "yes", "oui", "1", "vrai", "on", "y"].includes(fold(v));
}

/** Renomme les arguments alias (`chart_type` → `type`…). */
function canonicalArgs(raw: unknown, notes: Notes): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let labels: unknown = null;
  for (const [k, v0] of estDictOuLigne(raw) ? paires(raw) : []) {
    let v = v0;
    const fk = fold(k);
    if (fk === "labels") {
      labels = v;
      continue;
    }
    const canon = ARG_LOOKUP.get(fk);
    if (canon === undefined) {
      notes.warn(`unknown argument '${k}': ignored`);
      continue;
    }
    if (canon !== k) notes.fix(`argument '${k}' read as '${canon}'`);
    if (canon === "stack" && (fk === "stacked" || fk === "empile")) v = boolPy(v) ? "stacked" : "none";
    else if (canon === "stack" && (fk === "percent" || fk === "normalize"))
      v = boolPy(v) ? "percent" : (out.get("stack") ?? "none");
    else if (canon === "horizontal" && ["orientation", "index_axis", "indexaxis"].includes(fk))
      v = ["horizontal", "y", "h"].includes(fold(v));
    out.set(canon, v);
  }
  if (labels !== null) out.set("_labels", labels);
  return out;
}

export const ROLE_NAMES: Readonly<Record<string, readonly string[]>> = {
  source: ["source", "from", "de", "origine", "depuis", "src", "emetteur", "provenance"],
  target: ["target", "to", "vers", "destination", "dest", "cible", "recepteur"],
  open: ["open", "o", "ouverture", "ouv", "first"],
  high: ["high", "h", "haut", "plus_haut", "max_jour", "hi"],
  low: ["low", "l", "bas", "plus_bas", "min_jour", "lo"],
  close: ["close", "c", "cloture", "fermeture", "dernier", "last"],
  start: ["start", "debut", "date_debut", "begin", "start_date", "commence", "depart", "du"],
  end: ["end", "fin", "date_fin", "finish", "end_date", "echeance", "au", "until"],
  max: ["max", "maximum", "objectif", "cible", "target", "total", "sur", "plafond", "capacite"],
  previous: [
    "previous",
    "precedent",
    "avant",
    "n_1",
    "prev",
    "last_period",
    "periode_precedente",
    "reference",
  ],
  parent: [
    "parent",
    "parent_id",
    "manager",
    "responsable",
    "chef",
    "pere",
    "rattache_a",
    "superieur",
    "reports_to",
  ],
  min_: ["min", "minimum"],
  q1: ["q1", "quartile1", "premier_quartile", "p25"],
  median: ["median", "mediane", "q2", "p50"],
  q3: ["q3", "quartile3", "troisieme_quartile", "p75"],
};

/** Première colonne dont le nom plié désigne le rôle (et dont le genre convient). */
export function byName(
  cols: readonly Column[],
  role: string,
  kinds: readonly GenreColonne[] | null = null,
): Column | null {
  const names = ROLE_NAMES[role] ?? [];
  return cols.find((c) => names.includes(fold(c.name)) && (kinds === null || kinds.includes(c.kind))) ?? null;
}

export function dims(cols: readonly Column[]): Column[] {
  return cols.filter((c) => c.kind === "text" || c.kind === "date");
}

export function measures(cols: readonly Column[]): Column[] {
  return cols.filter((c) => c.kind === "number");
}

/** `str(v or "").strip()`. */
function texteOuVide(v: unknown): string {
  return stripPy(strPy(veritePy(v) ? v : ""));
}

/** Valeur d'un argument absent ou nul (`args.get(nom)`). */
function arg(args: ReadonlyMap<string, unknown>, nom: string): unknown {
  return args.get(nom) ?? null;
}

const STACK_ALIAS = new Map<string, string>([
  ["true", "stacked"],
  ["yes", "stacked"],
  ["oui", "stacked"],
  ["stack", "stacked"],
  ["empile", "stacked"],
  ["false", "none"],
  ["non", "none"],
  ["no", "none"],
  ["100", "percent"],
  ["pourcent", "percent"],
  ["pourcentage", "percent"],
  ["normalized", "percent"],
  ["normalise", "percent"],
]);

const SORT_ALIAS = new Map<string, string>([
  ["ascending", "asc"],
  ["croissant", "asc"],
  ["descending", "desc"],
  ["decroissant", "desc"],
  ["false", "none"],
  ["true", "desc"],
]);

export function buildSpec(rawArgs: unknown): Spec {
  const notes = new Notes();
  const args = canonicalArgs(rawArgs, notes);

  const rows = toRecords(arg(args, "data"), notes, arg(args, "_labels"));
  if (rows.length === 0)
    throw new SpecError("data is empty or unreadable", "data = a list of rows, one per category or point.", [
      { mois: "janv.", ventes: 120 },
      { mois: "févr.", ventes: 135 },
    ]);
  let lignes = rows;
  if (lignes.length > MAX_ROWS) {
    notes.warn(`${lignes.length} rows: only the first ${MAX_ROWS} are kept`);
    lignes = lignes.slice(0, MAX_ROWS);
  }

  if (!lignes.some((r) => [...r.values()].some((v) => v !== null && v !== "")))
    throw new SpecError(
      "data has no values (empty rows)",
      "each row is an object with the SAME keys, all filled",
      [
        { nom: "Débit", valeur: 120, unité: "Mo/s" },
        { nom: "Latence", valeur: 8, unité: "ms" },
      ],
    );

  const tree = lignes.some((r) => [...r.keys()].some((k) => fold(k) === "children")) ? lignes : null;
  const cles0 = [...(lignes[0]?.keys() ?? [])].sort().join("\u0000");
  if (tree === null && lignes.some((r) => [...r.keys()].sort().join("\u0000") !== cles0))
    notes.warn(
      `rows do not all have the same keys (first row: ${[...(lignes[0]?.keys() ?? [])].join(", ")}): columns merged, missing cells left empty`,
    );
  const cols = profile(tree === null ? lignes : flattenTree(lignes));

  const rawType = args.has("type") ? args.get("type") : "auto";
  const [kind0, implicit, note0] = resolveKind(rawType);
  let kind = kind0;
  let note = note0;
  if (kind === null && veritePy(implicit["_ambiguous"])) {
    const barOuHisto = implicit["_ambiguous"] as readonly [string, string];
    kind =
      dims(cols).length === 0 && measures(cols).length === 1 && lignes.length >= 10
        ? barOuHisto[1]
        : barOuHisto[0];
    note = `type '${strPy(rawType)}' read as '${kind}' (from the data)`;
  }
  if (kind === null) {
    notes.warn(`unknown type '${strPy(rawType)}': chosen automatically`);
    kind = "auto";
  }
  notes.fix(note);

  const opts: OptionsSpec = {
    title: texteOuVide(arg(args, "title")),
    subtitle: texteOuVide(arg(args, "subtitle")),
    unit: texteOuVide(arg(args, "unit")),
    stack: "none",
    horizontal: false,
    sort: "none",
    top: 0,
    showValues: false,
    highlight: null,
    lines: [],
    trend: false,
    smooth: false,
    step: false,
  };
  for (const k of ["smooth", "step", "horizontal"] as const)
    if (Object.hasOwn(implicit, k)) opts[k] = implicit[k] as boolean;
  if (veritePy(implicit["stacked"])) opts.stack = veritePy(implicit["percent"]) ? "percent" : "stacked";

  const st = args.get("stack");
  if (st !== undefined && st !== null) {
    let fs = typeof st === "boolean" ? (st ? "stacked" : "none") : fold(st);
    fs = STACK_ALIAS.get(fs) ?? fs;
    if (STACKS.has(fs)) opts.stack = fs;
    else notes.warn(`unknown stack '${strPy(st)}' (none | stacked | percent): ignored`);
  }
  if (args.has("horizontal")) opts.horizontal = boolPy(args.get("horizontal"));
  if (args.has("sort")) {
    let fs = fold(args.get("sort"));
    fs = SORT_ALIAS.get(fs) ?? fs;
    if (SORTS.has(fs)) opts.sort = fs;
    else notes.warn(`unknown sort '${strPy(args.get("sort"))}' (none | asc | desc): ignored`);
  }
  if (args.has("top")) {
    const t = num(args.get("top"));
    opts.top = t !== null && t > 0 ? Math.trunc(t) : 0;
  }
  if (args.has("show_values")) opts.showValues = boolPy(args.get("show_values"));
  const h = arg(args, "highlight");
  if (!(h === null || h === "" || (Array.isArray(h) && h.length === 0))) {
    opts.highlight = Array.isArray(h) ? h.map((x: unknown) => strPy(x)) : [strPy(h)];
  }
  if (veritePy(arg(args, "lines"))) opts.lines = normLines(arg(args, "lines"), notes);
  if (args.has("trend")) opts.trend = boolPy(args.get("trend"));

  const spec = new Spec(kind, lignes, cols, notes, opts, tree);

  const xs = arg(args, "x");
  if (Array.isArray(xs)) {
    spec.levels = xs
      .map((v: unknown) => matchColumn(v, cols, notes, "x"))
      .filter((c): c is Column => c !== null);
    spec.x = spec.levels[0] ?? null;
  } else spec.x = matchColumn(xs, cols, notes, "x");
  let ys = arg(args, "y");
  if (!(ys === null || ys === "" || (Array.isArray(ys) && ys.length === 0))) {
    ys = Array.isArray(ys) ? ys : [ys];
    spec.ys = (ys as unknown[])
      .map((v) => matchColumn(v, cols, notes, "y"))
      .filter((c): c is Column => c !== null);
  }
  spec.group = matchColumn(arg(args, "group"), cols, notes, "group");
  if (spec.group !== null && spec.group.kind === "number") {
    notes.fix(`group '${spec.group.name}' is a numeric column: ignored (one series per numeric column)`);
    spec.group = null;
  }
  spec.size = matchColumn(arg(args, "size"), cols, notes, "size");

  if (spec.kind === "auto") {
    spec.autoFrom = "auto";
    spec.kind = chooseKind(spec);
    notes.fix(`type auto chose '${spec.kind}'`);
  }

  if (!opts.unit) {
    const units = new Set<string>();
    for (const c of spec.ys.length > 0 ? spec.ys : measures(cols)) if (c.unit) units.add(c.unit);
    if (units.size === 1) opts.unit = [...units][0] ?? "";
  }
  const nCoerced = cols.filter((c) => c.kind === "number").reduce((acc, c) => acc + c.nCoerced, 0);
  if (nCoerced > 0) {
    const ex = cols.find((c) => c.kind === "number" && c.example !== null)?.example ?? null;
    const exs = ex === null ? "" : ` ('${strPy(ex[0])}' -> ${formatG(ex[1])})`;
    notes.fix(`${nCoerced} value(s) written as text read as numbers${exs}`);
  }
  return spec;
}

/** `f"{x:g}"`. */
function formatG(x: number): string {
  return formatValeur(fl(x), "g");
}

function normLines(lines: unknown, notes: Notes): LigneRepere[] {
  const out: LigneRepere[] = [];
  const items = Array.isArray(lines) ? lines : [lines];
  for (const it of items as unknown[]) {
    if ((nombreBrut(it) !== null || typeof it === "string") && num(it) !== null) {
      out.push({ value: num(it) ?? 0, label: "" });
    } else if (estDict(it)) {
      let v: number | null = null;
      for (const [k, val] of paires(it))
        if (["value", "y", "valeur", "y_min", "ymin", "at", "seuil"].includes(fold(k))) v = num(val);
      const lab = paires(it).find(([k]) => ["label", "name", "libelle", "text", "nom"].includes(fold(k)));
      if (v !== null) out.push({ value: v, label: lab === undefined ? "" : strPy(lab[1]) });
      else notes.warn("reference line without a value: ignored");
    }
  }
  return out;
}

/** Aplatit une hiérarchie déjà imbriquée (`children`) en lignes. */
function flattenTree(nodes: readonly unknown[]): Ligne[] {
  const out: Ligne[] = [];
  for (const n of nodes) {
    if (!estDictOuLigne(n)) continue;
    const entrees = paires(n);
    out.push(new Map(entrees.filter(([k]) => fold(k) !== "children")));
    const kids = entrees.find(([k]) => fold(k) === "children")?.[1];
    if (Array.isArray(kids)) for (const ligne of flattenTree(kids)) out.push(ligne);
  }
  return out;
}

/** Hiérarchie (chaque enfant sous UN parent, homonymes tolérés) plutôt que croisement ? */
export function isNested(rows: readonly Ligne[], parent: Column, child: Column): boolean {
  const parentsOf = new Map<unknown, Set<unknown>>();
  for (const r of rows) {
    const cle = cleHashPy(lg(r, child.name));
    const ensemble = parentsOf.get(cle) ?? new Set<unknown>();
    parentsOf.set(cle, ensemble);
    ensemble.add(cleHashPy(lg(r, parent.name)));
  }
  const nPar = new Set(rows.map((r) => cleHashPy(lg(r, parent.name)))).size;
  if (nPar < 2 || parentsOf.size <= nPar) return false;
  const shared = [...parentsOf.values()].filter((ps) => ps.size > 1).length;
  return shared / parentsOf.size < 0.5;
}

/** Type « auto » : choix prudent d'après la forme des données. */
export function chooseKind(spec: Spec): string {
  const { cols, rows } = spec;
  if (spec.tree !== null)
    return cols.some((c) => ["value", "valeur"].includes(fold(c.name))) ? "treemap" : "tree";
  const d = dims(cols);
  const m = measures(cols);
  if (byName(cols, "open") && byName(cols, "close") && byName(cols, "high")) return "candlestick";
  if (byName(cols, "source", ["text"]) && byName(cols, "target", ["text"])) return "sankey";
  if (byName(cols, "parent")) return "tree";
  if (byName(cols, "start", ["date"]) && byName(cols, "end", ["date"])) return "gantt";
  if (rows.length === 1 && m.length > 0) return byName(cols, "max", ["number"]) ? "gauge" : "kpi";
  const d0 = d[0];
  const m0 = m[0];
  if (d0 === undefined) {
    if (m.length === 1) return "histogram";
    return m.length >= 3 ? "bubble" : "scatter";
  }
  const d1 = d[1];
  if (d1 !== undefined && m.length >= 1 && isNested(rows, d0, d1)) return "treemap";
  if (d0.dates || d0.months) return "line";
  if (m0 !== undefined && m.length === 1 && d.length === 1 && rows.length >= 2 && rows.length <= 6) {
    const vals = rows.map((r) => num(lg(r, m0.name)));
    if (vals.every((v) => v !== null && v >= 0)) {
      const s = sommePy(vals as number[]);
      if (m0.unit === "%" || (s >= 98 && s <= 102)) return "donut";
    }
  }
  return "bar";
}
