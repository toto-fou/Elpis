// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/metriques.ts — console › Supervision › Métriques : tableau de bord dynamique (widgets, graphes Chart.js), cadences d'actualisation, visibilité des widgets, purge et export. */
import type { Chart as ChartJs, ChartOptions } from "chart.js";
import type { Ref } from "vue";

import { ensureVendor } from "../../platform/vendor";
import { corpsJson, estObjet, listeObjets, objet } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

declare global {
  interface Window {
    Chart?: typeof ChartJs;
  }
}

export interface WidgetMetrique {
  id: string;
  title: string;
  type: string;
  category?: string;
  default?: boolean;
  width?: number | string;
  purge?: { target?: string; event_types?: string[]; destructive?: boolean };
  [cle: string]: unknown;
}

export interface DonneesWidget {
  labels?: unknown[];
  datasets?: { label?: string; data?: unknown[]; [cle: string]: unknown }[];
  error?: unknown;
  state?: string;
  value?: unknown;
  rows?: Record<string, unknown>[];
  columns?: { key: string; label: string; align?: string }[];
  detail?: string;
  unit?: string;
  icon?: string;
  html?: string;
  meta?: { timezone?: string; granularity?: string; horizontal?: boolean; [cle: string]: unknown };
  [cle: string]: unknown;
}

export interface DonneesTableauBord {
  layout: WidgetMetrique[];
  data: Record<string, DonneesWidget>;
  [cle: string]: unknown;
}

export interface CategorieKpi {
  id: string;
  label: string;
  icon: string;
  color: string;
}

const CLE_PRISES_AUTO = "elpis_admin_auto_open";
const CLE_SONDAGE = "elpis_dashboard_poll_ms";
const CLE_SONDAGE_LIVE = "elpis_live_poll_ms";
const PAS_SONDAGE: readonly number[] = [2000, 3000, 5000, 10000, 15000, 30000, 60000];
const PAS_LIVE: readonly number[] = [500, 1000, 2000, 3000, 5000, 10000];
const CLE_PREFS_WIDGETS = "elpis_widget_prefs";
const CLE_MASQUES = "elpis_hidden_widgets";
const CLE_PORTEE = "elpis_dashboard_scope_hours";
const WIDGETS_LIVE: readonly string[] = ["system_load", "disk_io"];
const PORTEES: readonly number[] = [24, 168, 720];
const ENTETES_JSON = { "Content-Type": "application/json" };

export const KPI_CATEGORIES: readonly CategorieKpi[] = Object.freeze([
  { id: "activity", label: "Activité", icon: "ph-users-three", color: "blue" },
  { id: "volume", label: "Volume", icon: "ph-stack", color: "emerald" },
  { id: "performance", label: "Performance", icon: "ph-gauge", color: "rose" },
  { id: "system", label: "Système", icon: "ph-cpu", color: "amber" },
  { id: "general", label: "Autres", icon: "ph-circle", color: "slate" },
]);

const LIBELLES_PURGE: Readonly<Record<string, string>> = Object.freeze({
  usage_events: "registre de consommation",
  metric_events: "compteurs",
  tool_call_metrics: "appels d'outils",
  daily_usage_reports: "rapports quotidiens",
  editor_routine_runs: "journal des runs de routines",
});

function lireStockage(cle: string): string | null {
  try {
    return localStorage.getItem(cle);
  } catch {
    return null;
  }
}
function ecrireStockage(cle: string, valeur: string): void {
  try {
    localStorage.setItem(cle, valeur);
  } catch {
    /* stockage indisponible */
  }
}

function lirePrefsWidgets(): Record<string, boolean> {
  let prefs: Record<string, boolean>;
  try {
    const brut = objet(JSON.parse(lireStockage(CLE_PREFS_WIDGETS) || "{}"));
    prefs = Object.fromEntries(Object.entries(brut).map(([k, v]) => [k, !!v]));
  } catch {
    prefs = {};
  }
  try {
    // L'ancienne liste de widgets masqués devient autant de « non » explicites, migrée une seule fois.
    const ancien: unknown = JSON.parse(lireStockage(CLE_MASQUES) || "null");
    if (Array.isArray(ancien)) {
      for (const id of ancien) if (typeof id === "string" && prefs[id] === undefined) prefs[id] = false;
      ecrireStockage(CLE_PREFS_WIDGETS, JSON.stringify(prefs));
      localStorage.removeItem(CLE_MASQUES);
    }
  } catch {
    /* migration au mieux */
  }
  return prefs;
}

