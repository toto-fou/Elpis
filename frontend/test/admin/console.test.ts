// SPDX-License-Identifier: MIT
/** frontend/test/admin/console.test.ts — surface plate de `setupAdmin` : toutes les clés de l'ancien `setupAdmin`, liens entre familles renseignés, navigation par lien profond, enregistrement par page. */
import type { CompteConsole } from "@elpis/contracts";
import * as Vue from "vue";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceEvenements } from "../../src/features/auth/sse-systeme";
import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { REDEMARRAGE_MANUEL } from "../../src/features/admin/securite";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CLES_ANCIENNE_SURFACE = [
  "admLlmConnectors",
  "admLlmPresets",
  "admLlmAllProviders",
  "admLlmCloudTypes",
  "admLlmAllowed",
  "admLlmForm",
  "admLlmBusy",
  "admLlmTest",
  "admLlmLabel",
  "loadAdminLlmConnectors",
  "newAdmLlmConnector",
  "editAdmLlmConnector",
  "saveAdmLlmConnector",
  "deleteAdmLlmConnector",
  "testAdmLlmConnector",
  "toggleAdmAllowed",
  "saveAdmAllowed",
  "engineSel",
  "engineConnector",
  "onEngineSelect",
  "engineDrawer",
  "closeEngineDrawer",
  "onEngineDrawerKey",
  "adminNav",
  "adminPage",
  "goAdminPage",
  "goAdminEntry",
  "adminMeOpen",
  "adminH1",
  "adminScroller",
  "focusAdminTitle",
  "adminIsAdmin",
  "adminCanOpen",
  "overview",
  "overviewLoading",
  "overviewFailed",
  "loadOverview",
  "startOverviewPolling",
  "stopOverviewPolling",
  "overviewAge",
  "overviewAttention",
  "overviewSetupLeft",
  "overviewStateLabel",
  "overviewStateIcon",
  "overviewAlertDetail",
  "overviewBackupLabel",
  "fmtCompact",
  "runOverviewAction",
  "overviewShortcut",
  "restartPaths",
  "restartPending",
  "loadRestartStatus",
  "adminChangeNeedsRestart",
  "paletteOpen",
  "paletteQuery",
  "paletteIndex",
  "paletteInput",
  "paletteResults",
  "openPalette",
  "closePalette",
  "runPaletteItem",
  "onPaletteKey",
  "adminTab",
  "adminTabTitle",
  "usersList",
  "dashboardData",
  "configForm",
  "resetTarget",
  "newPasswordInput",
  "liveLogs",
  "dashMenu",
  "widgetPrefs",
  "dashboardScope",
  "setDashboardScope",
  "isSavingAdminConfig",
  "isWidgetVisible",
  "toggleWidgetVisibility",
  "allWidgetsList",
  "resetWidgetPrefs",
  "resetWidget",
  "resetAllMetrics",
  "exportUsage",
  "kpisInCategory",
  "chartsInCategory",
  "kpiGroups",
  "chartGroups",
  "kpiState",
  "chartSummary",
  "groupsList",
  "allUsersWithGroups",
  "groupModal",
  "groupMembersModal",
  "userEdit",
  "userEditDirty",
  "userEditOpen",
  "toggleUserEdit",
  "closeUserEdit",
  "saveUserEdit",
  "revokeUserAccess",
  "usersDesktopTargets",
  "admRoleLabel",
  "admNetProfileName",
  "admDesktopLabel",
  "admDesktopTitle",
  "loadUsers",
  "loadAdminStats",
  "renderDynamicDashboard",
  "startDashboardPolling",
  "stopDashboardPolling",
  "destroyAllCharts",
  "setUserSandboxQuota",
  "usersNetProfiles",
  "setUserNetworkProfile",
  "usersSearch",
  "usersSort",
  "usersPage",
  "usersPageCount",
  "pagedUsers",
  "filteredSortedUsers",
  "toggleUsersSort",
  "logFilters",
  "logAutoScroll",
  "logsConsoleRef",
  "filteredLogs",
  "logsLoading",
  "loadRecentLogs",
  "fmtLogTs",
  "adminDirtyStores",
  "adminDirtyCount",
  "adminPageSavable",
  "isSavingAdminPage",
  "adminPageChanges",
  "adminChangesOpen",
  "adminChangeLabel",
  "adminChangeValue",
  "adminChangeRevertable",
  "revertAdminChange",
  "adminConfirmLeave",
  "saveAdminPage",
  "discardAdminPage",
  "addDesktopTarget",
  "removeDesktopTarget",
  "setDefaultTarget",
  "downloadAgentBundle",
  "installShCmd",
  "installPs1Cmd",
  "copyInstallCmd",
  "securityOverview",
  "securityBusy",
  "loadSecurityOverview",
  "revokeAllSessions",
  "clearUserRevocation",
  "httpsStatus",
  "httpsBusy",
  "httpsRedirectUrl",
  "loadHttpsStatus",
  "toggleHttps",
  "setListen",
  "dashboardPollMs",
  "pollLabel",
  "pollFaster",
  "pollSlower",
  "livePollMs",
  "livePollLabel",
  "liveFaster",
  "liveSlower",
  "adminAutoOpen",
  "toggleAdminAutoOpen",
  "downloadBackup",
  "triggerRestore",
  "restoreScope",
  "transferModal",
  "closeTransferModal",
  "fmtElapsed",
  "uploadWithModal",
  "downloadWithModal",
  "deleteUser",
  "restartServer",
  "loadAdminConfig",
  "remoteBackup",
  "remoteKeyFp",
  "remoteBackupBusy",
  "remoteRsyncPassword",
  "clearRsyncPassword",
  "remoteNextRunLabel",
  "remoteDateLabel",
  "loadRemoteBackup",
  "saveRemoteBackup",
  "uploadBackupKey",
  "testRemoteBackup",
  "sendRemoteBackup",
  "llmScheduling",
  "llmSchedulingProbing",
  "llmSchedulingSaving",
  "loadLlmScheduling",
  "probeLlmCapabilities",
  "saveLlmSchedulingMode",
  "compressionCfg",
  "compressionSaving",
  "loadCompressionCfg",
  "saveCompressionCfg",
  "dbState",
  "dbForm",
  "dbTest",
  "dbSim",
  "dbJob",
  "dbBusy",
  "loadDatabase",
  "testDatabase",
  "saveDatabase",
  "simulateDatabase",
  "migrateDatabase",
  "revertDatabaseToSqlite",
  "voiceTest",
  "testVoiceConnection",
  "voiceModels",
  "loadVoiceModels",
  "imageTest",
  "imageModels",
  "imageKey",
  "loadImageAdmin",
  "testImageEngine",
  "imageTestLine",
  "loadImageModels",
  "saveImageKey",
  "setImageGroups",
  "toggleImageGroup",
  "imageGroupsMissing",
  "setImageSizesText",
  "imageSideChoices",
  "handleAdminWelcomeUpload",
  "handleAppInfoLogoUpload",
  "handleLoginLogoUpload",
  "openResetModal",
  "confirmReset",
  "apercuAccueil",
  "apercuPerso",
  "MASCOTTES_APERCU",
  "MASCOTTES_ADMIN",
  "mascotteActive",
  "basculerMascotte",
  "exportMetrics",
  "loadGroups",
  "saveGroup",
  "openCreateGroup",
  "openEditGroup",
  "confirmDeleteGroup",
  "openGroupMembers",
  "isInCurrentGroup",
  "toggleMembership",
  "admLlmAccessOptions",
  "loadAdmLlmAccessOptions",
  "admLlmAccessServersLabel",
  "admLlmAccessServersTitle",
  "admLlmAccessManageLabel",
  "admLlmAccessManageTitle",
  "axSites",
  "axSelected",
  "axExpanded",
  "axTrees",
  "axTreeLoading",
  "axLoading",
  "showAxModal",
  "openAxModal",
  "loadAxSites",
  "toggleAxSite",
  "toggleSelectAllAx",
  "deleteSite",
  "deleteCreds",
  "markStale",
  "bulkDelete",
  "bulkMarkStale",
  "confirmWipeAll",
  "promptsList",
  "promptsSelected",
  "promptsEditorText",
  "promptsEditorDirty",
  "promptsLoading",
  "promptsPreview",
  "promptsPreviewCats",
  "loadSystemPrompts",
  "selectPrompt",
  "savePrompt",
  "reloadPrompt",
  "refreshPreview",
  "promptsGrouped",
  "isPromptGroupCollapsed",
  "togglePromptGroup",
  "promptMeta",
  "fmtBytes",
  "execLoading",
  "execConfig",
  "execHealthcheck",
  "execExtraArgsText",
  "sandboxContainers",
  "staleNetContainers",
  "staleNetBusy",
  "recreateStaleNetContainers",
  "addNetworkProfile",
  "removeNetworkProfile",
  "netFields",
  "netPortsMode",
  "setPortsMode",
  "setProfileMode",
  "commitNetValue",
  "removeNetValue",
  "addNetPreset",
  "toggleProfile",
  "netModeKey",
  "netModeLabel",
  "netModeIcon",
  "netProfileSummary",
  "netProfileIssue",
  "loadExecConfig",
  "loadExecHealthcheck",
  "saveExecConfig",
  "loadSandboxContainers",
  "adminStopUserSandbox",
  "adminDestroyUserSandbox",
  "triggerSandboxGc",
  "obsScope",
  "obsLoading",
  "obsSummary",
  "obsFailures",
  "setObsScope",
  "kpiCategories",
] as const;

