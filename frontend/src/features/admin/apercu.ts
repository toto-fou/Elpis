// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/apercu.ts — vue d'ensemble de la console (« À traiter », services, dernières 24 h) et état « Redémarrage nécessaire ». */
import { schemaReponseEtatRedemarrage, schemaReponseVueEnsemble } from "@elpis/contracts";
import type { ReponseVueEnsemble } from "@elpis/contracts";
import type { Ref } from "vue";

import { lireSchema } from "../../utils/lecture-json";
import type { BaseAdmin } from "./etat";

const schemaVue = schemaReponseVueEnsemble.partial().required({ alerts: true, services: true });

type ActionApercu = { action: string; page?: string };

const ETATS_SERVICE: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  ok: ["Joignable", "ph-check-circle"],
  down: ["Injoignable", "ph-x-circle"],
  warn: ["À vérifier", "ph-warning"],
  off: ["Désactivé", "ph-minus-circle"],
  unknown: ["Inconnu", "ph-question"],
});
const ETAT_INCONNU: readonly [string, string] = ["Inconnu", "ph-question"];

function tempsRelatif(ts: number | null | undefined): string {
  if (!ts) return "jamais";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return "il y a " + Math.max(1, Math.round(s / 60)) + " min";
  if (s < 86400) return "il y a " + Math.round(s / 3600) + " h";
  return "il y a " + Math.round(s / 86400) + " j";
}

export function fmtCompact(n: unknown): string {
  const v = Number(n) || 0;
  if (v >= 1e6) return (Math.round(v / 1e5) / 10).toLocaleString("fr-FR") + " M";
  if (v >= 1e4) return Math.round(v / 1e3).toLocaleString("fr-FR") + " k";
  return v.toLocaleString("fr-FR");
}

