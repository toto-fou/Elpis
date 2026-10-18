// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/prometheus.ts — console › Métriques : jeton de scrape Prometheus (`/api/admin/metrics/scrape-token`) et URL à copier. */
import { ref } from "vue";
import type { Ref } from "vue";
import { schemaReponseJetonScrape } from "@elpis/contracts";
import type { z } from "zod";

import type { ClientHttp } from "../../platform/http/client";

export interface EtatJetonScrape {
  configured: boolean;
  token: string | null;
  loading: boolean;
}

export interface CtxPrometheusAdmin {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean, libelle?: string): Promise<boolean>;
}

export function setupAdminPrometheus(ctx: CtxPrometheusAdmin | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const scrapeToken: Ref<EtatJetonScrape> = ref({ configured: false, token: null, loading: false });
  const poser = (j: z.infer<typeof schemaReponseJetonScrape>): void => {
    scrapeToken.value = { configured: j.configured, token: j.token, loading: false };
  };

  async function loadScrapeToken(): Promise<void> {
    scrapeToken.value.loading = true;
    const r = await http.requete("/api/admin/metrics/scrape-token", {}, { schema: schemaReponseJetonScrape });
    if (r.type === "ok") poser(r.valeur);
    else scrapeToken.value.loading = false;
  }

  async function setScrapeToken(action: string): Promise<void> {
    if (action === "revoke") {
      const ok = await ctx?.openConfirm?.(
        "Révoquer le jeton",
        "Les collecteurs qui l'utilisent cesseront de recevoir les métriques.",
        true,
        "Révoquer",
      );
      if (!ok) return;
    }
    const r = await http.requete(
      "/api/admin/metrics/scrape-token",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) },
      { schema: schemaReponseJetonScrape },
    );
    if (r.type !== "ok") {
      toast("Opération refusée", "error");
      return;
    }
    poser(r.valeur);
    toast(action === "revoke" ? "Jeton révoqué" : "Jeton généré", "success");
  }

  function copier(texte: string, succes: string): void {
    navigator.clipboard.writeText(texte).then(
      () => toast(succes),
      () => toast("Erreur de copie", "error"),
    );
  }

  function copyScrapeToken(): void {
    const t = scrapeToken.value.token;
    if (t) copier(t, "Jeton copié");
  }

  const prometheusUrl = (): string => window.location.origin + "/api/admin/metrics/prometheus";
  const copyPrometheusUrl = (): void => copier(prometheusUrl(), "URL copiée dans le presse-papier");

  return { scrapeToken, loadScrapeToken, setScrapeToken, copyScrapeToken, prometheusUrl, copyPrometheusUrl };
}
