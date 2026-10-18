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
import { valeurOuNull } from "../../platform/http/resultat";

export type { RapportQuotidien };

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
  const json = (corps: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });

  async function loadDailyReport(date?: string): Promise<void> {
    dailyReportLoading.value = true;
    try {
      const url = "/api/admin/report/daily" + (date ? "?date=" + encodeURIComponent(date) : "");
      const rapport = valeurOuNull(await http.requete(url, {}, { schema: schemaRapportQuotidien }));
      if (rapport) dailyReport.value = rapport;
      const hist = valeurOuNull(
        await http.requete(
          "/api/admin/report/daily/list?limit=30",
          {},
          { schema: schemaReponseHistoriqueRapports },
        ),
      );
      if (hist) reportHistory.value = hist.reports;
      const auto = valeurOuNull(
        await http.requete("/api/admin/report/daily/auto", {}, { schema: schemaReponseRapportAuto }),
      );
      if (auto) dailyDigestAuto.value = auto.enabled;
    } finally {
      dailyReportLoading.value = false;
    }
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
    setDailyDigestAuto,
    loadDailyReport,
    generateDailyReport,
    printDailyReport,
    reportVal,
    reportTitle,
    reportValueSections,
  };
}