export function creerApercu(b: BaseAdmin) {
  const { vue, ctx, e, nav, lien } = b;
  const { computed, ref } = vue;
  const overview: Ref<ReponseVueEnsemble | null> = ref(null);
  const overviewLoading = ref(false);
  const overviewFailed = ref(false);
  const overviewNow = ref(Date.now());
  let minuterie: ReturnType<typeof setInterval> | null = null;

  /** Une tournée serveur (cache 15 s côté serveur) ; un corps partiel est complété pour ne pas casser le rendu. */
  async function loadOverview(refresh?: unknown): Promise<void> {
    overviewLoading.value = true;
    try {
      const r = await ctx.fetchAuth("/api/admin/overview" + (refresh === true ? "?refresh=1" : ""), {}, true);
      const d = await lireSchema(r, schemaVue);
      if (d) {
        overview.value = {
          generated_at: d.generated_at ?? 0,
          alerts: d.alerts,
          services: d.services,
          kpis: { users: 0, turns: 0, tokens: 0, failures: 0, tool_calls: 0, tool_failures: 0, ...d.kpis },
          backup: d.backup ?? { at: null, remote_enabled: false },
          setup: Array.isArray(d.setup) ? d.setup : [],
          restart: d.restart ?? { pending: [] },
          role: d.role ?? "admin",
        };
        overviewFailed.value = false;
        e.restartPending.value = overview.value.restart.pending;
      } else overviewFailed.value = true;
    } catch {
      overviewFailed.value = true;
    } finally {
      overviewLoading.value = false;
      overviewNow.value = Date.now();
    }
  }
  function stopOverviewPolling(): void {
    if (minuterie) {
      clearInterval(minuterie);
      minuterie = null;
    }
  }
  function startOverviewPolling(): void {
    stopOverviewPolling();
    minuterie = setInterval(() => {
      overviewNow.value = Date.now();
      if (document.hidden || overviewLoading.value) return;
      const at = overview.value?.generated_at;
      if (!at || Date.now() / 1000 - at >= 30) void loadOverview();
    }, 5000);
  }

  const overviewAge = computed(() => {
    const at = overview.value?.generated_at;
    if (!at) return "";
    const s = Math.max(0, Math.round(overviewNow.value / 1000 - at));
    if (s < 5) return "à l’instant";
    if (s < 60) return "il y a " + s + " s";
    return "il y a " + Math.round(s / 60) + " min";
  });
  const overviewAttention = computed(() => (overview.value?.alerts ?? []).length);
  const overviewSetupLeft = computed(() => (overview.value?.setup ?? []).filter((x) => !x.done).length);
  const overviewStateLabel = (st: string): string => (ETATS_SERVICE[st] ?? ETAT_INCONNU)[0];
  const overviewStateIcon = (st: string): string => (ETATS_SERVICE[st] ?? ETAT_INCONNU)[1];

  /** Pages concernées par des chemins de config.json (« Inférence, Entretien »). */
  function overviewPagesFor(chemins: readonly string[] | undefined): string {
    const sortie: string[] = [];
    let autre = false;
    for (const p of chemins ?? []) {
      const id = nav.pageForPath(p);
      const label = id && nav.pages[id] ? nav.pages[id].label : "";
      if (label) {
        if (!sortie.includes(label)) sortie.push(label);
      } else autre = true;
    }
    if (autre) sortie.push("autres réglages");
    return sortie.join(", ");
  }
  function overviewAlertDetail(a: { id: string; detail?: string; paths?: readonly string[] }): string {
    if (a.id === "restart") return overviewPagesFor(a.paths);
    return a.detail || "";
  }
  const overviewBackupLabel = (): string => tempsRelatif(overview.value?.backup.at);

  async function runOverviewAction(a: ActionApercu | null | undefined): Promise<void> {
    if (!a || !a.action) return;
    if (a.action === "restart") {
      await lien.restartServer();
      return;
    }
    if (a.action === "backup") {
      await lien.downloadBackup("full");
      void loadOverview(true);
      return;
    }
    if (a.page) void lien.goAdminPage(a.page);
  }

  /** Raccourcis : ouvrir la page puis le bon objet. */
  async function overviewShortcut(kind: string): Promise<void> {
    if (kind === "account") {
      if (await lien.goAdminPage("accounts")) {
        void ctx.nextTick().then(() => {
          if (ctx.showNewUserModal) ctx.showNewUserModal.value = true;
        });
      }
    } else if (kind === "engine") {
      if (await lien.goAdminPage("inference")) {
        void ctx.nextTick().then(() => {
          e.engineSel.value = "__new__";
          lien.onEngineSelect();
        });
      }
    } else if (kind === "logs") void lien.goAdminPage("logs");
    else if (kind === "backup") {
      await lien.downloadBackup("full");
      void loadOverview(true);
    }
  }

  // ── « Redémarrage nécessaire » ───────────────────────────────────────────
  async function loadRestartStatus(): Promise<void> {
    if (!b.estAdmin()) return;
    try {
      const r = await ctx.fetchAuth("/api/admin/restart-status", {}, true);
      const d = await lireSchema(r, schemaReponseEtatRedemarrage);
      if (d) {
        e.restartPaths.value = new Set(d.paths);
        e.restartPending.value = d.pending;
      }
    } catch {
      /* état inchangé */
    }
  }
  const adminChangeNeedsRestart = (c: { store: string; path: string } | null | undefined): boolean =>
    !!c && c.store === "config" && e.restartPaths.value.has(c.path);

  return {
    overview,
    overviewLoading,
    overviewFailed,
    loadOverview,
    startOverviewPolling,
    stopOverviewPolling,
    overviewAge,
    overviewAttention,
    overviewSetupLeft,
    overviewStateLabel,
    overviewStateIcon,
    overviewAlertDetail,
    overviewBackupLabel,
    fmtCompact,
    runOverviewAction,
    overviewShortcut,
    restartPaths: e.restartPaths,
    restartPending: e.restartPending,
    loadRestartStatus,
    adminChangeNeedsRestart,
  };
}