export function creerMetriques(b: BaseAdmin) {
  const { vue, ctx, lien } = b;
  const { computed, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const dashboardData: Ref<DonneesTableauBord> = ref({ layout: [], data: {} });
  const instances: Record<string, ChartJs> = {};
  let minuterieSondage: ReturnType<typeof setInterval> | null = null;
  let minuterieLive: ReturnType<typeof setInterval> | null = null;
  let minuterieRendu: ReturnType<typeof setTimeout> | null = null;
  let sondageVoulu = false;
  let sequenceStats = 0;

  // ── Cadences ─────────────────────────────────────────────────────────────
  const nombreStocke = (cle: string, valides: readonly number[], defaut: number): number => {
    const v = parseInt(lireStockage(cle) ?? "", 10);
    return valides.includes(v) ? v : defaut;
  };
  const dashboardPollMs = ref(nombreStocke(CLE_SONDAGE, PAS_SONDAGE, 5000));
  const livePollMs = ref(nombreStocke(CLE_SONDAGE_LIVE, PAS_LIVE, 3000));

  const pollLabel = (): string =>
    dashboardPollMs.value >= 60000
      ? dashboardPollMs.value / 60000 + " min"
      : dashboardPollMs.value / 1000 + " s";
  const livePollLabel = (): string =>
    livePollMs.value < 1000 ? livePollMs.value + " ms" : livePollMs.value / 1000 + " s";
  function setPollInterval(ms: number): void {
    if (!PAS_SONDAGE.includes(ms)) return;
    dashboardPollMs.value = ms;
    ecrireStockage(CLE_SONDAGE, String(ms));
    if (minuterieSondage) {
      stopDashboardPolling();
      startDashboardPolling();
    }
  }
  function setLiveInterval(ms: number): void {
    if (!PAS_LIVE.includes(ms)) return;
    livePollMs.value = ms;
    ecrireStockage(CLE_SONDAGE_LIVE, String(ms));
    if (minuterieLive) {
      stopLivePolling();
      startLivePolling();
    }
  }
  const decaler = (pas: readonly number[], courant: number, sens: -1 | 1): number | undefined => {
    const i = pas.indexOf(courant);
    if (sens < 0) return i > 0 ? pas[i - 1] : undefined;
    return i >= 0 && i < pas.length - 1 ? pas[i + 1] : undefined;
  };
  const pollFaster = (): void => {
    const v = decaler(PAS_SONDAGE, dashboardPollMs.value, -1);
    if (v !== undefined) setPollInterval(v);
  };
  const pollSlower = (): void => {
    const v = decaler(PAS_SONDAGE, dashboardPollMs.value, 1);
    if (v !== undefined) setPollInterval(v);
  };
  const liveFaster = (): void => {
    const v = decaler(PAS_LIVE, livePollMs.value, -1);
    if (v !== undefined) setLiveInterval(v);
  };
  const liveSlower = (): void => {
    const v = decaler(PAS_LIVE, livePollMs.value, 1);
    if (v !== undefined) setLiveInterval(v);
  };

  // ── Ouverture automatique de la console après connexion ──────────────────
  const adminAutoOpen = ref(
    !(lireStockage(CLE_PRISES_AUTO) === "0" || lireStockage(CLE_PRISES_AUTO) === "false"),
  );
  function toggleAdminAutoOpen(): void {
    adminAutoOpen.value = !adminAutoOpen.value;
    ecrireStockage(CLE_PRISES_AUTO, adminAutoOpen.value ? "1" : "0");
    showToast(
      adminAutoOpen.value ? "La console s'ouvrira à la connexion." : "Le chat s'ouvrira à la connexion.",
    );
  }

  // ── Portée et visibilité des widgets ─────────────────────────────────────
  const dashboardScope = ref(
    PORTEES.includes(parseInt(lireStockage(CLE_PORTEE) || "24", 10))
      ? parseInt(lireStockage(CLE_PORTEE) || "24", 10)
      : 24,
  );
  function setDashboardScope(heures: number): void {
    if (!PORTEES.includes(heures)) return;
    dashboardScope.value = heures;
    ecrireStockage(CLE_PORTEE, String(heures));
    void loadAdminStats();
  }

  const widgetPrefs: Ref<Record<string, boolean>> = ref(lirePrefsWidgets());
  const defautWidget = (id: string): boolean => {
    const w = dashboardData.value.layout.find((l) => l.id === id);
    return w ? w.default !== false : false;
  };
  const isWidgetVisible = (id: string): boolean => {
    const pref = widgetPrefs.value[id];
    return pref === undefined ? defautWidget(id) : !!pref;
  };
  /** Un widget graphe masqué détruit son instance Chart.js ; réaffiché, il est recréé au tick suivant. */
  function toggleWidgetVisibility(id: string): void {
    const etaitVisible = isWidgetVisible(id);
    const suivant = !etaitVisible;
    if (suivant === defautWidget(id)) delete widgetPrefs.value[id];
    else widgetPrefs.value[id] = suivant;
    widgetPrefs.value = { ...widgetPrefs.value };
    ecrireStockage(CLE_PREFS_WIDGETS, JSON.stringify(widgetPrefs.value));
    if (etaitVisible) {
      const inst = instances[id];
      if (inst) {
        try {
          inst.destroy();
        } catch {
          /* déjà détruite */
        }
        delete instances[id];
      }
    } else {
      void ctx.nextTick().then(renderDynamicDashboard);
    }
  }
  function resetWidgetPrefs(): void {
    widgetPrefs.value = {};
    try {
      localStorage.removeItem(CLE_PREFS_WIDGETS);
    } catch {
      /* stockage indisponible */
    }
    destroyAllCharts();
    void ctx.nextTick().then(renderDynamicDashboard);
    showToast("Affichage revenu au set par défaut");
  }

  const kpisInCategory = (catId: string): WidgetMetrique[] =>
    dashboardData.value.layout.filter(
      (w) => w.type === "value" && isWidgetVisible(w.id) && (w.category || "general") === catId,
    );
  const chartsInCategory = (catId: string): WidgetMetrique[] =>
    dashboardData.value.layout.filter(
      (w) => w.type !== "value" && isWidgetVisible(w.id) && (w.category || "general") === catId,
    );
  const kpiGroups = computed(() =>
    KPI_CATEGORIES.map((c) => ({ id: c.id, label: c.label, items: kpisInCategory(c.id) })).filter(
      (g) => g.items.length,
    ),
  );
  const chartGroups = computed(() =>
    KPI_CATEGORIES.map((c) => ({ id: c.id, label: c.label, items: chartsInCategory(c.id) })).filter(
      (g) => g.items.length,
    ),
  );
  try {
    localStorage.removeItem("elpis_metrics_subtab");
  } catch {
    /* stockage indisponible */
  }

  /** État d'un indicateur : le serveur ne pose `state` que sur une valeur anormale. */
  function kpiState(id: string): "" | "warn" | "danger" {
    const s = dashboardData.value.data[id]?.state;
    return s === "danger" || s === "warn" ? s : "";
  }

  /** Résumé texte d'un graphe pour les lecteurs d'écran (un canvas est muet). */
  function chartSummary(widget: WidgetMetrique): string {
    const d = dashboardData.value.data[widget.id];
    if (!d || d.error || !(d.labels && d.labels.length)) return widget.title + " : aucune donnée";
    const fmt = (v: unknown): string => {
      const n = Number(v);
      return Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString("fr-FR") : String(v);
    };
    const series = (d.datasets ?? []).slice(0, 4);
    let parts: string[];
    if (d.labels.length <= 8) {
      parts = series.map(
        (ds) =>
          (ds.label && series.length > 1 ? ds.label + " : " : "") +
          d.labels!.map((l, i) => String(l) + " " + fmt((ds.data ?? [])[i])).join(", "),
      );
    } else {
      parts = series
        .map((ds) => {
          const vals = (ds.data ?? []).map(Number).filter(Number.isFinite);
          if (!vals.length) return "";
          return (
            (ds.label ? ds.label + " : " : "") +
            "dernier " +
            fmt(vals[vals.length - 1]) +
            ", maximum " +
            fmt(Math.max(...vals))
          );
        })
        .filter(Boolean);
      parts.unshift(d.labels.length + " points");
    }
    return widget.title + ". " + parts.join(" ; ");
  }

  const allWidgetsList = (): {
    id: string;
    title: string;
    type: string;
    category: string;
    isDefault: boolean;
    visible: boolean;
  }[] =>
    dashboardData.value.layout.map((w) => ({
      id: w.id,
      title: w.title,
      type: w.type,
      category: w.category || "general",
      isDefault: w.default !== false,
      visible: isWidgetVisible(w.id),
    }));

  // ── Réinitialisation des métriques ───────────────────────────────────────
  /** Deux temps : le volume exact est annoncé (`dry_run`), puis la suppression est confirmée. */
  async function purger(
    corps: Record<string, unknown>,
    titre: string,
    avertissement: string,
    motTape?: string,
  ): Promise<boolean> {
    const sonde = await fetchAuth("/api/admin/metrics/purge", {
      method: "POST",
      headers: ENTETES_JSON,
      body: JSON.stringify({ ...corps, dry_run: true }),
    });
    if (!sonde || !sonde.ok) {
      showToast("Purge indisponible", "error");
      return false;
    }
    const info = objet(await corpsJson(sonde));
    const comptes = objet(info["counted"]);
    const total = Object.values(comptes).reduce<number>((a, n) => a + (Number(n) || 0), 0);
    if (!total) {
      showToast("Rien à supprimer sur ce périmètre");
      return false;
    }
    const detail = Object.entries(comptes)
      .filter(([, n]) => Number(n) > 0)
      .map(([k, n]) => `${String(n)} ${LIBELLES_PURGE[k] || k}`)
      .join(" · ");
    const message = `${detail}. Suppression définitive.` + (avertissement ? " " + avertissement : "");
    const ok =
      motTape && ctx.openTypedConfirm
        ? await ctx.openTypedConfirm(titre, message, motTape, "Supprimer")
        : await openConfirm(titre, message, true, "Supprimer");
    if (!ok) return false;
    const res = await fetchAuth("/api/admin/metrics/purge", {
      method: "POST",
      headers: ENTETES_JSON,
      body: JSON.stringify({ ...corps, dry_run: false }),
    });
    if (!res || !res.ok) {
      showToast("Échec de la purge", "error");
      return false;
    }
    const fait = objet(objet(await corpsJson(res))["deleted"]);
    const n = Object.values(fait).reduce<number>((a, v) => a + (Number(v) || 0), 0);
    showToast(`${n} ligne(s) supprimée(s)`, "success");
    await loadAdminStats();
    return true;
  }
  async function resetWidget(widget: WidgetMetrique | null | undefined): Promise<void> {
    const spec = widget?.purge;
    if (!widget || !spec || !spec.target) return;
    await purger(
      { targets: [spec.target], event_types: spec.event_types || undefined },
      `Réinitialiser « ${widget.title} »`,
      spec.destructive ? "Ce périmètre contient le journal des runs, pas seulement des compteurs." : "",
    );
  }
  async function resetAllMetrics(): Promise<void> {
    await purger(
      { targets: ["usage_events", "metric_events", "tool_call_metrics"] },
      "Remettre toutes les métriques à zéro",
      "Le journal des runs de routines et les rapports quotidiens sont conservés.",
      "PURGER",
    );
  }
  /** Export du périmètre avant purge, proposé à côté de chaque action. */
  function exportUsage(jours?: number): void {
    void lien.downloadWithModal(
      "/api/admin/export-metrics?target=usage_events&days=" + (jours || 30),
      "Export du registre de consommation",
      "usage_events.csv",
    );
  }

  // ── Chargement et rendu ──────────────────────────────────────────────────
  /** Une réponse sans `layout` ne doit pas remplacer la forme attendue par tout le fichier : normalisée à la source. */
  async function loadAdminStats(): Promise<void> {
    const maSequence = ++sequenceStats;
    try {
      const res = await fetchAuth("/api/admin/stats-dynamic?scope_hours=" + (dashboardScope.value || 24));
      if (maSequence !== sequenceStats) return;
      if (!res?.ok) {
        chargementEchoue("loadAdminStats", "Réponse du serveur inattendue ou en échec.", loadAdminStats);
      } else {
        chargementReussi("loadAdminStats");
        const json = objet(await corpsJson(res));
        if (maSequence !== sequenceStats) return;
        dashboardData.value = {
          ...json,
          layout: listeObjets(json["layout"]) as WidgetMetrique[],
          data: estObjet(json["data"]) ? (json["data"] as Record<string, DonneesWidget>) : {},
        };
        if (minuterieRendu) clearTimeout(minuterieRendu);
        minuterieRendu = setTimeout(() => {
          minuterieRendu = null;
          void ctx.nextTick().then(renderDynamicDashboard);
        }, 150);
      }
    } catch {
      chargementEchoue("loadAdminStats", "Erreur réseau.", loadAdminStats);
    }
  }

  function optionsGraphique(widget: WidgetMetrique, donnees: DonneesWidget): ChartOptions {
    const meta = donnees.meta ?? {};
    const options: Record<string, unknown> = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: { legend: { display: widget.type !== "bar", position: "bottom" } },
    };
    const plugins = options["plugins"] as Record<string, unknown>;
    if (meta.granularity) {
      const labels = (donnees.labels ?? []).map(String);
      const court = labels.map((l, i) => {
        if (meta.granularity === "day") return l.slice(5);
        const jour = l.slice(0, 10);
        const heure = l.slice(11, 16);
        const veille = i > 0 ? (labels[i - 1] ?? "").slice(0, 10) : null;
        return i === 0 || jour !== veille ? jour.slice(5) + " " + heure : heure;
      });
      options["scales"] = {
        x: {
          ticks: { autoSkip: true, maxRotation: 0, callback: (_v: unknown, i: number) => court[i] ?? "" },
        },
        y: { beginAtZero: true },
      };
      plugins["tooltip"] = {
        callbacks: {
          title: (items: { dataIndex: number }[]) =>
            items && items[0] ? (labels[items[0].dataIndex] ?? "") : "",
        },
      };
      if (meta.timezone) {
        plugins["subtitle"] = {
          display: true,
          text: "Fuseau : " + meta.timezone,
          position: "bottom",
          font: { size: 10 },
        };
      }
    }
    if (widget.id === "system_load") {
      options["scales"] = { y: { min: 0, max: 100 } };
      options["animation"] = { duration: 0 };
    }
    if (widget.id === "disk_io") {
      options["scales"] = { y: { min: 0, beginAtZero: true } };
      options["animation"] = { duration: 0 };
    }
    if (widget.id === "models_usage") {
      options["scales"] = {
        y: { type: "linear", position: "left", beginAtZero: true, title: { display: true, text: "Appels" } },
        y1: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          title: { display: true, text: "Tokens" },
          grid: { drawOnChartArea: false },
        },
      };
      plugins["legend"] = { display: true, position: "bottom" };
    }
    if (widget.type === "bar_stacked") {
      const xPrec = objet(objet(options["scales"])["x"]);
      options["scales"] = {
        x: { ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 } }, ...xPrec, stacked: true },
        y: { stacked: true, beginAtZero: true },
      };
      plugins["legend"] = { display: true, position: "bottom" };
      if (meta.horizontal) {
        options["indexAxis"] = "y";
        options["scales"] = {
          x: { stacked: true, beginAtZero: true },
          y: { stacked: true, ticks: { autoSkip: false, font: { size: 10 } } },
        };
      }
    }
    return options as ChartOptions;
  }

  /** Chart.js est demandé à la volée (une fois) ; sans lui, le rendu est reporté. */
  function renderDynamicDashboard(): void {
    const Constructeur = window.Chart;
    if (!Constructeur) {
      ensureVendor("chart").then(renderDynamicDashboard, () => undefined);
      return;
    }
    for (const id of Object.keys(instances)) {
      const canvas = document.getElementById(`chart_${id}`);
      if (!dashboardData.value.layout.find((l) => l.id === id) || !canvas || !isWidgetVisible(id)) {
        instances[id]?.destroy();
        delete instances[id];
      }
    }
    for (const widget of dashboardData.value.layout) {
      if (!isWidgetVisible(widget.id)) continue;
      const donnees = dashboardData.value.data[widget.id];
      if (widget.type === "value" || widget.type === "table") continue;
      if (!donnees || donnees.error) continue;
      const canvas = document.getElementById(`chart_${widget.id}`);
      if (!(canvas instanceof HTMLCanvasElement)) continue;
      const type = widget.type === "bar_stacked" ? "bar" : widget.type;
      const existante = instances[widget.id];
      if (existante && existante.canvas === canvas) {
        existante.data = donnees as unknown as typeof existante.data;
        existante.update("none");
      } else {
        existante?.destroy();
        instances[widget.id] = new Constructeur(canvas, {
          type: type as "bar",
          data: donnees as unknown as { datasets: [] },
          options: optionsGraphique(widget, donnees) as ChartOptions<"bar">,
        });
      }
    }
  }

  async function refreshLiveWidgets(): Promise<void> {
    try {
      const res = await fetchAuth(
        "/api/admin/stats-dynamic?ids=" + encodeURIComponent(WIDGETS_LIVE.join(",")),
      );
      if (!res || !res.ok) return;
      const json = objet(await corpsJson(res));
      const donnees = objet(json["data"]);
      for (const wid of WIDGETS_LIVE) {
        const neuf = donnees[wid];
        if (!estObjet(neuf) || neuf["error"]) continue;
        dashboardData.value.data[wid] = neuf as DonneesWidget;
        const inst = instances[wid];
        if (inst) {
          inst.data = neuf as unknown as typeof inst.data;
          inst.update("none");
        }
      }
    } catch {
      /* au mieux */
    }
  }
  function startLivePolling(): void {
    if (minuterieLive || document.hidden) return;
    minuterieLive = setInterval(() => void refreshLiveWidgets(), livePollMs.value);
  }
  function stopLivePolling(): void {
    if (minuterieLive) {
      clearInterval(minuterieLive);
      minuterieLive = null;
    }
  }
  function startDashboardPolling(): void {
    sondageVoulu = true;
    if (!minuterieSondage && !document.hidden)
      minuterieSondage = setInterval(() => void loadAdminStats(), dashboardPollMs.value);
    startLivePolling();
  }
  function stopDashboardPolling(): void {
    sondageVoulu = false;
    if (minuterieSondage) {
      clearInterval(minuterieSondage);
      minuterieSondage = null;
    }
    if (minuterieRendu) {
      clearTimeout(minuterieRendu);
      minuterieRendu = null;
    }
    stopLivePolling();
    destroyAllCharts();
  }
  /** Détruit toutes les instances Chart.js vivantes : leur écouteur de redimensionnement global survivrait au canvas retiré. */
  function destroyAllCharts(): void {
    for (const id of Object.keys(instances)) {
      try {
        instances[id]?.destroy();
      } catch {
        /* déjà détruite */
      }
      delete instances[id];
    }
  }

  /** Onglet en arrière-plan : les sondages se suspendent, l'intention est conservée. */
  function auChangementDeVisibilite(): void {
    if (document.hidden) {
      if (minuterieSondage) {
        clearInterval(minuterieSondage);
        minuterieSondage = null;
      }
      stopLivePolling();
    } else if (sondageVoulu) {
      startDashboardPolling();
    }
  }
  document.addEventListener("visibilitychange", auChangementDeVisibilite);
  const liberer = (): void => {
    destroyAllCharts();
    document.removeEventListener("visibilitychange", auChangementDeVisibilite);
    sondageVoulu = false;
  };

  return {
    dashboardData,
    dashboardScope,
    setDashboardScope,
    widgetPrefs,
    isWidgetVisible,
    toggleWidgetVisibility,
    allWidgetsList,
    resetWidgetPrefs,
    resetWidget,
    resetAllMetrics,
    exportUsage,
    kpiCategories: KPI_CATEGORIES,
    kpisInCategory,
    chartsInCategory,
    kpiGroups,
    chartGroups,
    kpiState,
    chartSummary,
    loadAdminStats,
    renderDynamicDashboard,
    startDashboardPolling,
    stopDashboardPolling,
    destroyAllCharts,
    dashboardPollMs,
    pollLabel,
    pollFaster,
    pollSlower,
    livePollMs,
    livePollLabel,
    liveFaster,
    liveSlower,
    adminAutoOpen,
    toggleAdminAutoOpen,
    liberer,
  };
}
