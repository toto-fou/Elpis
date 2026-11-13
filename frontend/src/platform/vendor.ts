// SPDX-License-Identifier: MIT
/** frontend/src/platform/vendor.ts — bibliothèques UMD chargées à la demande (Mermaid, highlight.js, Chart.js, ECharts) depuis les fichiers hachés du build. */
export type GroupeVendor = "mermaid" | "highlight" | "chart" | "echarts";

interface ChartUmd {
  register(...elements: unknown[]): void;
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
  chart: { urls: ["vendor/chart.js"], pret: () => g().Chart !== undefined, apres: enregistrerGreffonsChart },
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

/** Charge un groupe une fois (scripts demandés ensemble, exécutés dans l'ordre ; appels concurrents partagés) ; un échec purge la mémoïsation. */
export function ensureVendor(nom: string): Promise<void> {
  const groupe = (GROUPES as Readonly<Record<string, Groupe | undefined>>)[nom];
  if (!groupe) return Promise.reject(new Error("Groupe vendor inconnu : " + nom));
  if (groupe.pret()) return Promise.resolve();
  const cle = nom as GroupeVendor;
  const deja = enAttente.get(cle);
  if (deja) return deja;
  const p = Promise.all(groupe.urls.map((u) => chargerScript(urlVendor(u))))
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

/** Greffon de texte central de Chart.js, enregistré une fois après le chargement du groupe. */
export function enregistrerGreffonsChart(): void {
  const chart = g().Chart;
  if (!chart || chart.__elpisPluginsReady) return;
  chart.register({ id: "elpisCenterText", afterDatasetsDraw: dessinerTexteCentral });
  chart.__elpisPluginsReady = true;
}
