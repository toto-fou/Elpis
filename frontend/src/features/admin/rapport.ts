// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/rapport.ts — console › Supervision › Rapport : rapport quotidien d'usage IA (`/api/admin/report/daily*`), historique et envoi automatique. */
import { computed, ref } from "vue";
import type { Ref } from "vue";
import {
  schemaRapportQuotidien,
  schemaReponseHistoriqueRapports,
  schemaReponseRapportAuto,
  schemaReponseRapportAutoEcrit,
} from "@elpis/contracts";
import type { RapportQuotidien } from "@elpis/contracts";

import type { ClientHttp } from "../../platform/http/client";
import { messageErreur, valeurOuNull } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";

export type { RapportQuotidien };

const CLE_GRAPHIQUES = "elpis_rapport_graphiques";

/** Choix mémorisé des graphiques (affichés par défaut) ; stockage en échec : affichés. */
function lireGraphiques(): boolean {
  try {
    return localStorage.getItem(CLE_GRAPHIQUES) !== "0";
  } catch {
    return true;
  }
}

function ecrireGraphiques(on: boolean): void {
  try {
    localStorage.setItem(CLE_GRAPHIQUES, on ? "1" : "0");
  } catch {
    /* stockage indisponible */
  }
}

/** Écoute Échap sur le document ; renvoie la fonction qui retire l'écouteur. */
export function ecouterEchap(rappel: () => void): () => void {
  const f = (e: KeyboardEvent): void => {
    if (e.key === "Escape") rappel();
  };
  document.addEventListener("keydown", f);
  return () => document.removeEventListener("keydown", f);
}

export interface SerieRapport {
  id: string;
  titre: string;
  type: "line" | "bar";
  empile: boolean;
  labels: string[];
  datasets: { label: string; data: number[] }[];
}

/** Forme de tracé des 9 graphiques du rapport (`REPORT_SECTIONS`) ; le doughnut des outils devient des barres. */
const FORMES: Readonly<Record<string, { type: "line" | "bar"; empile: boolean }>> = {
  usage_timeline: { type: "bar", empile: true },
  usage_input_timeline: { type: "bar", empile: true },
  usage_thinking_timeline: { type: "bar", empile: true },
  usage_by_model: { type: "bar", empile: true },
  usage_top_users: { type: "bar", empile: true },
  routine_runs_timeline: { type: "bar", empile: true },
  latency_percentiles: { type: "bar", empile: false },
  tools_usage: { type: "bar", empile: false },
  active_users_day: { type: "line", empile: false },
};

const MAX_JEUX = 8;

/** Au-delà de `MAX_JEUX` jeux, les derniers sont additionnés dans « Autres ». */
function regrouperJeux(jeux: { label: string; data: number[] }[]): { label: string; data: number[] }[] {
  if (jeux.length <= MAX_JEUX) return jeux;
  const reste = jeux.slice(MAX_JEUX - 1);
  const somme = (reste[0]?.data ?? []).map((_, i) => reste.reduce((t, j) => t + (j.data[i] ?? 0), 0));
  return [...jeux.slice(0, MAX_JEUX - 1), { label: "Autres", data: somme }];
}

export interface TableauRapport {
  id: string;
  titre: string;
  colonnes: { key: string; label: string; align?: string }[];
  lignes: Record<string, unknown>[];
}

/** Séries et tableaux de la section « Graphiques » du rapport, tels que le serveur les a stockés (rien n'est inventé). */
export function elementsGraphiques(r: RapportQuotidien | null): {
  series: SerieRapport[];
  tableaux: TableauRapport[];
} {
  const series: SerieRapport[] = [];
  const tableaux: TableauRapport[] = [];
  const section = r?.sections?.find((s) => s.id === "charts");
  for (const id of section?.widgets ?? []) {
    const w = r?.widgets?.[id];
    if (!w || w.error) continue;
    const titre = r?.titles?.[id] || id;
    if (w.labels?.length && w.datasets?.length) {
      const datasets = regrouperJeux(
        w.datasets.map((d) => ({
          label: d.label ?? "",
          data: (d.data ?? []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0)),
        })),
      );
      const forme = FORMES[id] ?? { type: "bar", empile: datasets.length > 1 };
      series.push({ id, titre, ...forme, labels: w.labels.map(String), datasets });
    } else if (w.columns?.length && w.rows?.length) {
      const colonnes = w.columns.map((c) => ({
        key: c.key,
        label: c.label,
        ...(typeof c["align"] === "string" ? { align: c["align"] } : {}),
      }));
      tableaux.push({ id, titre, colonnes, lignes: w.rows.slice(0, 20) });
    }
  }
  return { series, tableaux };
}

/** Raison lisible d'un échec : détail du serveur d'abord, statut HTTP ajouté s'il n'y figure pas déjà. */
function raisonEchec(r: ApiResult<unknown>): string {
  const detail = "erreur" in r ? r.erreur.detail : null;
  const base = detail || messageErreur(r) || "Échec";
  return "statut" in r && r.statut && !base.includes(String(r.statut)) ? `${base} (HTTP ${r.statut})` : base;
}

