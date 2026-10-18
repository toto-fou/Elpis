// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/graphiques.ts — graphiques du chat (outils chart_<type>) avec ECharts : jetons de couleur clair/sombre, mise en forme posée côté client, carte (morphose, tableau, PNG, agrandir), KPI et tableaux HTML échappés. */

type Option = Record<string, unknown>;

interface Jetons {
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  track: string;
  up: string;
  down: string;
  neutral: string;
  gain: string;
  loss: string;
  series1: string;
  series1a: string;
  onhi: string;
  onlo: string;
  seq: string[];
  div: string[];
  palette: string[];
  [cle: string]: unknown;
}

interface GraphiqueEcharts {
  setOption(option: unknown, opts?: { notMerge?: boolean }): void;
  resize(): void;
  dispose(): void;
  getDataURL(opts: { type: string; pixelRatio: number; backgroundColor: string }): string;
}

interface Echarts {
  registerTheme(nom: string, theme: unknown): void;
  init(el: HTMLElement, theme: string, opts: { renderer: string; locale: string }): GraphiqueEcharts;
}

interface Hote extends HTMLElement {
  __raw?: OptionBrute;
  __opts?: OptionsRendu;
  __chart?: GraphiqueEcharts | null;
  __ro?: ResizeObserver | null;
}

interface Tableau {
  columns?: unknown[];
  rows?: unknown[][];
  truncated?: boolean;
}

interface Kpi {
  label?: unknown;
  value?: unknown;
  delta?: unknown;
  sign?: string;
  ref?: unknown;
}

interface MetaElpis {
  unit?: string;
  kind?: string;
  render?: string;
  height?: number;
  table?: Tableau;
  kpi?: Kpi[];
}

export interface OptionBrute {
  _elpis?: MetaElpis;
  title?: { text?: string };
  series?: Option[];
  xAxis?: Option & { data?: unknown[]; type?: string; boundaryGap?: boolean };
  tooltip?: Option;
  [cle: string]: unknown;
}

export interface OptionsRendu {
  height?: number;
  morph?: boolean;
  decal?: boolean;
}

