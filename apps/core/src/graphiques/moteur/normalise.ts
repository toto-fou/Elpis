// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/normalise.ts — lecture tolérante d'un appel d'outil « chart » (types, nombres, dates, lignes, colonnes ; port de _chart/normalise.py). */
import {
  BLANC_PY,
  entierOuNulPy,
  ErreurJsonPy,
  ErreurLecturePy,
  ErreurPython,
  estDict,
  floatPy,
  lowerPy,
  lstripPy,
  pyJsonLoads,
  sansAccentsPy,
  splitlinesPy,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { getCloseMatches } from "./difflib";
import { dateValide } from "./temps";
import { el, enFlottant, estDictOuLigne, estNombrePy, lg, maxListe, nombreBrut, paires } from "./py";
import type { Ligne } from "./py";

/** « Polar Area », « polarArea », « polar-area » → « polar_area ». */
export function fold(s: unknown): string {
  const texte = strPy(veritePy(s) ? s : "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return lowerPy(sansAccentsPy(texte))
    .replace(/[^0-9a-zA-Z]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Clé = type canonique ; valeurs = alias déjà « pliés ». */
export const KINDS: Readonly<Record<string, readonly string[]>> = {
  auto: ["auto", "chart", "graph_auto", "graphique", "graphe_auto", "default", "any"],
  bar: [
    "bar",
    "bars",
    "barre",
    "barres",
    "column",
    "columns",
    "colonne",
    "colonnes",
    "baton",
    "batons",
    "bar_chart",
    "barchart",
    "diagramme_en_barres",
    "diagramme_barres",
    "grouped_bar",
    "histo",
    "vertical_bar",
  ],
  line: [
    "line",
    "lines",
    "ligne",
    "lignes",
    "courbe",
    "courbes",
    "line_chart",
    "linechart",
    "trend",
    "tendance",
    "evolution",
    "time_series",
    "serie_temporelle",
  ],
  area: ["area", "aire", "aires", "surface", "area_chart", "zone"],
  pie: [
    "pie",
    "camembert",
    "secteur",
    "secteurs",
    "circulaire",
    "diagramme_circulaire",
    "pie_chart",
    "piechart",
    "tarte",
    "pie_of_pie",
    "bar_of_pie",
  ],
  donut: ["donut", "doughnut", "anneau", "beignet", "ring", "donut_chart"],
  rose: ["rose", "nightingale", "polar_area", "polararea", "rose_chart", "aire_polaire"],
  scatter: [
    "scatter",
    "nuage",
    "nuage_de_points",
    "points",
    "dispersion",
    "xy",
    "correlation",
    "scatter_plot",
    "scatterplot",
  ],
  bubble: ["bubble", "bulle", "bulles", "bubble_chart"],
  heatmap: ["heatmap", "heat_map", "carte_de_chaleur", "chaleur", "matrix", "matrice", "carte_thermique"],
  calendar: ["calendar", "calendrier", "calendar_heatmap", "contributions"],
  treemap: ["treemap", "tree_map", "carte_proportionnelle", "mosaique", "rectangles"],
  sunburst: ["sunburst", "soleil", "rayons_de_soleil", "anneaux", "multi_niveaux"],
  sankey: ["sankey", "flux", "flow", "flows", "alluvial", "diagramme_de_flux"],
  chord: ["chord", "corde", "cordes", "diagramme_d_accords", "accords"],
  graph: ["graph", "network", "reseau", "graphe", "force", "noeuds", "relations", "liens", "network_graph"],
  tree: ["tree", "arbre", "organigramme", "org_chart", "orgchart", "hierarchie", "hierarchy", "arborescence"],
  funnel: ["funnel", "entonnoir", "tunnel", "conversion", "funnel_chart"],
  gauge: ["gauge", "jauge", "compteur", "speedometer", "cadran"],
  progress: ["progress", "progression", "avancement", "barre_de_progression", "progress_bar"],
  kpi: [
    "kpi",
    "stat",
    "stats",
    "chiffre_cle",
    "chiffres_cles",
    "indicateur",
    "indicateurs",
    "tuile",
    "big_number",
    "metric",
    "metrics",
  ],
  radar: ["radar", "araignee", "toile", "toile_d_araignee", "spider", "web"],
  polar_bar: ["polar_bar", "barres_polaires", "radial_bar", "radial", "barre_radiale"],
  boxplot: ["boxplot", "box_plot", "box", "boite_a_moustaches", "moustaches", "violin", "violon", "boites"],
  histogram: ["histogram", "distribution", "repartition", "frequences", "frequence"],
  candlestick: [
    "candlestick",
    "candle",
    "chandelier",
    "chandeliers",
    "bougie",
    "bougies",
    "ohlc",
    "boursier",
    "cours",
    "japanese_candlestick",
  ],
  waterfall: ["waterfall", "cascade", "chute_d_eau", "pont", "bridge", "waterfall_chart"],
  gantt: [
    "gantt",
    "planning",
    "diagramme_de_gantt",
    "timeline",
    "chronologie",
    "frise",
    "roadmap",
    "calendrier_projet",
  ],
  parallel: ["parallel", "parallele", "paralleles", "coordonnees_paralleles", "parallel_coordinates"],
  stream: ["stream", "streamgraph", "theme_river", "themeriver", "riviere", "flot"],
  table: ["table", "tableau", "grid", "grille", "datatable"],
};

/** Alias qui portent une option en plus du type. */
export const ALIAS_OPTIONS = new Map<string, Record<string, unknown>>([
  ["stacked_bar", { _kind: "bar", stacked: true }],
  ["barres_empilees", { _kind: "bar", stacked: true }],
  ["stacked_column", { _kind: "bar", stacked: true }],
  ["horizontal_bar", { _kind: "bar", horizontal: true }],
  ["hbar", { _kind: "bar", horizontal: true }],
  ["barres_horizontales", { _kind: "bar", horizontal: true }],
  ["bar_horizontal", { _kind: "bar", horizontal: true }],
  ["stacked_area", { _kind: "area", stacked: true }],
  ["aires_empilees", { _kind: "area", stacked: true }],
  ["stepped", { _kind: "line", step: true }],
  ["step", { _kind: "line", step: true }],
  ["escalier", { _kind: "line", step: true }],
  ["spline", { _kind: "line", smooth: true }],
  ["lissee", { _kind: "line", smooth: true }],
  ["percent_bar", { _kind: "bar", stacked: true, percent: true }],
  ["barres_100", { _kind: "bar", stacked: true, percent: true }],
]);

/** « histogramme » : barres ou histogramme selon la forme des données. */
export const AMBIGUOUS = new Map<string, readonly [string, string]>([
  ["histogramme", ["bar", "histogram"]],
  ["histogrammes", ["bar", "histogram"]],
]);

export const KIND_NAMES: readonly string[] = Object.keys(KINDS);

const ALIAS_TO_KIND = new Map<string, string>();
for (const [k, aliases] of Object.entries(KINDS)) for (const a of aliases) ALIAS_TO_KIND.set(a, k);

/** Type canonique (ou null si ambigu ou inconnu), options implicites et note de lecture. */
export function resolveKind(raw: unknown): [string | null, Dict, string | null] {
  const f = fold(raw);
  if (!f) return ["auto", {}, null];
  const direct = ALIAS_TO_KIND.get(f);
  if (direct !== undefined)
    return [direct, {}, strPy(raw) === direct ? null : `type '${strPy(raw)}' read as '${direct}'`];
  const avecOptions = ALIAS_OPTIONS.get(f);
  if (avecOptions !== undefined) {
    const { _kind: k, ...o } = avecOptions;
    const extra = Object.entries(o)
      .map(([a, b]) => `${a}=${strPy(b).toLowerCase()}`)
      .join(", ");
    return [strPy(k), o, `type '${strPy(raw)}' read as '${strPy(k)}' + ${extra}`];
  }
  const ambigu = AMBIGUOUS.get(f);
  if (ambigu !== undefined) return [null, { _ambiguous: ambigu }, null];
  for (const suffix of ["_chart", "_graph", "_plot", "_diagram", "_diagramme"]) {
    const k = f.endsWith(suffix) ? ALIAS_TO_KIND.get(f.slice(0, -suffix.length)) : undefined;
    if (k !== undefined) return [k, {}, `type '${strPy(raw)}' read as '${k}'`];
  }
  const [proche] = getCloseMatches(f, [...ALIAS_TO_KIND.keys(), ...ALIAS_OPTIONS.keys()], 1, 0.78);
  if (proche !== undefined) {
    const options = ALIAS_OPTIONS.get(proche);
    if (options !== undefined) {
      const { _kind: k, ...o } = options;
      return [strPy(k), o, `type '${strPy(raw)}' read as '${strPy(k)}' (closest match)`];
    }
    const k = ALIAS_TO_KIND.get(proche) ?? "";
    return [k, {}, `type '${strPy(raw)}' read as '${k}' (closest match)`];
  }
  return [null, {}, null];
}

const NULLS = new Set(["", "-", "–", "—", "n/a", "na", "nan", "null", "none", "nd", "n.d.", "?", "/"]);
const CURRENCIES: readonly (readonly [string, string])[] = [
  ["€", "€"],
  ["eur", "€"],
  ["euro", "€"],
  ["euros", "€"],
  ["$", "$"],
  ["usd", "$"],
  ["£", "£"],
  ["gbp", "£"],
  ["chf", "CHF"],
  ["¥", "¥"],
  ["jpy", "¥"],
];
/** Devises par longueur décroissante (tri stable de Python). */
const CURRENCIES_TRIEES = [...CURRENCIES].sort((a, b) => Array.from(b[0]).length - Array.from(a[0]).length);
const SCALES = new Map<string, number>([
  ["k", 1e3],
  ["m", 1e6],
  ["md", 1e9],
  ["mds", 1e9],
  ["mrd", 1e9],
  ["g", 1e9],
  ["b", 1e9],
  ["bn", 1e9],
  ["mio", 1e6],
  ["mn", 1e6],
  ["milliers", 1e3],
  ["millions", 1e6],
  ["milliards", 1e9],
  ["t", 1e12],
]);

/** Nombre lu et unité éventuellement reconnue (« % », « € »). */
export class Num {
  readonly value: number | null;
  readonly unit: string | null;
  readonly coerced: boolean;

  constructor(value: number | null, unit: string | null = null, coerced = false) {
    this.value = value;
    this.unit = unit;
    this.coerced = coerced;
  }
}

const BLANC_CLASSE = BLANC_PY.slice(1, -1);
const RE_PREFIXE_VALEUR = new RegExp(`^[+-]?[\\p{Nd}${BLANC_CLASSE}.,']+$`, "u");
const LETTRES_UNITE = new Set(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzéèûµ°/²³"));

/** `^([+-]?[\d\s.,']+)\s*([A-Za-zéèûµ°/²³]{1,8})\.?$` sans retour arrière quadratique : valeur et unité, ou null. */
function separerValeurUnite(s: string): [string, string] | null {
  const corps = s.endsWith(".") ? s.slice(0, -1) : s;
  let debut = corps.length;
  while (debut > 0 && LETTRES_UNITE.has(corps.charAt(debut - 1))) debut--;
  const lettres = corps.slice(debut);
  if (lettres.length < 1 || lettres.length > 8) return null;
  const prefixe = corps.slice(0, debut);
  return RE_PREFIXE_VALEUR.test(prefixe) ? [prefixe, lettres] : null;
}
const RE_SEULEMENT_CHIFFRES = /^-?[\p{Nd}.,]+$/u;

/** Retire les `n` premiers points de code. */
function sansDebut(s: string, n: number): string {
  return Array.from(s).slice(n).join("");
}

/** Retire les `n` derniers points de code. */
function sansFin(s: string, n: number): string {
  return Array.from(s)
    .slice(0, Math.max(0, Array.from(s).length - n))
    .join("");
}

/** Lit un nombre « à la française » ou autre ; `value` est null si illisible. */
export function toNumber(v: unknown): Num {
  if (v === null || v === undefined) return new Num(null);
  if (typeof v === "boolean") return new Num(v ? 1 : 0, null, true);
  if (estNombrePy(v)) {
    const brut = nombreBrut(v);
    const f = typeof v === "bigint" ? enFlottant(v) : (brut ?? 0);
    return new Num(Number.isFinite(f) ? f : null, null, !Number.isFinite(f));
  }
  if (typeof v !== "string") return new Num(null);
  let s = stripPy(v);
  if (NULLS.has(lowerPy(s))) return new Num(null, null, true);
  let unit: string | null = null;
  s = s.replaceAll("−", "-").replaceAll(" ", " ").replaceAll(" ", " ");
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = stripPy(s.slice(1, -1));
  }
  if (s.includes("%")) {
    unit = "%";
    s = stripPy(s.replaceAll("%", ""));
  }
  const low = lowerPy(s);
  for (const [sym, u] of CURRENCIES_TRIEES) {
    if (low.endsWith(sym) || low.startsWith(sym)) {
      unit = unit !== null && unit !== "" ? unit : u;
      const n = Array.from(sym).length;
      s = low.startsWith(sym) ? sansDebut(s, n) : sansFin(s, n);
      s = stripPy(s);
      break;
    }
  }
  let mult = 1;
  const separe = separerValeurUnite(s);
  if (separe !== null) {
    const [valeur, lettres] = separe;
    const echelle = SCALES.get(lowerPy(lettres));
    if (echelle !== undefined) mult = echelle;
    else unit = unit !== null && unit !== "" ? unit : lettres;
    s = stripPy(valeur);
  }
  s = s.replaceAll(" ", "").replaceAll("'", "");
  if (s.startsWith("+")) s = s.slice(1);
  if (!RE_SEULEMENT_CHIFFRES.test(s || "x")) return new Num(null);
  if (s.includes(",") && s.includes(".")) {
    s =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replaceAll(".", "").replaceAll(",", ".")
        : s.replaceAll(",", "");
  } else if (s.split(",").length - 1 > 1) s = s.replaceAll(",", "");
  else if (s.includes(",")) s = s.replaceAll(",", ".");
  else if (s.split(".").length - 1 > 1) s = s.replaceAll(".", "");
  let f: number;
  try {
    f = floatPy(s) * mult;
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return new Num(null);
    throw e;
  }
  if (neg) f = -Math.abs(f);
  return new Num(Number.isFinite(f) ? f : null, unit, true);
}

const MONTHS = new Map<string, number>(
  Object.entries({
    jan: 1,
    janv: 1,
    janvier: 1,
    january: 1,
    feb: 2,
    fev: 2,
    fevr: 2,
    fevrier: 2,
    february: 2,
    mar: 3,
    mars: 3,
    march: 3,
    apr: 4,
    avr: 4,
    avril: 4,
    april: 4,
    may: 5,
    mai: 5,
    jun: 6,
    juin: 6,
    june: 6,
    jul: 7,
    juil: 7,
    juillet: 7,
    july: 7,
    aug: 8,
    aou: 8,
    aout: 8,
    august: 8,
    sep: 9,
    sept: 9,
    septembre: 9,
    september: 9,
    oct: 10,
    octobre: 10,
    october: 10,
    nov: 11,
    novembre: 11,
    november: 11,
    dec: 12,
    decembre: 12,
    december: 12,
  }),
);

const RE_ISO =
  /^(\p{Nd}{4})-(\p{Nd}{2})-(\p{Nd}{2})(?:[ T](\p{Nd}{2}):(\p{Nd}{2})(?::(\p{Nd}{2}))?)?(Z|[+-]\p{Nd}{2}:?\p{Nd}{2})?$/u;
const RE_JJMMAAAA = /^(\p{Nd}{1,2})[/.-](\p{Nd}{1,2})[/.-](\p{Nd}{4})$/u;
const RE_JOUR_MOIS_AN = new RegExp(
  `^(\\p{Nd}{1,2})(?:er)?${BLANC_PY}+([A-Za-zéèûôÉ.]+)${BLANC_PY}+(\\p{Nd}{4})$`,
  "u",
);
const RE_MOIS_AN = /^\p{Nd}{4}-\p{Nd}{2}$/u;
const RE_NOM_MOIS_AN = new RegExp(`^([A-Za-zéèûôÉ.]+)\\.?${BLANC_PY}+(\\p{Nd}{4})$`, "u");

/** `int(chiffres)` d'un groupe de chiffres Unicode ; null si un chiffre n'est pas décimal pour Python. */
function chiffres(g: string | undefined): number | null {
  return g === undefined ? null : entierOuNulPy(g);
}

/** Vrai si `datetime.fromisoformat` accepte la chaîne (qui a déjà la forme du motif ISO). */
function isoAccepte(m: RegExpExecArray): boolean {
  if (/\P{ASCII}/u.test(m[0])) return false;
  if (!dateValide(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  const tz = m[7];
  if (m[4] !== undefined) {
    if (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59)) return false;
    return (
      tz === undefined || tz === "Z" || Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(-2)) * 60 < 86_400
    );
  }
  if (tz === undefined || tz === "Z") return true;
  return Number(tz.slice(1, 3)) <= 23 && Number(tz.slice(-2)) <= 59;
}

/** « AAAA-MM-JJ » (ou avec l'heure) si la valeur est une date complète. */
export function toDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = stripPy(v);
  const iso = RE_ISO.exec(s);
  if (iso !== null) return isoAccepte(iso) ? s.replaceAll(" ", "T") : null;
  const fr = RE_JJMMAAAA.exec(s);
  if (fr !== null) {
    const [d, mo, y] = [chiffres(fr[1]), chiffres(fr[2]), chiffres(fr[3])];
    return d !== null && mo !== null && y !== null && dateValide(y, mo, d) ? dateIsoTexte(y, mo, d) : null;
  }
  const lettres = RE_JOUR_MOIS_AN.exec(s);
  if (lettres !== null) {
    const mo = MONTHS.get(fold(lettres[2]));
    if (mo !== undefined) {
      const [d, y] = [chiffres(lettres[1]), chiffres(lettres[3])];
      return d !== null && y !== null && dateValide(y, mo, d) ? dateIsoTexte(y, mo, d) : null;
    }
  }
  return null;
}

function dateIsoTexte(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** « 2024-03 », « mars 2024 », « Mar 2024 » → « 2024-03 » (tri chronologique). */
export function monthKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = stripPy(v);
  if (RE_MOIS_AN.test(s)) return s.split("-").every((p) => entierOuNulPy(p) !== null) ? s : null;
  const m = RE_NOM_MOIS_AN.exec(s);
  const mo = m === null ? undefined : MONTHS.get(fold(m[1]));
  if (m === null || mo === undefined || chiffres(m[2]) === null) return null;
  return `${m[2]}-${String(mo).padStart(2, "0")}`;
}

/** Corrections (le modèle a écrit autre chose, on a compris) et avertissements. */
export class Notes {
  readonly fixes: string[] = [];
  readonly warnings: string[] = [];

  fix(msg: string | null): void {
    if (msg && !this.fixes.includes(msg)) this.fixes.push(msg);
  }

  warn(msg: string | null): void {
    if (msg && !this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

/** `s.strip(chars)` : retire de chaque bout les caractères listés. */
function stripCaracteres(s: string, caracteres: string): string {
  const points = Array.from(s);
  let debut = 0;
  let fin = points.length;
  while (debut < fin && caracteres.includes(points[debut] ?? "")) debut++;
  while (fin > debut && caracteres.includes(points[fin - 1] ?? "")) fin--;
  return points.slice(debut, fin).join("");
}

const RE_LIGNE_SEPARATEUR = new RegExp(`^[${BLANC_CLASSE}:|-]+$`);

/** Longueur maximale d'un champ du module csv de Python. */
const CSV_LIMITE_CHAMP = 131_072;

/** `list(csv.reader(io.StringIO("\n".join(lignes)), delimiter=delim))` (dialecte excel). */
function lireCsv(lignes: readonly string[], delim: string): string[][] {
  const enregistrements: string[][] = [];
  let champs: string[] = [];
  let champ = "";
  let longueur = 0;
  type Etat = "debut_enr" | "debut_champ" | "dans_champ" | "dans_guillemets" | "guillemet_dans" | "fin_ligne";
  let etat: Etat = "debut_enr";
  const ajouter = (c: string): void => {
    if (longueur >= CSV_LIMITE_CHAMP) throw new Error(`field larger than field limit (${CSV_LIMITE_CHAMP})`);
    champ += c;
    longueur += 1;
  };
  const sauver = (): void => {
    champs.push(champ);
    champ = "";
    longueur = 0;
  };
  const courant = (): Etat => etat;
  const traiter = (c: string | null): void => {
    switch (etat) {
      case "debut_enr":
        if (c === null) return;
        if (c === "\n" || c === "\r") {
          etat = "fin_ligne";
          return;
        }
        etat = "debut_champ";
        traiter(c);
        return;
      case "debut_champ":
        if (c === "\n" || c === "\r" || c === null) {
          sauver();
          etat = c === null ? "debut_enr" : "fin_ligne";
        } else if (c === '"') etat = "dans_guillemets";
        else if (c === delim) sauver();
        else {
          ajouter(c);
          etat = "dans_champ";
        }
        return;
      case "dans_champ":
        if (c === "\n" || c === "\r" || c === null) {
          sauver();
          etat = c === null ? "debut_enr" : "fin_ligne";
        } else if (c === delim) {
          sauver();
          etat = "debut_champ";
        } else ajouter(c);
        return;
      case "dans_guillemets":
        if (c === null) return;
        if (c === '"') etat = "guillemet_dans";
        else ajouter(c);
        return;
      case "guillemet_dans":
        if (c === '"') {
          ajouter(c);
          etat = "dans_guillemets";
        } else if (c === delim) {
          sauver();
          etat = "debut_champ";
        } else if (c === "\n" || c === "\r" || c === null) {
          sauver();
          etat = c === null ? "debut_enr" : "fin_ligne";
        } else {
          ajouter(c);
          etat = "dans_champ";
        }
        return;
      case "fin_ligne":
        if (c === null) etat = "debut_enr";
        else if (c !== "\n" && c !== "\r")
          throw new Error(
            "new-line character seen in unquoted field - do you need to open the file with newline=''?",
          );
    }
  };
  lignes.forEach((ligne, i) => {
    for (const c of ligne) traiter(c);
    if (i < lignes.length - 1) traiter("\n");
    traiter(null);
    if (courant() === "debut_enr") {
      enregistrements.push(champs);
      champs = [];
    }
  });
  if (longueur !== 0 || courant() === "dans_guillemets") {
    sauver();
    enregistrements.push(champs);
  }
  return enregistrements;
}

function rowsWithHeader(rows: readonly (readonly unknown[])[]): Ligne[] {
  const header = el(rows, 0).map((h, i) => stripPy(strPy(h)) || `col${i + 1}`);
  const out: Ligne[] = [];
  for (const r of rows.slice(1)) {
    if (!Array.isArray(r) || !r.some((x) => x !== null && x !== "")) continue;
    const ligne: Ligne = new Map();
    r.forEach((x: unknown, i) => ligne.set(header[i] ?? `col${i + 1}`, x));
    out.push(ligne);
  }
  return out;
}

function parseTextTable(s: string, notes: Notes): Ligne[] | null {
  const lines = splitlinesPy(stripPy(s)).filter((ln) => stripPy(ln) !== "");
  if (lines.length < 2) return null;
  if (lstripPy(el(lines, 0)).startsWith("|")) {
    const rows: string[][] = [];
    for (const ln of lines) {
      if (RE_LIGNE_SEPARATEUR.test(ln)) continue;
      rows.push(
        stripCaracteres(stripPy(ln), "|")
          .split("|")
          .map((c) => stripPy(c)),
      );
    }
    notes.fix("Markdown table read as data");
    return rowsWithHeader(rows);
  }
  const sample = lines.slice(0, 5).join("\n");
  const nombre = (d: string): number => sample.split(d).length - 1;
  const delim = [";", "\t", ",", "|"].reduce((meilleur, d) => (nombre(d) > nombre(meilleur) ? d : meilleur));
  const rows = lireCsv(lines, delim);
  notes.fix("CSV text read as data");
  return rowsWithHeader(rows);
}

function getCi(d: Dict | Ligne, key: string): unknown {
  for (const [k, v] of paires(d)) if (fold(k) === key) return v;
  return null;
}

function fromChartjs(labels: unknown, datasets: readonly (Dict | Ligne)[], notes: Notes): Ligne[] {
  notes.fix("legacy labels + datasets converted to rows");
  const etiquettes: unknown[] = Array.isArray(labels) ? labels : [];
  const donnees = (d: Dict | Ligne): unknown[] => {
    const v = getCi(d, "data");
    return veritePy(v) ? (v as unknown[]) : [];
  };
  const n = maxListe([etiquettes.length, ...datasets.map((d) => donnees(d).length)]);
  if (datasets.some((d) => donnees(d).length !== etiquettes.length) && etiquettes.length > 0)
    notes.warn("series and labels of different lengths: padded with empty values");
  const rows: Ligne[] = [];
  for (let i = 0; i < n; i++) {
    const row: Ligne = new Map([["libellé", i < etiquettes.length ? etiquettes[i] : `#${i + 1}`]]);
    datasets.forEach((d, j) => {
      const etiquette = getCi(d, "label");
      const name = strPy(veritePy(etiquette) ? etiquette : `série ${j + 1}`);
      const vals = donnees(d);
      row.set(name, i < vals.length ? vals[i] : null);
    });
    rows.push(row);
  }
  return rows;
}

/** Ramène toute forme raisonnable de données à une liste de lignes. */
export function toRecords(data: unknown, notes: Notes, labels: unknown = null): Ligne[] {
  if (data === null || data === undefined) return [];
  if (typeof data === "string") {
    const s = stripPy(data);
    if (s === "" || s.startsWith("[") || s.startsWith("{")) {
      let analysee: unknown;
      let lue = true;
      try {
        analysee = pyJsonLoads(s);
      } catch (e) {
        if (!(e instanceof ErreurJsonPy) && !(e instanceof ErreurLecturePy && e.nature === "ValueError"))
          throw e;
        lue = false;
      }
      if (lue) {
        notes.fix("data sent as a JSON string: decoded");
        return toRecords(analysee, notes, labels);
      }
    }
    return parseTextTable(s, notes) ?? [];
  }
  if (estDict(data)) {
    const entrees = paires(data);
    const vals = entrees.map(([, v]) => v);
    if (vals.length > 0 && vals.every((v) => Array.isArray(v))) {
      const listes = vals as unknown[][];
      const n = maxListe(listes.map((v) => v.length));
      if (new Set(listes.map((v) => v.length)).size > 1)
        notes.warn("columns of different lengths: padded with empty values");
      notes.fix("{column: [values]} converted to rows");
      return Array.from(
        { length: n },
        (_, i) =>
          new Map(entrees.map(([k, v]) => [k, i < (v as unknown[]).length ? (v as unknown[])[i] : null])),
      );
    }
    if (vals.length > 0 && vals.every((v) => !Array.isArray(v) && !estDictOuLigne(v))) {
      notes.fix("{label: value} converted to rows");
      return entrees.map(
        ([k, v]) =>
          new Map<string, unknown>([
            ["libellé", k],
            ["valeur", v],
          ]),
      );
    }
    if (vals.length > 0 && vals.every((v) => estDictOuLigne(v))) {
      notes.fix("{label: {...}} converted to rows");
      return entrees.map(([k, v]) => new Map<string, unknown>([["libellé", k], ...paires(v as Dict)]));
    }
    return [new Map(entrees)];
  }
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.every((r) => estDict(r))) {
    const dicts = data as Dict[];
    if (
      dicts.every((r) => paires(r).some(([k]) => fold(k) === "data")) &&
      dicts.every((r) => Array.isArray(getCi(r, "data")))
    )
      return fromChartjs(labels, dicts, notes);
    return dicts.map((r) => new Map(paires(r).map(([k, v]) => [stripPy(k), v] as [string, unknown])));
  }
  if (data.every((r) => Array.isArray(r))) {
    const listes = data as unknown[][];
    const first = el(listes, 0);
    if (
      first.length > 0 &&
      first.every((x) => typeof x === "string") &&
      listes.length > 1 &&
      listes.slice(1).some((r) => r.some((x) => typeof x !== "string"))
    ) {
      notes.fix("first row used as header");
      return rowsWithHeader(listes);
    }
    const width = maxListe(listes.map((r) => r.length));
    const names =
      width === 2
        ? ["libellé", "valeur"]
        : width === 3
          ? ["x", "y", "valeur"]
          : Array.from({ length: width }, (_, i) => `col${i + 1}`);
    notes.fix(`rows without header: columns named ${names.join(", ")}`);
    return listes.map((r) => new Map(r.map((x, i) => [el(names, i), x] as [string, unknown])));
  }
  if (data.every((r) => !Array.isArray(r) && !estDict(r))) {
    if (Array.isArray(labels) && labels.length > 0) {
      notes.fix("values + labels converted to rows");
      return data.map(
        (v, i) =>
          new Map<string, unknown>([
            ["libellé", i < labels.length ? labels[i] : `#${i + 1}`],
            ["valeur", v],
          ]),
      );
    }
    notes.fix("list of values converted to rows");
    return data.map((v) => new Map<string, unknown>([["valeur", v]]));
  }
  return [];
}

/** Noms qui désignent une dimension même quand les valeurs sont des nombres. */
const DIM_NAMES = new Set([
  "annee",
  "an",
  "year",
  "years",
  "annees",
  "date",
  "jour",
  "day",
  "mois",
  "month",
  "semaine",
  "week",
  "trimestre",
  "quarter",
  "periode",
  "period",
  "heure",
  "hour",
  "time",
  "temps",
  "id",
  "code",
  "rang",
  "rank",
  "numero",
]);

export type GenreColonne = "text" | "number" | "date";

export class Column {
  readonly name: string;
  kind: GenreColonne = "text";
  unit: string | null = null;
  nCoerced = 0;
  dates = false;
  months = false;
  example: [unknown, number] | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** `repr(colonne)`. */
  repr(): string {
    return `${this.name}:${this.kind}`;
  }
}

export function profile(rows: readonly Ligne[]): Column[] {
  const names: string[] = [];
  const vus = new Set<string>();
  for (const r of rows)
    for (const k of r.keys())
      if (!vus.has(k)) {
        vus.add(k);
        names.push(k);
      }
  const cols: Column[] = [];
  for (const name of names) {
    const c = new Column(name);
    const vals = rows.map((r) => lg(r, name)).filter((v) => v !== null && v !== "");
    if (vals.length === 0) {
      cols.push(c);
      continue;
    }
    const nums = vals.map(toNumber);
    const nOk = nums.filter((n) => n.value !== null).length;
    const units = new Set(nums.map((n) => n.unit).filter((u): u is string => u !== null && u !== ""));
    const dated = vals.filter((v) => toDate(v) !== null).length;
    const monthy = vals.filter((v) => monthKey(v) !== null).length;
    if (dated >= 0.8 * vals.length) {
      c.kind = "date";
      c.dates = true;
    } else if (monthy >= 0.8 * vals.length) {
      c.months = true;
    } else if (nOk >= 0.8 * vals.length) {
      c.kind = "number";
      c.unit = units.size === 1 ? ([...units][0] ?? null) : null;
      c.nCoerced = vals.filter((v, i) => el(nums, i).value !== null && !estNombrePy(v)).length;
      if (DIM_NAMES.has(fold(name)) && nums.every((n) => n.value === null || Number.isInteger(n.value))) {
        c.kind = "text";
      } else {
        const i = vals.findIndex((v, k) => el(nums, k).value !== null && typeof v === "string");
        c.example = i < 0 ? null : [el(vals, i), el(nums, i).value ?? 0];
      }
    }
    cols.push(c);
  }
  return cols;
}

/** Trouve la colonne demandée sans exiger la bonne casse ni les accents. */
export function matchColumn(
  wanted: unknown,
  cols: readonly Column[],
  notes: Notes,
  role: string,
): Column | null {
  if (wanted === null || wanted === undefined || wanted === "") return null;
  const w = strPy(wanted);
  const exacte = cols.find((c) => c.name === w);
  if (exacte !== undefined) return exacte;
  const fw = fold(w);
  const pliee = cols.find((c) => fold(c.name) === fw);
  if (pliee !== undefined) {
    notes.fix(`${role} '${w}' read as column '${pliee.name}'`);
    return pliee;
  }
  const incluse = cols.find((c) => {
    const fc = fold(c.name);
    return fw !== "" && (fc.includes(fw) || fw.includes(fc));
  });
  if (incluse !== undefined) {
    notes.fix(`${role} '${w}' read as column '${incluse.name}'`);
    return incluse;
  }
  const [proche] = getCloseMatches(
    fw,
    cols.map((c) => fold(c.name)),
    1,
    0.7,
  );
  if (proche !== undefined) {
    const c = cols.find((col) => fold(col.name) === proche);
    if (c !== undefined) {
      notes.fix(`${role} '${w}' read as column '${c.name}' (closest match)`);
      return c;
    }
  }
  notes.warn(`${role} '${w}': no such column (${cols.map((c) => c.name).join(", ")}), ignored`);
  return null;
}

/** Valeur numérique d'une cellule (null si illisible). */
export function num(v: unknown): number | null {
  return toNumber(v).value;
}