export interface CtxRapportAdmin {
  showToast?(message: string, type?: string): void;
}

export function setupAdminRapport(ctx: CtxRapportAdmin | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const dailyReport: Ref<RapportQuotidien | null> = ref(null);
  const dailyReportLoading = ref(false);
  const dailyReportGenerating = ref(false);
  const reportHistory: Ref<Array<{ date: string; created_at: number }>> = ref([]);
  const dailyDigestAuto = ref(true);
  const dailyReportError: Ref<string | null> = ref(null);
  const reportDay = ref("");
  const reportCharts = ref(lireGraphiques());
  const reportPreview = ref(false);
  let seq = 0;
  const json = (corps: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });

  async function loadDailyReport(date?: string): Promise<void> {
    const moi = ++seq;
    dailyReportLoading.value = true;
    reportDay.value = date ?? "";
    dailyReportError.value = null;
    try {
      const url = "/api/admin/report/daily" + (date ? "?date=" + encodeURIComponent(date) : "");
      const r = await http.requete(url, {}, { schema: schemaRapportQuotidien });
      if (moi !== seq) return;
      if (r.type === "ok") dailyReport.value = r.valeur;
      else if (r.type !== "perime" && r.type !== "annulation") {
        dailyReport.value = null;
        dailyReportError.value = raisonEchec(r);
      }
      const hist = valeurOuNull(
        await http.requete(
          "/api/admin/report/daily/list?limit=30",
          {},
          { schema: schemaReponseHistoriqueRapports },
        ),
      );
      if (moi !== seq) return;
      if (hist) reportHistory.value = hist.reports;
      const auto = valeurOuNull(
        await http.requete("/api/admin/report/daily/auto", {}, { schema: schemaReponseRapportAuto }),
      );
      if (moi !== seq) return;
      if (auto) dailyDigestAuto.value = auto.enabled;
    } finally {
      if (moi === seq) dailyReportLoading.value = false;
    }
  }

  const retryDailyReport = (): Promise<void> => loadDailyReport(reportDay.value || undefined);

  function setReportCharts(on: boolean): void {
    reportCharts.value = on;
    ecrireGraphiques(on);
  }

  async function setDailyDigestAuto(enabled: unknown): Promise<void> {
    const r = await http.requete("/api/admin/report/daily/auto", json({ enabled: !!enabled }), {
      schema: schemaReponseRapportAutoEcrit,
    });
    if (r.type === "ok") {
      dailyDigestAuto.value = r.valeur.enabled;
      toast(
        dailyDigestAuto.value
          ? "Rapport quotidien automatique activé"
          : "Rapport quotidien automatique désactivé",
        "success",
      );
    } else if (
      r.type === "requete" ||
      r.type === "refus" ||
      r.type === "serveur" ||
      r.type === "conflit" ||
      r.type === "invalide"
    ) {
      toast("Échec de la mise à jour", "error");
    } else toast("Erreur réseau", "error");
  }

  async function generateDailyReport(): Promise<void> {
    dailyReportGenerating.value = true;
    try {
      const r = await http.requete("/api/admin/report/daily/generate", { method: "POST" });
      if (r.type === "ok") {
        toast("Rapport généré et notifié aux admins", "success");
        await loadDailyReport();
      } else if (
        r.type === "reseau" ||
        r.type === "annulation" ||
        r.type === "perime" ||
        r.type === "expiration"
      ) {
        toast("Erreur réseau", "error");
      } else toast("Échec de la génération", "error");
    } finally {
      dailyReportGenerating.value = false;
    }
  }

  const openReportPreview = (): void => {
    reportPreview.value = true;
  };
  const closeReportPreview = (): void => {
    reportPreview.value = false;
  };
  const printDailyReport = (): void => window.print();

  function reportVal(wid: string): string {
    const d = dailyReport.value?.widgets?.[wid];
    if (!d || typeof d !== "object" || "error" in d) return "—";
    const { value, unit } = d as { value?: unknown; unit?: unknown };
    if (value === null || value === undefined) return "—";
    return unit ? String(value) + " " + String(unit) : String(value);
  }

  const reportTitle = (wid: string): string => dailyReport.value?.titles?.[wid] || wid;

  const reportValueSections = computed(() =>
    (dailyReport.value?.sections ?? []).filter((s) => s.id !== "charts"),
  );

  return {
    dailyReport,
    dailyReportLoading,
    dailyReportGenerating,
    reportHistory,
    dailyDigestAuto,
    dailyReportError,
    reportDay,
    reportCharts,
    reportPreview,
    retryDailyReport,
    setReportCharts,
    openReportPreview,
    closeReportPreview,
    setDailyDigestAuto,
    loadDailyReport,
    generateDailyReport,
    printDailyReport,
    reportVal,
    reportTitle,
    reportValueSections,
  };
}