/** Libérations des consoles montées par un test : sans elles, leurs écouteurs `popstate` réagissent aux tests suivants. */
const liberations: (() => void)[] = [];
const vueDeTest = { ...Vue, onUnmounted: (f: () => void) => void liberations.push(f) } as typeof Vue;
afterEach(() => {
  for (const f of liberations.splice(0)) f();
});

function monter(
  route: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ctxEnPlus: Partial<CtxAdmin> = {},
  compte: { username: string; role: string; is_admin: number } = {
    username: "root",
    role: "admin",
    is_admin: 1,
  },
) {
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const toasts: string[] = [];
  const refs: RefsAdmin = {
    user: ref(compte),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: (m) => toasts.push(m),
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
    ...ctxEnPlus,
  };
  const A = setupAdmin(vueDeTest, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  return { A, toasts };
}

describe("setupAdmin", () => {
  it("expose toutes les clés de l'ancienne surface", () => {
    const { A } = monter(() => json({}));
    expect(CLES_ANCIENNE_SURFACE.filter((k) => !(k in A))).toEqual([]);
  });

  it("n'expose pas les aides internes des familles", () => {
    const { A } = monter(() => json({}));
    for (const interne of ["liberer", "execConfigPayload", "storeSnapshot", "markAdminStoreClean"]) {
      expect(interne in A, interne).toBe(false);
    }
  });

  it("Métriques : un sondage n'annule pas un chargement plus long que son intervalle ; il reprend après la réponse", async () => {
    vi.useFakeTimers();
    try {
      let appels = 0;
      const { A } = monter((url) => {
        if (url === "/api/admin/stats-dynamic?layout=1")
          return json({ layout: [{ id: "kpi_users", type: "value", category: "activity" }] });
        if (!url.startsWith("/api/admin/stats-dynamic?scope_hours=")) return json({});
        appels++;
        return new Promise<Response>((r) =>
          setTimeout(() => r(json({ data: { kpi_users: { value: 3 } }, partial: true })), 8000),
        );
      });
      A.dashboardPollMs.value = 2000;
      A.startDashboardPolling();
      void A.loadAdminStats();
      await vi.advanceTimersByTimeAsync(7000);
      expect([appels, A.dashboardLoading.value, A.dashboardData.value.layout.length]).toEqual([1, true, 1]);
      expect(A.dashboardData.value.data["kpi_users"]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3500);
      expect(A.dashboardData.value.data["kpi_users"]).toEqual({ value: 3 });
      expect(appels).toBe(2);
      A.stopDashboardPolling();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Métriques : mise en page une seule fois, puis les seuls widgets visibles ; le live suit sa propre cadence", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      if (url.startsWith("/api/admin/stats-dynamic")) urls.push(url);
      if (url === "/api/admin/stats-dynamic?layout=1")
        return json({
          layout: [
            { id: "kpi_users", type: "value", category: "activity" },
            { id: "system_load", type: "line", category: "system" },
            { id: "cache", type: "line", category: "system", default: false },
          ],
        });
      return json({ data: {}, partial: true });
    });
    A.startDashboardPolling();
    await A.loadAdminStats();
    await A.loadAdminStats();
    A.stopDashboardPolling();
    expect(urls).toEqual([
      "/api/admin/stats-dynamic?layout=1",
      "/api/admin/stats-dynamic?scope_hours=24&ids=kpi_users%2Csystem_load",
      "/api/admin/stats-dynamic?scope_hours=24&ids=kpi_users",
    ]);
    expect(A.derniereMaj.value).not.toBeNull();
    expect(A.echecMaj.value).toBe(false);
  });

  it("Métriques : sans minuteur live (pause), Actualiser recharge aussi les graphes live ; « Défaut » charge les widgets réaffichés", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      if (url.startsWith("/api/admin/stats-dynamic")) urls.push(url);
      if (url === "/api/admin/stats-dynamic?layout=1")
        return json({
          layout: [
            { id: "kpi_users", type: "value", category: "activity" },
            { id: "system_load", type: "line", category: "system" },
            { id: "cache", type: "line", category: "system", default: false },
          ],
        });
      return json({ data: {}, partial: true });
    });
    await A.loadAdminStats();
    await A.loadAdminStats();
    expect(urls.at(-1)).toBe("/api/admin/stats-dynamic?scope_hours=24&ids=kpi_users%2Csystem_load");
    A.toggleWidgetVisibility("cache");
    urls.length = 0;
    A.resetWidgetPrefs();
    await vi.waitFor(() =>
      expect(urls).toEqual(["/api/admin/stats-dynamic?scope_hours=24&ids=kpi_users%2Csystem_load"]),
    );
  });

  it("Métriques : « Défaut » recharge un widget masqué pendant un changement de période", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      if (url.startsWith("/api/admin/stats-dynamic")) urls.push(url);
      if (url === "/api/admin/stats-dynamic?layout=1")
        return json({
          layout: [
            { id: "kpi_users", type: "value", category: "activity" },
            { id: "system_load", type: "line", category: "system" },
          ],
        });
      return json({ data: {}, partial: true });
    });
    await A.loadAdminStats();
    A.toggleWidgetVisibility("system_load");
    A.setDashboardScope(720);
    await vi.waitFor(() => expect(urls.at(-1)).toContain("scope_hours=720&ids=kpi_users"));
    A.dashboardData.value.data["system_load"] = { periode: 24 };
    urls.length = 0;
    A.resetWidgetPrefs();
    await vi.waitFor(() =>
      expect(urls).toEqual(["/api/admin/stats-dynamic?scope_hours=720&ids=kpi_users%2Csystem_load"]),
    );
    A.setDashboardScope(24);
  });

  it("Métriques : la réponse lente d'une ancienne période n'écrase pas la nouvelle", async () => {
    let rendre: ((r: Response) => void) | null = null;
    let bloquer = false;
    const { A } = monter((url) => {
      if (url === "/api/admin/stats-dynamic?layout=1")
        return json({ layout: [{ id: "kpi_users", type: "value", category: "activity" }] });
      if (bloquer && url.includes("scope_hours=24"))
        return new Promise<Response>((r) => {
          rendre = r;
        });
      return json({ data: { kpi_users: { value: 7 } }, partial: true });
    });
    await A.loadAdminStats();
    bloquer = true;
    A.toggleWidgetVisibility("kpi_users");
    A.toggleWidgetVisibility("kpi_users");
    await vi.waitFor(() => expect(rendre).not.toBeNull());
    A.setDashboardScope(168);
    await vi.waitFor(() => expect(A.dashboardScope.value).toBe(168));
    await vi.waitFor(() => expect(A.dashboardLoading.value).toBe(false));
    (rendre as unknown as (r: Response) => void)(json({ data: { kpi_users: { value: 1 } } }));
    await new Promise((suite) => setTimeout(suite, 20));
    expect(A.dashboardData.value.data["kpi_users"]).toEqual({ value: 7 });
    A.setDashboardScope(24);
  });

  it("Métriques : changer la cadence relance le minuteur au nouveau rythme", async () => {
    vi.useFakeTimers();
    try {
      let appels = 0;
      const { A } = monter((url) => {
        if (url === "/api/admin/stats-dynamic?layout=1")
          return json({ layout: [{ id: "kpi_users", type: "value", category: "activity" }] });
        appels++;
        return json({ data: {}, partial: true });
      });
      A.startDashboardPolling();
      await A.loadAdminStats();
      const avant = appels;
      A.pollSlower();
      const ms = A.dashboardPollMs.value;
      expect(ms).toBeGreaterThan(15000);
      await vi.advanceTimersByTimeAsync(ms - 1_000);
      expect(appels).toBe(avant);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(appels).toBe(avant + 1);
      A.stopDashboardPolling();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Métriques : en pause, aucun sondage ; la reprise recharge aussitôt et le choix est mémorisé", async () => {
    vi.useFakeTimers();
    try {
      let appels = 0;
      const { A } = monter((url) => {
        if (url === "/api/admin/stats-dynamic?layout=1")
          return json({ layout: [{ id: "kpi_users", type: "value", category: "activity" }] });
        appels++;
        return json({ data: { kpi_users: { value: 1 } }, partial: true });
      });
      A.startDashboardPolling();
      await A.loadAdminStats();
      A.basculerActualisationAuto();
      expect([A.actualisationAuto.value, localStorage.getItem("elpis_dashboard_auto")]).toEqual([false, "0"]);
      const avant = appels;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(appels).toBe(avant);
      A.basculerActualisationAuto();
      await vi.advanceTimersByTimeAsync(0);
      expect(appels).toBe(avant + 1);
      expect(localStorage.getItem("elpis_dashboard_auto")).toBe("1");
      A.stopDashboardPolling();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Métriques : un échec est signalé, l'heure de la dernière mise à jour reste celle du dernier succès", async () => {
    let echoue = false;
    const { A } = monter((url) => {
      if (url === "/api/admin/stats-dynamic?layout=1")
        return json({ layout: [{ id: "kpi_users", type: "value", category: "activity" }] });
      if (echoue) return json({ detail: "indisponible" }, 503);
      return json({ data: { kpi_users: { value: 1 } }, partial: true });
    });
    await A.loadAdminStats();
    const succes = A.derniereMaj.value;
    echoue = true;
    await A.loadAdminStats();
    expect([A.echecMaj.value, A.derniereMaj.value]).toEqual([true, succes]);
  });

  it("Journaux : l'historique vient des événements du journal commun, mis en forme comme le direct, avec les filtres proposés", async () => {
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/logs/recent")) return json({});
      return json({
        logs: [{ id: 1, message: "12:00:00 - INFO - ignoré", level: "INFO" }],
        events: [
          { ts: 100, service: "main", category: "http", level: "INFO", message: "GET /api/chats → 200" },
          { ts: 101, service: "admin", category: "app", level: "WARNING", message: "lent", live: false },
          { ts: 102, service: "admin", category: "auth", level: "ERROR", message: "refus" },
        ],
        filters_applied: { limit: 300, services: null, levels: null, categories: null, since_ts: null },
        available_services: ["main", "admin"],
        available_levels: ["INFO", "ERROR"],
        available_categories: ["http", "auth"],
      });
    });
    await A.loadRecentLogs();
    expect(A.liveLogs.value.map((l) => [l.ts, l.message, l.level, l.service])).toEqual([
      [100, "[main/http] GET /api/chats → 200", "INFO", "main"],
      [102, "[admin/auth] refus", "ERROR", "admin"],
    ]);
    expect([A.servicesDisponibles.value, A.niveauxDisponibles.value]).toEqual([
      ["main", "admin"],
      ["INFO", "ERROR"],
    ]);
    expect([A.logsEchec.value, A.logsDerniereMaj.value !== null]).toEqual([false, true]);
    await A.loadRecentLogs();
    expect(A.liveLogs.value).toHaveLength(2);
  });

  it("Journaux : le flux en direct n'est ouvert que sur la page, par lots de 200 ms, puis fermé en la quittant", () => {
    vi.useFakeTimers();
    try {
      const sources: { url: string; source: SourceEvenements & { ferme: boolean } }[] = [];
      const creerSourceJournal = (url: string): SourceEvenements => {
        const source = {
          readyState: 1,
          onopen: null,
          onerror: null,
          onmessage: null,
          ferme: false,
          close() {
            this.ferme = true;
          },
        } as SourceEvenements & { ferme: boolean };
        sources.push({ url, source });
        return source;
      };
      const { A } = monter(() => json({}), { creerSourceJournal });
      expect(sources).toHaveLength(0);
      A.suivreJournal(true);
      A.suivreJournal(true);
      expect(sources.map((s) => s.url)).toEqual(["/api/system-events?logs=1"]);
      const flux = sources[0]!.source;
      flux.onopen?.(new Event("open"));
      expect(A.fluxOuvert.value).toBe(true);
      const envoyer = (o: unknown): void =>
        flux.onmessage?.(new MessageEvent("message", { data: JSON.stringify(o) }));
      envoyer({ type: "log", message: "a", level: "INFO", ts: 5 });
      envoyer({ type: "log", message: "b", level: "INFO", ts: 5, service: "core" });
      envoyer({ type: "notification", data: { id: 1, user_id: 1 } });
      expect(A.liveLogs.value).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(A.liveLogs.value.map((l) => [l.message, l.service])).toEqual([
        ["a", undefined],
        ["b", "core"],
      ]);
      expect(new Set(A.liveLogs.value.map((l) => l.id)).size).toBe(2);
      envoyer({ type: "worker_recycling" });
      expect([flux.ferme, A.fluxOuvert.value]).toEqual([true, false]);
      vi.advanceTimersByTime(750);
      expect(sources).toHaveLength(2);
      A.suivreJournal(false);
      expect(sources[1]!.source.ferme).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(sources).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Journaux : un historique filtré remplace le tampon, même plein de lignes plus récentes ; seule la dernière demande écrit", async () => {
    const recus: string[] = [];
    let liberer: (() => void) | null = null;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/logs/recent")) return json({});
      recus.push(url);
      if (url.includes("levels=ERROR"))
        return new Promise<Response>((r) => {
          liberer = () =>
            r(json({ events: [{ ts: 1, service: "a", category: "b", level: "ERROR", message: "lente" }] }));
        });
      if (url.includes("levels=WARN"))
        return json({ events: [{ ts: 2, service: "a", category: "b", level: "WARN", message: "rapide" }] });
      return json({ events: [] });
    });
    A.liveLogs.value = Array.from({ length: 800 }, (_, i) => ({
      id: String(i),
      ts: 1000 + i,
      message: "m" + i,
      level: "INFO",
    }));
    A.logFilters.value.levels = ["ERROR"];
    const lente = A.loadRecentLogs();
    A.logFilters.value.levels = ["WARN"];
    await A.loadRecentLogs();
    (liberer as unknown as () => void)();
    await lente;
    expect(
      A.liveLogs.value.map((l) => l.message).filter((m) => m !== undefined && !m.startsWith("m")),
    ).toEqual(["[a/b] rapide"]);
    expect(A.liveLogs.value).toHaveLength(1);
    expect(A.logsLoading.value).toBe(false);
  });

  it("Journaux : le rattrapage ne part pas pendant un rechargement complet, ni sur un flux refusé ; réponse pleine : remplacement", async () => {
    vi.useFakeTimers();
    try {
      const sources: SourceEvenements[] = [];
      const creerSourceJournal = (): SourceEvenements => {
        const s = {
          readyState: 1,
          onopen: null,
          onerror: null,
          onmessage: null,
          close() {},
        } as unknown as SourceEvenements;
        sources.push(s);
        return s;
      };
      const urls: string[] = [];
      let rendreFiltre: (() => void) | null = null;
      let pleine = false;
      const { A } = monter(
        (url) => {
          if (!url.startsWith("/api/admin/logs/recent")) return json({});
          urls.push(url);
          if (url.includes("levels=ERROR") && !url.includes("since_ts"))
            return new Promise<Response>((r) => {
              rendreFiltre = () =>
                r(json({ events: [{ ts: 1, service: "a", category: "b", level: "ERROR", message: "e" }] }));
            });
          if (url.includes("since_ts") && pleine)
            return json({
              events: Array.from({ length: 800 }, (_, i) => ({
                ts: 2000 + i,
                service: "a",
                category: "b",
                level: "INFO",
                message: "p" + i,
              })),
            });
          return json({ events: [] });
        },
        { creerSourceJournal },
      );
      A.liveLogs.value = [{ id: "x", ts: 1000, message: "m", level: "INFO" }];
      A.suivreJournal(true);
      sources[0]!.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(1_600);
      A.logFilters.value.levels = ["ERROR"];
      await vi.advanceTimersByTimeAsync(0);
      expect(rendreFiltre).not.toBeNull();
      // Reconnexion pendant le rechargement filtré : aucun rattrapage, le filtre l'emporte.
      sources[0]!.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(urls.some((u) => u.includes("since_ts"))).toBe(false);
      (rendreFiltre as unknown as () => void)();
      await vi.advanceTimersByTimeAsync(0);
      expect(A.liveLogs.value.map((l) => l.level)).toEqual(["ERROR"]);
      // Flux refusé : rien n'est rattrapé.
      sources[0]!.onopen?.(new Event("open"));
      sources[0]!.onmessage?.(new MessageEvent("message", { data: '{"type":"log_unavailable"}' }));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(urls.some((u) => u.includes("since_ts"))).toBe(false);
      // Réponse pleine (800) : le tampon est rechargé en remplaçant.
      await vi.advanceTimersByTimeAsync(5_000);
      pleine = true;
      sources[1]!.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(urls.filter((u) => u.includes("since_ts=") && u.includes("limit=800"))).toHaveLength(1);
      expect(urls.at(-1)).toContain("limit=300");
      expect(urls.at(-1)).not.toContain("since_ts");
      A.suivreJournal(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Journaux : log_replaced ferme le flux sans réessai minuté ; il rouvre au retour de visibilité", async () => {
    vi.useFakeTimers();
    const masquer = (oui: boolean): void => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => oui });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      const sources: (SourceEvenements & { ferme: boolean })[] = [];
      const creerSourceJournal = (): SourceEvenements => {
        const s = {
          readyState: 1,
          onopen: null,
          onerror: null,
          onmessage: null,
          ferme: false,
          close() {
            this.ferme = true;
          },
        } as SourceEvenements & { ferme: boolean };
        sources.push(s);
        return s;
      };
      const { A } = monter(() => json({ events: [] }), { creerSourceJournal });
      A.suivreJournal(true);
      sources[0]!.onopen?.(new Event("open"));
      sources[0]!.onmessage?.(new MessageEvent("message", { data: '{"type":"log_replaced"}' }));
      expect([sources[0]!.ferme, A.fluxOuvert.value, A.fluxIndisponible.value]).toEqual([true, false, false]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sources).toHaveLength(1);
      masquer(true);
      masquer(false);
      expect(sources).toHaveLength(2);
      A.suivreJournal(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Journaux : reconnexion, rattrapage depuis la dernière ligne reçue ; refus du serveur, reprise espacée ; onglet masqué, flux fermé", async () => {
    vi.useFakeTimers();
    const masquer = (oui: boolean): void => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => oui });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      const sources: (SourceEvenements & { ferme: boolean })[] = [];
      const creerSourceJournal = (): SourceEvenements => {
        const source = {
          readyState: 1,
          onopen: null,
          onerror: null,
          onmessage: null,
          ferme: false,
          close() {
            this.ferme = true;
          },
        } as SourceEvenements & { ferme: boolean };
        sources.push(source);
        return source;
      };
      const urls: string[] = [];
      const { A } = monter(
        (url) => {
          if (url.startsWith("/api/admin/logs/recent")) urls.push(url);
          return json({
            events: [{ ts: 50, service: "s", category: "c", level: "INFO", message: "rattrapée" }],
          });
        },
        { creerSourceJournal },
      );
      const envoyer = (i: number, o: unknown): void =>
        sources[i]!.onmessage?.(new MessageEvent("message", { data: JSON.stringify(o) }));
      A.logFilters.value = { services: [], levels: [], categories: [], query: "" };
      await Vue.nextTick();
      A.suivreJournal(true);
      sources[0]!.onopen?.(new Event("open"));
      envoyer(0, { type: "log", message: "x", level: "INFO", ts: 40 });
      await vi.advanceTimersByTimeAsync(200);
      envoyer(0, { type: "worker_recycling" });
      await vi.advanceTimersByTimeAsync(750);
      sources[1]!.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(urls).toEqual([]);
      await vi.advanceTimersByTimeAsync(600);
      expect(urls).toEqual(["/api/admin/logs/recent?limit=800&since_ts=40"]);
      expect(A.liveLogs.value.map((l) => l.ts)).toEqual([40, 50]);
      // Refus : « Direct indisponible », reprises à 5 s puis 10 s.
      envoyer(1, { type: "log_unavailable" });
      expect([A.fluxIndisponible.value, A.fluxOuvert.value, sources[1]!.ferme]).toEqual([true, false, true]);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(sources).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(sources).toHaveLength(3);
      sources[2]!.onopen?.(new Event("open"));
      envoyer(2, { type: "log_unavailable" });
      await vi.advanceTimersByTimeAsync(9_900);
      expect(sources).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(200);
      expect(sources).toHaveLength(4);
      // Accepté : indisponibilité levée après le délai de confirmation.
      sources[3]!.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(1_600);
      expect(A.fluxIndisponible.value).toBe(false);
      // Onglet masqué : flux fermé, pas de reprise ; retour : réouverture.
      masquer(true);
      expect(sources[3]!.ferme).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sources).toHaveLength(4);
      masquer(false);
      expect(sources).toHaveLength(5);
      A.suivreJournal(false);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      vi.useRealTimers();
    }
  });

  it("modérateur : #audit, #logs/security, navigation et palette l'amènent sur Journaux › Technique, avec avertissement, sans requête d'audit", async () => {
    for (const ancre of ["#audit", "#logs/security"]) {
      location.hash = ancre;
      try {
        const urls: string[] = [];
        const { A, toasts } = monter(
          (u) => {
            urls.push(u);
            return json({});
          },
          {},
          { username: "mo", role: "moderator", is_admin: 2 },
        );
        expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["logs", "technical"]);
        expect(toasts).toEqual(["Le journal de sécurité est réservé aux administrateurs."]);
        A.openPalette();
        const cibles = A.paletteResults.value.map((r) => r.page + "/" + (r.onglet ?? ""));
        expect(cibles).not.toContain("logs/security");
        expect(cibles).toContain("activity/tool-calls");
        A.closePalette();
        await A.goAdminPage("overview");
        expect(await A.goAdminPage("audit")).toBe(true);
        expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["logs", "technical"]);
        expect(await A.goAdminPage("logs", "security")).toBe(true);
        expect(A.adminOngletCourant.value).toBe("technical");
        expect(A.ongletsOuvrables("logs").map((o) => o.id)).toEqual(["technical"]);
        expect(urls.filter((u) => u.startsWith("/api/admin/audit"))).toEqual([]);
        const { A: B } = monter(() => json({}));
        expect([B.adminTab.value, B.adminOngletCourant.value]).toEqual(["logs", "security"]);
      } finally {
        location.hash = "";
      }
    }
  });

  it("anciennes ancres : #runs, #tool-calls, #observability et #audit ouvrent le bon onglet", () => {
    const attendu: Record<string, [string, string]> = {
      "#runs": ["activity", "runs"],
      "#tool-calls": ["activity", "tool-calls"],
      "#observability": ["activity", "tool-calls"],
      "#audit": ["logs", "security"],
      "#logs": ["logs", "technical"],
      "#activity": ["activity", "runs"],
      "#activity/tool-calls": ["activity", "tool-calls"],
      "#logs/inconnu": ["logs", "technical"],
    };
    for (const [ancre, [page, onglet]] of Object.entries(attendu)) {
      location.hash = ancre;
      try {
        const { A } = monter(() => json({}));
        expect([ancre, A.adminTab.value, A.adminOngletCourant.value]).toEqual([ancre, page, onglet]);
      } finally {
        location.hash = "";
      }
    }
  });

  it("changer d'onglet écrit l'ancre dans l'historique ; Précédent / Suivant suit page et onglet", async () => {
    const fenetre = window as unknown as { __ADMIN_ONLY_MODE__?: boolean };
    fenetre.__ADMIN_ONLY_MODE__ = true;
    location.hash = "#logs/technical";
    try {
      const { A } = monter(() => json({}));
      expect(await A.goAdminOnglet("logs", "security")).toBe(true);
      await Vue.nextTick();
      expect(location.hash).toBe("#logs/security");
      await A.goAdminPage("activity");
      await Vue.nextTick();
      expect(location.hash).toBe("#activity/runs");
      location.hash = "#logs/technical";
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((r) => setTimeout(r, 0));
      expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["logs", "technical"]);
      location.hash = "#logs/security";
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((r) => setTimeout(r, 0));
      expect(A.adminOngletCourant.value).toBe("security");
    } finally {
      fenetre.__ADMIN_ONLY_MODE__ = false;
      location.hash = "";
    }
  });

  it("popstate : un modérateur qui revient sur #audit atterrit sur Technique avec l'avertissement", async () => {
    const fenetre = window as unknown as { __ADMIN_ONLY_MODE__?: boolean };
    fenetre.__ADMIN_ONLY_MODE__ = true;
    try {
      const { A, toasts } = monter(() => json({}), {}, { username: "mo", role: "moderator", is_admin: 2 });
      await A.goAdminPage("accounts");
      await A.goAdminPage("overview");
      location.hash = "#audit";
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((r) => setTimeout(r, 0));
      expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["logs", "technical"]);
      expect(toasts.length).toBe(1);
      expect(location.hash).toBe("#logs/technical");
    } finally {
      fenetre.__ADMIN_ONLY_MODE__ = false;
      location.hash = "";
    }
  });

  it("Précédent vers une ancre nue revient au premier onglet, sans nouvelle entrée d'historique", async () => {
    const fenetre = window as unknown as { __ADMIN_ONLY_MODE__?: boolean };
    fenetre.__ADMIN_ONLY_MODE__ = true;
    location.hash = "#logs";
    try {
      const { A } = monter(() => json({}));
      expect(location.hash).toBe("#logs/technical");
      await A.goAdminOnglet("logs", "security");
      await Vue.nextTick();
      expect(location.hash).toBe("#logs/security");
      location.hash = "#logs";
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((r) => setTimeout(r, 0));
      await Vue.nextTick();
      expect(A.adminOngletCourant.value).toBe("technical");
      expect(location.hash).toBe("#logs/technical");
    } finally {
      fenetre.__ADMIN_ONLY_MODE__ = false;
      location.hash = "";
    }
  });

  it("l'onglet d'admin mémorisé ne survit pas au changement de compte", async () => {
    const user = ref<{ username: string; role: string; is_admin: number } | null>({
      username: "root",
      role: "admin",
      is_admin: 1,
    });
    const refs: RefsAdmin = { user, isAdminView: ref(true) };
    const ctx: CtxAdmin = {
      showToast: () => undefined,
      fetchAuth: () => Promise.resolve(json({})),
      openConfirm: () => Promise.resolve(true),
      openChoice: () => Promise.resolve("save"),
      nextTick: () => Vue.nextTick(),
      loadPublicConfig: () => undefined,
      systemAlert: ref(""),
    };
    const portee = Vue.effectScope();
    try {
      const A = portee.run(() =>
        setupAdmin(
          vueDeTest,
          refs,
          ctx,
          new ClientHttp(new GestionnaireSession(), () => Promise.resolve(json({}))),
        ),
      )!;
      await A.goAdminPage("logs", "security");
      user.value = null;
      await Vue.nextTick();
      user.value = { username: "mo", role: "moderator", is_admin: 2 };
      await Vue.nextTick();
      expect(await A.goAdminPage("logs")).toBe(true);
      await Vue.nextTick();
      expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["logs", "technical"]);
    } finally {
      portee.stop();
    }
  });

  it("palette : les onglets des pages y figurent et mènent au bon onglet", async () => {
    const { A } = monter(() => json({}));
    A.openPalette();
    A.paletteQuery.value = "Journaux › Sécurité";
    await Vue.nextTick();
    const r = A.paletteResults.value.find((x) => x.page === "logs" && x.onglet === "security");
    expect(r?.label).toBe("Journaux › Sécurité");
    await A.runPaletteItem(r);
    expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["logs", "security"]);
    A.openPalette();
    A.paletteQuery.value = "Appels d";
    await Vue.nextTick();
    await A.runPaletteItem(A.paletteResults.value.find((x) => x.onglet === "tool-calls"));
    expect([A.adminTab.value, A.adminOngletCourant.value]).toEqual(["activity", "tool-calls"]);
  });

  it("Journaux : l'horodatage porte la date et l'heure", () => {
    const { A } = monter(() => json({}));
    const ts = new Date(2026, 10, 7, 20, 41, 5).getTime() / 1000;
    expect(A.fmtLogTs(ts)).toBe("07/11 20:41:05");
    expect(A.fmtLogTs(null)).toBe("");
  });

  it("navigue entre pages selon le rôle et retient la page de l'entrée", async () => {
    const { A } = monter(() => json({}));
    expect(A.adminTab.value).toBe("overview");
    expect(await A.goAdminPage("accounts")).toBe(true);
    expect(A.adminTab.value).toBe("accounts");
    expect(A.adminPage.value.label).toBe("Comptes");
    expect(await A.goAdminPage("inconnue")).toBe(false);
    expect(A.adminNav.value.map((e) => e.id)).toContain("sandbox");
  });

  it("réinitialisation d'un mot de passe : la saisie est effacée une fois acceptée", async () => {
    const corps: unknown[] = [];
    const { A } = monter((url, init) => {
      if (url === "/api/admin/reset-password") corps.push(JSON.parse(String(init?.body)));
      return json({ ok: true });
    });
    A.openResetModal({ id: 7, username: "bob" } as CompteConsole);
    A.newPasswordInput.value = "Nouveau-mot-1";
    await A.confirmReset();
    expect(corps).toEqual([{ target_id: 7, new_password: "Nouveau-mot-1" }]);
    expect(A.newPasswordInput.value).toBe("");
  });

  it("écoute et HTTPS : un redémarrage refusé par le serveur est signalé, pas annoncé", async () => {
    const { A, toasts } = monter((url) =>
      url === "/api/admin/security/listen"
        ? json({ ok: false, listen: "local", main_restarted: false })
        : url === "/api/admin/security/https"
          ? json({ ok: false, enabled: true, urls: { admin: "https://h:8444" }, main_restarted: false })
          : json({}),
    );
    A.httpsStatus.value = { listen: "lan", enabled: false } as typeof A.httpsStatus.value;
    await A.setListen("local");
    await A.toggleHttps();
    expect(toasts).toEqual([REDEMARRAGE_MANUEL, REDEMARRAGE_MANUEL]);
    expect(A.httpsRedirectUrl.value).toBe("");
  });

  it("habillages personnels : défauts remplis, interrupteur et plafond envoyés par le patch de config", async () => {
    const envoyes: unknown[] = [];
    const { A } = monter((url, init) => {
      if (url.startsWith("/api/admin/config-file"))
        return json({ content: JSON.stringify({ skins: { dir: "x" } }) });
      if (url === "/api/admin/config" && init?.method === "PATCH")
        envoyes.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    });
    await A.loadAdminConfig("main");
    A.adminTab.value = "appearance";
    const form = A.configForm.value as unknown as { skins: { user_custom: boolean; user_max: number } };
    expect(form.skins).toMatchObject({ user_custom: true, user_max: 10 });
    expect(A.adminPageChanges.value).toEqual([]);
    form.skins.user_custom = false;
    form.skins.user_max = 3;
    expect(A.adminPageChanges.value.map((c) => c.path).sort()).toEqual([
      "skins.user_custom",
      "skins.user_max",
    ]);
    expect(await A.saveAdminPage()).toBe(true);
    const corps = envoyes[0] as { changes: { path: string; to: unknown }[] };
    expect(Object.fromEntries(corps.changes.map((c) => [c.path, c.to]))).toEqual({
      "skins.user_custom": false,
      "skins.user_max": 3,
    });
  });

  it("une page sans modification ne propose rien à enregistrer ; la garde de sortie laisse partir", async () => {
    const { A } = monter(() => json({}));
    expect(A.adminDirtyCount.value).toBe(0);
    expect(await A.adminConfirmLeave()).toBe(true);
    expect(await A.saveAdminPage()).toBe(true);
  });

  it("détail des modifications : une clé secrète est dite « modifiée » sans valeur, ses voisines gardent la leur, l'enregistrement envoie la vraie valeur", async () => {
    const envoyes: unknown[] = [];
    const { A } = monter((url, init) => {
      if (url.startsWith("/api/admin/config-file"))
        return json({
          content: JSON.stringify({ rag: { embed: { api_key: "********", model: "m1" } } }),
        });
      if (url === "/api/admin/config" && init?.method === "PATCH")
        envoyes.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    });
    await A.loadAdminConfig("main");
    A.adminTab.value = "rag";
    const form = A.configForm.value as unknown as {
      rag: { service_token: string; embed: { api_key: string; model: string } };
      voice: { stt: { token: string } };
    };
    expect(form.rag.embed.api_key).toBe("********");
    form.rag.service_token = "jeton-secret-1";
    form.rag.embed.api_key = "nouvelle-cle";
    form.rag.embed.model = "m2";
    form.voice.stt.token = "jeton-voix";
    const lignes = A.adminPageChanges.value;
    expect(lignes.map((c) => [c.path, A.adminChangeSecret(c)]).sort()).toEqual([
      ["rag.embed.api_key", true],
      ["rag.embed.model", false],
      ["rag.service_token", true],
      ["voice.stt.token", true],
    ]);
    expect(A.adminChangeValue(lignes.find((c) => c.path === "rag.embed.model")?.after)).toBe("m2");
    expect(await A.saveAdminPage()).toBe(true);
    const corps = envoyes[0] as { changes: { path: string; to: unknown }[] };
    expect(Object.fromEntries(corps.changes.map((c) => [c.path, c.to]))).toEqual({
      "rag.service_token": "jeton-secret-1",
      "rag.embed.api_key": "nouvelle-cle",
      "rag.embed.model": "m2",
      "voice.stt.token": "jeton-voix",
    });
  });

  it("chemins de secrets de config.json (miroir de SECRETS_MASQUES) reconnus ; réglages de jetons non secrets laissés", () => {
    const { A } = monter(() => json({}));
    for (const chemin of [
      "llama.api_key",
      "rag.embed.api_key",
      "rag.service_token",
      "rag.qdrant_api_key",
      "agent_memory.qdrant_api_key",
      "agent_memory.embed_api_key",
      "voice.stt.token",
      "voice.tts.token",
      "app.session_secret",
      "app.encryption_key",
      "mcp.local_token",
      "image.api_key_enc",
    ])
      expect(A.adminChangeSecret({ path: chemin }), chemin).toBe(true);
    expect(A.adminChangeSecret({ path: "metrics.scrape_token" })).toBe(true);
    for (const chemin of [
      "llama.max_tokens",
      "compaction.threshold_tokens",
      "mcp.tokens.max_days",
      "rag.embed.model",
      "security.password_policy.min_length",
    ])
      expect(A.adminChangeSecret({ path: chemin }), chemin).toBe(false);
  });

  it("la palette classe les pages avant les réglages et retrouve un réglage par son libellé", () => {
    const { A } = monter(() => json({}));
    A.openPalette();
    expect(A.paletteResults.value.length).toBeGreaterThan(5);
    A.paletteQuery.value = "sessions";
    const premiers = A.paletteResults.value.slice(0, 3).map((r) => r.label);
    expect(premiers.join(" ")).toContain("sessions");
    A.closePalette();
  });

  it("charge les comptes et expose tri, filtre et pages", async () => {
    const compte = {
      id: 1,
      username: "alice",
      is_admin: 1,
      created_at: 1,
      avatar: null,
      group_names: "",
      group_ids: [],
      sandbox_quota_mb: 0,
      network_profile_id: "isolated",
      forced_network_profile_id: "",
      sandbox_used_mb: 0,
      llm_engine_keys: null,
      llm_can_manage_models: null,
      llm_effective_engine_keys: null,
      llm_engine_source: "admin",
      llm_effective_can_manage_models: true,
      llm_manage_source: "admin",
    };
    const { A } = monter((url) =>
      url.startsWith("/api/admin/users-with-groups")
        ? json({
            users: [compte, { ...compte, id: 2, username: "bob", is_admin: 0 }],
            network_profiles: [],
            desktop_targets: [],
          })
        : json({ engines: [] }),
    );
    await A.loadUsers();
    expect(A.pagedUsers.value.map((u) => u.username)).toEqual(["alice", "bob"]);
    A.usersSearch.value = "bo";
    expect(A.filteredSortedUsers.value.map((u) => u.username)).toEqual(["bob"]);
    A.usersSearch.value = "";
    A.toggleUsersSort("username");
    A.toggleUsersSort("username");
    expect(A.pagedUsers.value.map((u) => u.username)).toEqual(["bob", "alice"]);
  });

  it("logo de l'application : le choix ouvre le recadrage, l'image validée remplace le logo du formulaire", async () => {
    const { A, toasts } = monter(() => json({}));
    A.configForm.value = {
      app_info: { logo_b64: "", use_welcome_image: true },
    } as unknown as typeof A.configForm.value;
    const champ = document.createElement("input");
    champ.type = "file";
    const brute = new File([new Uint8Array(32)], "logo.svg", { type: "image/svg+xml" });
    Object.defineProperty(champ, "files", { value: [brute] });
    A.handleAppInfoLogoUpload({ target: champ } as unknown as Event);
    expect(A.logoARecadrer.value).toBe(brute);
    expect(A.configForm.value?.app_info.logo_b64).toBe("");
    A.appliquerLogoRecadre(new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
    expect(A.logoARecadrer.value).toBeNull();
    await vi.waitFor(() => expect(A.configForm.value?.app_info.logo_b64).toBe("data:image/png;base64,AQID"));
    expect(A.configForm.value?.app_info.use_welcome_image).toBe(false);
    A.handleAppInfoLogoUpload({ target: champ } as unknown as Event);
    A.erreurRecadrageLogo("Image illisible.");
    expect([A.logoARecadrer.value, toasts]).toEqual([null, ["Image illisible."]]);
  });
});
