// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/observabilite.ts — console › Supervision › Appels d'outils et Audit : synthèse par outil, dernières erreurs et audit récent filtrable, avec jeton de fraîcheur. */
import type { Ref } from "vue";

import { corpsJson, listeObjets, objet } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";
import { ecrirePeriode, lirePeriode, periodeValide } from "./periode";
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
  const { vue, ctx, e } = b;
  const { ref } = vue;
  const obsScope = ref(lirePeriode());
  const obsAuditPrefix = ref("");
  const obsLoading = ref(false);
  const obsDerniereMaj: Ref<number | null> = ref(null);
  const obsEchec = ref(false);
  const obsSummary: Ref<SyntheseOutils> = ref({ totals: { n: 0 }, per_tool: [] });
  const obsFailures: Ref<ErreurOutil[]> = ref([]);
  const obsAudit: Ref<LigneAudit[]> = ref([]);
  let sequenceOutils = 0;
  let sequenceAudit = 0;
  let enCours = 0;

  function fmtTs(ts: unknown): string {
    if (!ts) return "";
    try {
      return new Date(Number(ts) * 1000).toLocaleString("fr-FR", { hour12: false });
    } catch {
      return "";
    }
  }
  /** Recharge la page affichée (Appels d'outils ou Audit) seulement. */
  function rechargerPage(): void {
    void (e.adminTab.value === "audit" ? loadAuditRecent() : loadToolCalls());
  }
  function setObsScope(h: number): void {
    obsScope.value = periodeValide(h);
    ecrirePeriode(obsScope.value);
    rechargerPage();
  }
  function setObsAuditPrefix(prefixe: unknown): void {
    obsAuditPrefix.value = String(prefixe || "");
    void loadAuditRecent();
  }

  /** Compte des chargements en vol (indicateur commun), fin d'un chargement réussi ou non. */
  function debut(): void {
    enCours += 1;
    obsLoading.value = true;
    obsScope.value = lirePeriode();
  }
  function fin(reussi: boolean, nom: string, relancer: () => Promise<void>, raison: string): void {
    if (reussi) {
      chargementReussi(nom);
      obsEchec.value = false;
      obsDerniereMaj.value = Date.now();
    } else {
      obsEchec.value = true;
      chargementEchoue(nom, raison, relancer);
    }
  }

  /** Appels d'outils : synthèse et dernières erreurs ; seule la dernière demande écrit. */
  async function loadToolCalls(): Promise<void> {
    const moi = ++sequenceOutils;
    debut();
    const heures = obsScope.value;
    try {
      const [rSynthese, rErreurs] = await Promise.all([
        ctx.fetchAuth(`/api/admin/observability/tool-summary?hours=${heures}&limit=50`, {}, true),
        ctx.fetchAuth(`/api/admin/observability/tool-failures?hours=${heures}&limit=100`, {}, true),
      ]);
      if (moi !== sequenceOutils) return;
      if (rSynthese?.ok) {
        const d = objet(await corpsJson(rSynthese));
        if (moi === sequenceOutils)
          obsSummary.value = {
            ...d,
            totals: { n: 0, ...objet(d["totals"]) },
            per_tool: listeObjets(d["per_tool"]) as SyntheseOutils["per_tool"],
          };
      }
      if (rErreurs?.ok) {
        const d = objet(await corpsJson(rErreurs));
        if (moi === sequenceOutils) obsFailures.value = listeObjets(d["items"]) as ErreurOutil[];
      }
      if (moi === sequenceOutils)
        fin(
          !!(rSynthese?.ok && rErreurs?.ok),
          "loadToolCalls",
          loadToolCalls,
          "Réponse du serveur inattendue ou en échec.",
        );
    } catch {
      if (moi === sequenceOutils) fin(false, "loadToolCalls", loadToolCalls, "Erreur réseau.");
    } finally {
      enCours -= 1;
      if (enCours <= 0) obsLoading.value = false;
    }
  }

  /** Journal de sécurité de la période (admins seulement), filtré par préfixe d'action ; seule la dernière demande écrit. */
  async function loadAuditRecent(): Promise<void> {
    const moi = ++sequenceAudit;
    debut();
    const depuis = Date.now() / 1000 - obsScope.value * 3600;
    const jour = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
    try {
      const qs = new URLSearchParams({ from: jour(depuis), to: jour(Date.now() / 1000), limit: "200" });
      if (obsAuditPrefix.value) qs.set("action", obsAuditPrefix.value);
      const r = await ctx.fetchAuth(`/api/admin/audit/events?${qs.toString()}`, {}, true);
      if (moi !== sequenceAudit) return;
      if (r?.ok) {
        const d = objet(await corpsJson(r));
        // La recherche va par jours UTC : les lignes antérieures à la période choisie sont écartées ici.
        const lignes = listeObjets(d["events"]).map((ev) => ({ ...ev, iso: ev["time"] }) as LigneAudit);
        if (moi === sequenceAudit) obsAudit.value = lignes.filter((l) => (l.ts ?? 0) >= depuis);
      }
      if (moi === sequenceAudit)
        fin(!!r?.ok, "loadAuditRecent", loadAuditRecent, "Réponse du serveur inattendue ou en échec.");
    } catch {
      if (moi === sequenceAudit) fin(false, "loadAuditRecent", loadAuditRecent, "Erreur réseau.");
    } finally {
      enCours -= 1;
      if (enCours <= 0) obsLoading.value = false;
    }
  }

  /** Les deux pages à la fois (ancienne surface : un seul chargeur pour Appels d'outils et Audit). */
  async function loadObservability(): Promise<void> {
    await Promise.all([loadToolCalls(), loadAuditRecent()]);
  }

  return {
    obsScope,
    obsAuditPrefix,
    obsLoading,
    obsDerniereMaj,
    obsEchec,
    loadToolCalls,
    loadAuditRecent,
    rechargerPage,
    obsSummary,
    obsFailures,
    obsAudit,
    setObsScope,
    setObsAuditPrefix,
    loadObservability,
    fmtTs,
  };
}