export const TOKENS: Readonly<{ light: Jetons; dark: Jetons }> = {
  light: {
    surface: "#ffffff",
    ink: "#0f172a",
    ink2: "#475569",
    muted: "#cbd5e1",
    grid: "#e2e8f0",
    axis: "#cbd5e1",
    track: "#eef2f7",
    up: "#2a78d6",
    down: "#e34948",
    neutral: "#94a3b8",
    gain: "#0f8a3c",
    loss: "#d03b3b",
    series1: "#2a78d6",
    series1a: "rgba(42,120,214,0.18)",
    onhi: "#ffffff",
    onlo: "#0f172a",
    seq: ["#eef4fc", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
    div: ["#256abf", "#86b6ef", "#f1f5f9", "#f2a3a2", "#c42f2e"],
    palette: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  },
  dark: {
    surface: "#1e293b",
    ink: "#f1f5f9",
    ink2: "#cbd5e1",
    muted: "#475569",
    grid: "#334155",
    axis: "#475569",
    track: "#334155",
    up: "#3987e5",
    down: "#e66767",
    neutral: "#94a3b8",
    gain: "#2fbf5b",
    loss: "#e66767",
    series1: "#3987e5",
    series1a: "rgba(57,135,229,0.22)",
    onhi: "#0f172a",
    onlo: "#f1f5f9",
    seq: ["#24324a", "#13335c", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
    div: ["#3987e5", "#1c5cab", "#475569", "#a63a3a", "#e66767"],
    palette: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  },
};

const KIND_FR: Readonly<Record<string, string>> = {
  bar: "barres",
  line: "courbe",
  area: "aires",
  stream: "flux",
  radar: "radar",
  polar_bar: "barres polaires",
  waterfall: "cascade",
  pie: "secteurs",
  donut: "anneau",
  rose: "rose",
  treemap: "treemap",
  sunburst: "sunburst",
  funnel: "entonnoir",
  histogram: "histogramme",
  boxplot: "boîtes à moustaches",
  scatter: "nuage de points",
  bubble: "bulles",
  heatmap: "carte de chaleur",
  calendar: "calendrier",
  parallel: "coordonnées parallèles",
  sankey: "sankey",
  chord: "cordes",
  graph: "réseau",
  tree: "arbre",
  gantt: "Gantt",
  candlestick: "chandeliers",
  gauge: "jauge",
  progress: "progression",
  kpi: "indicateurs",
  table: "tableau",
};

export const HEIGHT: Readonly<Record<string, number>> = {
  tree: 380,
  graph: 400,
  sankey: 380,
  chord: 400,
  treemap: 360,
  sunburst: 400,
  parallel: 340,
};

const echarts = (): Echarts | undefined => (globalThis as { echarts?: Echarts }).echarts;

export function isDark(): boolean {
  try {
    return document.body.classList.contains("elpis-dark-surface");
  } catch {
    return false;
  }
}

const jetons = (): Jetons => (isDark() ? TOKENS.dark : TOKENS.light);

export function themeObject(t: Jetons): Option {
  const axe = {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { lineStyle: { color: t.axis } },
    axisLabel: { color: t.ink2, fontSize: 11 },
    nameTextStyle: { color: t.ink2, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
    splitArea: { show: false },
  };
  return {
    color: t.palette,
    backgroundColor: "transparent",
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: t.ink },
    title: {
      textStyle: { color: t.ink, fontSize: 14, fontWeight: 600 },
      subtextStyle: { color: t.ink2, fontSize: 12 },
    },
    legend: {
      textStyle: { color: t.ink2, fontSize: 12 },
      pageTextStyle: { color: t.ink2 },
      inactiveColor: t.muted,
    },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.grid,
      borderWidth: 1,
      textStyle: { color: t.ink, fontSize: 12 },
      extraCssText: "box-shadow:0 6px 20px rgba(0,0,0,.18);border-radius:8px;",
    },
    categoryAxis: { ...axe, splitLine: { show: false } },
    valueAxis: { ...axe, axisLine: { show: false }, axisTick: { show: false } },
    timeAxis: { ...axe, splitLine: { show: false } },
    logAxis: axe,
    dataZoom: {
      borderColor: t.grid,
      fillerColor: t.series1a,
      handleStyle: { color: t.surface, borderColor: t.axis },
      textStyle: { color: t.ink2 },
      dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
    },
    line: { symbol: "circle" },
    markLine: { label: { color: t.ink2 } },
  };
}

let themesEnregistres = false;
function enregistrerThemes(): void {
  const e = echarts();
  if (themesEnregistres || !e) return;
  e.registerTheme("elpis-light", themeObject(TOKENS.light));
  e.registerTheme("elpis-dark", themeObject(TOKENS.dark));
  themesEnregistres = true;
}

const NF = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const NF1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const NC = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const DF = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

export function fmt(v: unknown, unit?: string): string {
  if (v === null || v === undefined || v === "-" || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const s = Math.abs(n) >= 1e5 ? NC.format(n) : NF.format(n);
  return unit ? s + " " + unit : s;
}

function fmtAxe(v: number, unit: string): string {
  const s = Math.abs(v) >= 1e4 ? NC.format(v) : NF.format(v);
  return unit === "%" ? s + " %" : s;
}

/** Remplace les jetons « @nom » par la couleur de la surface courante. */
function resoudre(node: unknown, t: Jetons): unknown {
  if (typeof node === "string" && node[0] === "@" && t[node.slice(1)] !== undefined) return t[node.slice(1)];
  if (Array.isArray(node)) return node.map((x) => resoudre(x, t));
  if (node && typeof node === "object") {
    const out: Option = {};
    for (const k of Object.keys(node)) out[k] = resoudre((node as Option)[k], t);
    return out;
  }
  return node;
}

/** Retire les indications « _… » avant setOption. */
function epurer(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(epurer);
  if (node && typeof node === "object") {
    const out: Option = {};
    for (const k of Object.keys(node)) if (k[0] !== "_") out[k] = epurer((node as Option)[k]);
    return out;
  }
  return node;
}

/** Option prête pour ECharts : jetons résolus, formateurs posés ici (jamais reçus du serveur), aria. */
export function prepare(raw: OptionBrute, opts: OptionsRendu): Option {
  const t = jetons();
  const unit = raw._elpis?.unit || "";
  const o = resoudre(raw, t) as OptionBrute;
  const axes = ([] as unknown[]).concat(
    o.xAxis || [],
    o.yAxis || [],
    o.parallelAxis || [],
  ) as (Option | null)[];
  for (const a of axes) {
    if (a && a._fmt) a.axisLabel = { ...(a.axisLabel as Option), formatter: (v: number) => fmtAxe(v, unit) };
    if (a && a._date)
      a.axisLabel = { ...(a.axisLabel as Option), formatter: (v: number) => DF.format(new Date(v)) };
  }
  for (const s of o.series || []) {
    const lbl = s._lbl as { pct?: boolean; v?: number | null } | undefined;
    const label = s.label as Option | undefined;
    if (lbl && lbl.pct && label) {
      label.formatter = (p: { name: string; percent: number }) =>
        p.name + "\n" + NF1.format(p.percent) + " %";
    } else if (lbl && label) {
      const idx = lbl.v;
      label.formatter = (p: { value: unknown }) => {
        const v =
          idx === null || idx === undefined
            ? Array.isArray(p.value)
              ? (p.value[p.value.length - 1] as unknown)
              : p.value
            : (p.value as unknown[])[idx];
        return fmt(v, unit === "%" ? "%" : "");
      };
    }
    if (opts.morph) s.universalTransition = { enabled: true };
  }
  if (o.tooltip && !o.tooltip.valueFormatter && !o.tooltip.formatter)
    o.tooltip.valueFormatter = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => fmt(x, unit)).join(" · ") : fmt(v, unit);
  if (o.tooltip) o.tooltip.confine = true;
  o.aria = { enabled: true, decal: { show: !!opts.decal } };
  return epurer(o) as Option;
}

function echapper(s: unknown): string {
  return String(s === null || s === undefined ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

function rendreKpi(hote: HTMLElement, raw: OptionBrute): void {
  const sombre = isDark();
  const carte = sombre ? "border-slate-700" : "border-slate-200";
  const sub = sombre ? "text-slate-400" : "text-slate-500";
  const titre =
    raw.title && raw.title.text
      ? `<div class="text-sm font-semibold mb-2">${echapper(raw.title.text)}</div>`
      : "";
  hote.style.height = "";
  hote.innerHTML =
    titre +
    '<div class="grid gap-2" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">' +
    (raw._elpis?.kpi || [])
      .map(
        (k) => `
            <div class="rounded-lg border ${carte} px-3 py-2">
                <div class="text-xs ${sub}">${echapper(k.label)}</div>
                <div class="text-2xl font-semibold leading-tight">${echapper(k.value)}</div>
                ${k.delta ? `<div class="text-xs ${sub}"><span aria-hidden="true" class="font-bold">${k.sign === "up" ? "↑" : k.sign === "down" ? "↓" : "→"}</span> ${echapper(k.delta)} <span class="opacity-75">${echapper(k.ref || "")}</span></div>` : ""}
            </div>`,
      )
      .join("") +
    "</div>";
}

function nombreCellule(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s  €%$£]/g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

/** Tableau HTML échappé, triable par colonne (numérique reconnu). */
export function renderTable(hote: HTMLElement, table: Tableau, titre?: string): void {
  const sombre = isDark();
  const cols = table.columns || [];
  const rows = (table.rows || []).slice();
  const numerique = cols.map(
    (_, i) =>
      rows.length > 0 && rows.every((r) => r[i] === null || r[i] === "" || nombreCellule(r[i]) !== null),
  );
  let colTri = -1;
  let sens = 1;
  const th = sombre ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-700";
  const bd = sombre ? "border-slate-700" : "border-slate-200";
  function dessiner(): void {
    const corps = rows
      .map(
        (r) =>
          "<tr>" +
          r
            .map(
              (v, i) =>
                `<td class="px-2 py-1 border-b ${bd} whitespace-nowrap ${numerique[i] ? "text-right tabular-nums" : ""}">${numerique[i] && typeof v === "number" ? echapper(fmt(v)) : echapper(v)}</td>`,
            )
            .join("") +
          "</tr>",
      )
      .join("");
    hote.style.height = "";
    hote.innerHTML =
      (titre ? `<div class="text-sm font-semibold mb-2">${echapper(titre)}</div>` : "") +
      `<div class="overflow-auto" style="max-height:360px"><table class="w-full text-xs border-collapse"><thead><tr>` +
      cols
        .map(
          (c, i) =>
            `<th data-i="${i}" class="sticky top-0 ${th} px-2 py-1 font-semibold ${numerique[i] ? "text-right" : "text-left"}" aria-sort="${colTri === i ? (sens > 0 ? "ascending" : "descending") : "none"}"><button type="button" class="font-semibold">${echapper(c)}${colTri === i ? (sens > 0 ? " ↑" : " ↓") : ""}</button></th>`,
        )
        .join("") +
      `</tr></thead><tbody>${corps}</tbody></table></div>` +
      (table.truncated ? '<div class="text-[10px] opacity-60 mt-1">500 premières lignes</div>' : "");
    hote.querySelectorAll<HTMLElement>("th").forEach((h) =>
      h.addEventListener("click", () => {
        const i = Number(h.dataset.i);
        sens = colTri === i ? -sens : 1;
        colTri = i;
        rows.sort((a, b) => {
          const x = numerique[i] ? (nombreCellule(a[i]) ?? 0) : String(a[i] || "");
          const y = numerique[i] ? (nombreCellule(b[i]) ?? 0) : String(b[i] || "");
          return (x > y ? 1 : x < y ? -1 : 0) * sens;
        });
        dessiner();
      }),
    );
  }
  dessiner();
}

// Hôtes vivants : libérés (instance ECharts, observateur) quand ils quittent le document.
const vivants = new Set<Hote>();

export function render(hote: Hote, raw: OptionBrute, opts: OptionsRendu = {}): GraphiqueEcharts | null {
  enregistrerThemes();
  const el = raw._elpis || {};
  hote.__raw = raw;
  hote.__opts = opts;
  if (hote.__chart) {
    try {
      hote.__chart.dispose();
    } catch {
      /* instance déjà libérée */
    }
    hote.__chart = null;
  }
  if (el.render === "kpi") {
    rendreKpi(hote, raw);
    vivants.add(hote);
    return null;
  }
  if (el.render === "table") {
    renderTable(hote, el.table || {}, raw.title?.text);
    vivants.add(hote);
    return null;
  }
  const e = echarts();
  if (!e) throw new Error("ECharts indisponible");
  hote.innerHTML = "";
  hote.style.height = String(opts.height || el.height || HEIGHT[el.kind || ""] || 320) + "px";
  const chart = e.init(hote, isDark() ? "elpis-dark" : "elpis-light", { renderer: "canvas", locale: "FR" });
  chart.setOption(prepare(raw, opts));
  hote.__chart = chart;
  vivants.add(hote);
  if (!hote.__ro && typeof ResizeObserver !== "undefined") {
    hote.__ro = new ResizeObserver(() => hote.__chart?.resize());
    hote.__ro.observe(hote);
  }
  return chart;
}

function liberer(hote: Hote): void {
  try {
    hote.__chart?.dispose();
  } catch {
    /* déjà libérée */
  }
  try {
    hote.__ro?.disconnect();
  } catch {
    /* déjà déconnecté */
  }
  hote.__chart = null;
  hote.__ro = null;
  vivants.delete(hote);
}

export function sweep(): void {
  for (const h of Array.from(vivants)) if (!h.isConnected) liberer(h);
}

export function disposeAll(): void {
  for (const h of Array.from(vivants)) liberer(h);
}

function themeCarte(carte: HTMLElement): void {
  const sombre = isDark();
  carte.classList.toggle("bg-white", !sombre);
  carte.classList.toggle("border-slate-200", !sombre);
  carte.classList.toggle("bg-slate-800", sombre);
  carte.classList.toggle("border-slate-700", sombre);
  carte.classList.toggle("text-slate-100", sombre);
}

export function rethemeAll(): void {
  for (const h of Array.from(vivants)) {
    if (!h.isConnected) {
      liberer(h);
      continue;
    }
    if (h.__raw) render(h, h.__raw, h.__opts);
  }
  document.querySelectorAll<HTMLElement>(".chart-render").forEach(themeCarte);
}

/** Bascule barres / courbe / aire avec transition, sur une copie de l'option. */
export function morph(hote: Hote, type: string): void {
  if (!hote.__raw) return;
  const raw = JSON.parse(JSON.stringify(hote.__raw)) as OptionBrute;
  for (const s of raw.series || []) {
    if (!["bar", "line"].includes(s.type as string) || /^Tendance/.test((s.name as string) || "")) continue;
    s.type = type === "area" ? "line" : type;
    if (type === "area") s.areaStyle = s.areaStyle || { opacity: 0.16 };
    else delete s.areaStyle;
    if (s.type === "line") {
      s.showSymbol = (raw.xAxis && raw.xAxis.data ? raw.xAxis.data.length : 99) <= 24;
      s.lineStyle = { width: 2 };
    }
  }
  if (raw.xAxis && raw.xAxis.type === "category") raw.xAxis.boundaryGap = type === "bar";
  if (raw.tooltip) raw.tooltip.axisPointer = { type: type === "bar" ? "shadow" : "line" };
  hote.__raw = raw;
  hote.__chart?.setOption(prepare(raw, { ...hote.__opts, morph: true }), { notMerge: true });
}

export function png(hote: Hote, nom?: string): void {
  if (!hote.__chart) return;
  const url = hote.__chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: jetons().surface });
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download:
      (String(nom || "graphique")
        .replace(/[^a-zA-Z0-9À-ɏ ]/g, "")
        .trim()
        .replace(/\s+/g, "_") || "graphique") + ".png",
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function bouton(icone: string, libelle: string, titre: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className =
    "text-[10px] text-slate-400 hover:text-blue-600 flex items-center gap-1 transition-colors font-medium";
  b.innerHTML = `<i class="ph ${icone} text-xs"></i>`;
  b.appendChild(document.createTextNode(" " + libelle));
  b.title = titre;
  return b;
}

/** Agrandit un graphique en surimpression ; Échap ou clic hors du cadre ferme et libère. */
function zoom(raw: OptionBrute): void {
  const voile = document.createElement("div");
  voile.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.85);" +
    "display:flex;align-items:center;justify-content:center;padding:24px;";
  const boite = document.createElement("div");
  boite.className = "rounded-xl p-4 " + (isDark() ? "bg-slate-800 text-slate-100" : "bg-white");
  boite.style.cssText = "width:min(1200px,100%);max-height:100%;overflow:auto;";
  const hote = document.createElement("div") as Hote;
  boite.appendChild(hote);
  voile.appendChild(boite);
  document.body.appendChild(voile);
  render(hote, raw, { height: Math.min(window.innerHeight - 120, 720) });
  const fermer = (): void => {
    liberer(hote);
    voile.remove();
    document.removeEventListener("keydown", touche);
  };
  const touche = (e: KeyboardEvent): void => {
    if (e.key === "Escape") fermer();
  };
  voile.addEventListener("click", (e) => {
    if (e.target === voile) fermer();
  });
  document.addEventListener("keydown", touche);
}

/** Remplace `cible` (le bloc de code) par la carte du graphique ; rendu au cadre suivant. */
export function mount(cible: Element | null, raw: OptionBrute): HTMLElement {
  const el = raw._elpis || {};
  const kind = el.kind || "";
  const titre = raw.title?.text || "";
  const carte = document.createElement("div");
  carte.className = "chart-render rounded-xl border p-4 mb-4 shadow-sm";
  themeCarte(carte);
  const entete = document.createElement("div");
  entete.className = "flex items-center justify-between gap-2 mb-2 flex-wrap";
  const etiquette = document.createElement("span");
  etiquette.className = "text-xs font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5";
  etiquette.innerHTML = '<i class="ph ph-chart-bar text-blue-500"></i>';
  etiquette.appendChild(document.createTextNode(" " + (KIND_FR[kind] || "graphique")));
  entete.appendChild(etiquette);
  const outils = document.createElement("div");
  outils.className = "flex items-center gap-3";
  entete.appendChild(outils);
  carte.appendChild(entete);
  const hote = document.createElement("div") as Hote;
  hote.className = "w-full";
  carte.appendChild(hote);
  const donnees = document.createElement("div");
  donnees.className = "hidden mt-3";
  carte.appendChild(donnees);
  if (!el.render) {
    if (["bar", "line", "area"].includes(kind)) {
      for (const [t, ic, l] of [
        ["bar", "ph-chart-bar", "Barres"],
        ["line", "ph-chart-line", "Courbe"],
        ["area", "ph-chart-line-up", "Aire"],
      ] as const) {
        const b = bouton(ic, l, "Afficher en " + l.toLowerCase());
        b.onclick = () => morph(hote, t);
        outils.appendChild(b);
      }
    }
    const bt = bouton("ph-table", "Tableau", "Données du graphique");
    bt.onclick = () => {
      if (!donnees.classList.toggle("hidden")) renderTable(donnees, el.table || {}, "");
    };
    outils.appendChild(bt);
    const bp = bouton("ph-download-simple", "PNG", "Télécharger en PNG");
    bp.onclick = () => png(hote, titre || KIND_FR[kind]);
    outils.appendChild(bp);
    const bz = bouton("ph-arrows-out", "Agrandir", "Agrandir");
    bz.onclick = () => zoom(hote.__raw || raw);
    outils.appendChild(bz);
  }
  if (cible && cible.parentNode) cible.parentNode.replaceChild(carte, cible);
  requestAnimationFrame(() => {
    if (!hote.isConnected) return;
    try {
      render(hote, raw, {});
    } catch (e) {
      hote.textContent = "Graphique non rendu : " + (e instanceof Error && e.message ? e.message : String(e));
      hote.className = "text-xs text-amber-700 p-3";
    }
  });
  return carte;
}

/** L'API publiée sous `window.ElpisCharts`, lue par la passe d'enrichissement. */
export const ElpisCharts = Object.freeze({
  mount,
  render,
  sweep,
  disposeAll,
  rethemeAll,
  morph,
  png,
  renderTable,
  fmt,
  isDark,
  TOKENS,
});
