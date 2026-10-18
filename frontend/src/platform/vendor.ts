// SPDX-License-Identifier: MIT
/** frontend/src/platform/vendor.ts — bibliothèques UMD chargées à la demande (Mermaid, highlight.js, Chart.js, ECharts) depuis les fichiers hachés du build. */
export type GroupeVendor = "mermaid" | "highlight" | "chart" | "echarts";

interface ChartUmd {
  register(...elements: unknown[]): void;
  defaults: { set(cle: string, valeur: unknown): void };
  __elpisPluginsReady?: boolean;
}

interface ZoneGraphe {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface TexteCentral {
  text?: unknown;
  subtext?: unknown;
  color?: string;
  size?: number;
}

interface GrapheChart {
  chartArea?: ZoneGraphe;
  ctx: CanvasRenderingContext2D;
  config: { options?: { plugins?: { centerText?: TexteCentral } } };
}

interface GlobalsVendor {
  mermaid?: unknown;
  hljs?: unknown;
  echarts?: unknown;
  Chart?: ChartUmd;
  ChartDataLabels?: unknown;
  "chartjs-plugin-annotation"?: unknown;
}

interface Groupe {
  readonly urls: readonly string[];
  pret(): boolean;
  apres?(): void;
}

const g = (): GlobalsVendor => window as unknown as GlobalsVendor;

const GROUPES: Readonly<Record<GroupeVendor, Groupe>> = {
  mermaid: { urls: ["vendor/mermaid.min.js"], pret: () => !!g().mermaid },
  highlight: { urls: ["vendor/highlight.min.js"], pret: () => !!g().hljs },
  chart: {
    urls: [
      "vendor/chart.js",
      "vendor/chartjs-adapter-date-fns.bundle.min.js",
      "vendor/chartjs-plugin-datalabels.min.js",
      "vendor/chartjs-plugin-annotation.min.js",
      "vendor/chartjs-chart-treemap.min.js",
      "vendor/chartjs-chart-sankey.min.js",
      "vendor/chartjs-chart-matrix.min.js",
      "vendor/chartjs-chart-boxplot.umd.min.js",
      "vendor/chartjs-chart-financial.js",
    ],
    pret: () => g().Chart !== undefined,
    apres: enregistrerGreffonsChart,
  },
  echarts: { urls: ["vendor/echarts.min.js", "vendor/echarts-langFR.js"], pret: () => !!g().echarts },
};

const enAttente = new Map<GroupeVendor, Promise<void>>();
let carteVendor: Readonly<Record<string, string>> = {};

/** Carte clé historique → URL hachée (`virtual:elpis-vendor`), posée par l'entrée : ce module reste chargeable hors build. */
export function definirCarteVendor(carte: Readonly<Record<string, string>>): void {
  carteVendor = Object.freeze({ ...carte });
}

/** URL construite (hachée) d'un fichier vendor ; la clé historique telle quelle si le build ne la connaît pas. */
export function urlVendor(cle: string): string {
  const nette = cle.replace(/^static\//, "");
  return carteVendor[nette] ?? cle;
}

function chargerScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Chargement impossible : " + url));
    document.head.appendChild(el);
  });
}

/** Charge un groupe une fois (appels concurrents partagés) ; un échec purge la mémoïsation pour permettre un nouvel essai. */
export function ensureVendor(nom: string): Promise<void> {
  const groupe = (GROUPES as Readonly<Record<string, Groupe | undefined>>)[nom];
  if (!groupe) return Promise.reject(new Error("Groupe vendor inconnu : " + nom));
  if (groupe.pret()) return Promise.resolve();
  const cle = nom as GroupeVendor;
  const deja = enAttente.get(cle);
  if (deja) return deja;
  let chaine = Promise.resolve();
  for (const u of groupe.urls) chaine = chaine.then(() => chargerScript(urlVendor(u)));
  const p = chaine
    .then(() => {
      if (!groupe.pret()) throw new Error("Bibliothèque non disponible après chargement : " + nom);
      try {
        groupe.apres?.();
      } catch {
        /* greffons facultatifs : le graphe reste rendu sans eux */
      }
    })
    .catch((err: unknown) => {
      enAttente.delete(cle);
      throw err;
    });
  enAttente.set(cle, p);
  return p;
}

function dessinerTexteCentral(graphe: GrapheChart): void {
  const ct = graphe.config.options?.plugins?.centerText;
  const zone = graphe.chartArea;
  if (!ct?.text || !zone) return;
  const ctx = graphe.ctx;
  const cx = (zone.left + zone.right) / 2;
  const cy = (zone.top + zone.bottom) / 2;
  const sombre = document.body.classList.contains("elpis-dark-surface");
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ct.color || (sombre ? "#e2e8f0" : "#334155");
  ctx.font = "600 " + String(ct.size || 22) + "px system-ui, sans-serif";
  ctx.fillText(String(ct.text), cx, ct.subtext ? cy - 6 : cy);
  if (ct.subtext) {
    ctx.font = "400 12px system-ui, sans-serif";
    ctx.globalAlpha = 0.65;
    ctx.fillText(String(ct.subtext), cx, cy + 16);
  }
  ctx.restore();
}

/** Greffons d'options de Chart.js (étiquettes, annotations, texte central), enregistrés une fois après le chargement du groupe. */
export function enregistrerGreffonsChart(): void {
  const w = g();
  const chart = w.Chart;
  if (!chart || chart.__elpisPluginsReady) return;
  if (w.ChartDataLabels) {
    chart.register(w.ChartDataLabels);
    chart.defaults.set("plugins.datalabels", { display: false });
  }
  const annotation = w["chartjs-plugin-annotation"];
  if (annotation) chart.register(annotation);
  chart.register({ id: "elpisCenterText", afterDatasetsDraw: dessinerTexteCentral });
  chart.__elpisPluginsReady = true;
}
