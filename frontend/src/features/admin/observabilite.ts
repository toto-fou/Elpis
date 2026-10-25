// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/observabilite.ts — console › Supervision › Appels d'outils et Audit : synthèse par outil, dernières erreurs et audit récent filtrable, avec jeton de fraîcheur. */
import type { Ref } from "vue";

import { corpsJson, listeObjets, objet } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { chargementEchoue, chargementReussi } from "./suivi-chargement";

export interface SyntheseOutils {
  totals: {
    n: number;
    total_ms?: number;
    n_error?: number;
    n_blocked?: number;
    n_timeout?: number;
    [cle: string]: unknown;
  };
  per_tool: {
    tool_name: string;
    n: number;
    total_ms: number;
    n_failed: number;
    avg_ms: number;
    [cle: string]: unknown;
  }[];
  [cle: string]: unknown;
}
export interface ErreurOutil {
  ts: number;
  run_id: string | null;
  node_id: string | null;
  tool_name: string;
  status: string;
  duration_ms: number | null;
  error_short: string | null;
  [cle: string]: unknown;
}
export interface LigneAudit {
  ts?: number;
  iso?: string;
  action: string;
  user_id?: number | null;
  username?: string | null;
  service?: string;
  details?: unknown;
  [cle: string]: unknown;
}

export function creerObservabilite(b: BaseAdmin) {
  const { vue, ctx, lien } = b;
  const { ref } = vue;
  const obsScope = ref(24);
  const obsAuditPrefix = ref("");
  const obsLoading = ref(false);
  const obsSummary: Ref<SyntheseOutils> = ref({ totals: { n: 0 }, per_tool: [] });
  const obsFailures: Ref<ErreurOutil[]> = ref([]);
  const obsAudit: Ref<LigneAudit[]> = ref([]);
  let sequence = 0;

  function fmtTs(ts: unknown): string {
    if (!ts) return "";
    try {
      return new Date(Number(ts) * 1000).toLocaleString("fr-FR", { hour12: false });
    } catch {
      return "";
    }
  }
  function setObsScope(h: number): void {
    obsScope.value = h === 168 || h === 720 ? h : 24;
    void loadObservability();
  }
  function setObsAuditPrefix(prefixe: unknown): void {
    obsAuditPrefix.value = String(prefixe || "");
    void loadObservability();
  }

  /** Seule la dernière demande a le droit d'écrire : une réponse lente ne doit pas écraser une réponse récente. */
  async function loadObservability(): Promise<void> {
    const maSequence = ++sequence;
    obsLoading.value = true;
    const heures = obsScope.value;
    try {
      const [rSynthese, rErreurs, rAudit] = await Promise.all([
        ctx.fetchAuth(`/api/admin/observability/tool-summary?hours=${heures}&limit=50`, {}, true),
        ctx.fetchAuth(`/api/admin/observability/tool-failures?hours=${heures}&limit=100`, {}, true),
        ctx.fetchAuth(
          `/api/admin/observability/audit-recent?hours=${Math.min(heures, 168)}&limit=200` +
            (obsAuditPrefix.value ? `&action_prefix=${encodeURIComponent(obsAuditPrefix.value)}` : ""),
          {},
          true,
        ),
      ]);
      if (maSequence !== sequence) return;
      if (rSynthese?.ok && rErreurs?.ok && rAudit?.ok) chargementReussi("loadObservability");
      else
        chargementEchoue(
          "loadObservability",
          "Réponse du serveur inattendue ou en échec.",
          loadObservability,
        );
      if (rSynthese?.ok) {
        const d = objet(await corpsJson(rSynthese));
        if (maSequence === sequence) {
          obsSummary.value = {
            ...d,
            totals: { n: 0, ...objet(d["totals"]) },
            per_tool: listeObjets(d["per_tool"]) as SyntheseOutils["per_tool"],
          };
        }
      }
      if (rErreurs?.ok) {
        const d = objet(await corpsJson(rErreurs));
        if (maSequence === sequence) obsFailures.value = listeObjets(d["items"]) as ErreurOutil[];
      }
      if (rAudit?.ok) {
        const d = objet(await corpsJson(rAudit));
        if (maSequence === sequence) obsAudit.value = listeObjets(d["items"]) as LigneAudit[];
      }
      if (maSequence !== sequence) return;
      // Le tampon serveur amorce la console de journaux, puis le flux en direct l'alimente.
      await lien.loadRecentLogs();
    } catch {
      chargementEchoue("loadObservability", "Erreur réseau.", loadObservability);
    } finally {
      if (maSequence === sequence) obsLoading.value = false;
    }
  }

  return {
    obsScope,
    obsAuditPrefix,
    obsLoading,
    obsSummary,
    obsFailures,
    obsAudit,
    setObsScope,
    setObsAuditPrefix,
    loadObservability,
    fmtTs,
  };
}
