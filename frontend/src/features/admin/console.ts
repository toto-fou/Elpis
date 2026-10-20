// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/console.ts — composition de la console d'administration (`setupAdmin`) : familles de pages, liens entre elles et surface plate lue par la racine. */
import type { ClientHttp } from "../../platform/http/client";
import { creerAgentsAdmin } from "./agents";
import { creerApercu } from "./apercu";
import { creerAx } from "./ax";
import { creerComptes } from "./comptes";
import { creerConfig } from "./config";
import { creerDonnees } from "./donnees";
import { creerEnregistrement } from "./enregistrement";
import { creerEtatAdmin } from "./etat";
import type { BaseAdmin, LiensAdmin } from "./etat";
import { setupAdminHotesOutils } from "./hotes-outils";
import { creerInference } from "./inference";
import { creerJournaux } from "./journaux";
import { creerMetriques } from "./metriques";
import { creerNavigation } from "./navigation";
import { creerObservabilite } from "./observabilite";
import { setupAdminMcp } from "./outils-mcp";
import { creerPalette } from "./palette";
import { setupAdminPrometheus } from "./prometheus";
import { creerPrompts } from "./prompts";
import { setupAdminRag } from "./rag";
import { setupAdminRapport } from "./rapport";
import { NAV_ADMIN } from "./registre";
import { creerSandboxAdmin } from "./sandbox";
import { creerSecurite } from "./securite";
import { creerServeur } from "./serveur";
import { creerTransferts } from "./transferts";
import type { CtxAdmin, RefsAdmin, VueAdmin } from "./types";

/** Confirmation saisie (irréversible) ; repli sur la confirmation simple si l'hôte ne la fournit pas. */
function avecConfirmationSaisie(ctx: CtxAdmin): CtxAdmin {
  if (ctx.openTypedConfirm) return ctx;
  return Object.create(ctx, {
    openTypedConfirm: {
      value: (titre: string, texte: string, _mot: string, libelle: string): Promise<boolean> =>
        ctx.openConfirm(titre, texte, true, libelle),
    },
  }) as CtxAdmin;
}

export function setupAdmin(vue: VueAdmin, refs: RefsAdmin, ctxHote: CtxAdmin, http: ClientHttp) {
  const ctx = avecConfirmationSaisie(ctxHote);
  const e = creerEtatAdmin(vue);
  const lien = {} as LiensAdmin;
  const b: BaseAdmin = {
    vue,
    refs,
    ctx,
    nav: NAV_ADMIN,
    e,
    lien,
    estAdmin: () => !!(refs.user.value && refs.user.value.role === "admin"),
  };

  const {
    storeSnapshot,
    markAdminStoreClean,
    liberer: libererEnregistrement,
    ...enregistrement
  } = creerEnregistrement(b);
  Object.assign(lien, {
    adminConfirmLeave: enregistrement.adminConfirmLeave,
    adminDirtyCount: () => enregistrement.adminDirtyCount.value,
    adminChangeLabel: enregistrement.adminChangeLabel,
    storeSnapshot,
    markAdminStoreClean,
  });
  const { liberer: libererNavigation, ...navigation } = creerNavigation(b);
  Object.assign(lien, { goAdminPage: navigation.goAdminPage, focusAdminTitle: navigation.focusAdminTitle });
  const securite = creerSecurite(b);
  Object.assign(lien, {
    revokeAllSessions: securite.revokeAllSessions,
    loadSecurityOverview: securite.loadSecurityOverview,
    loadHttpsStatus: securite.loadHttpsStatus,
  });
  const serveur = creerServeur(b);
  lien.restartServer = serveur.restartServer;
  const apercu = creerApercu(b);
  Object.assign(lien, {
    loadOverview: apercu.loadOverview,
    overviewShortcut: apercu.overviewShortcut,
    loadRestartStatus: apercu.loadRestartStatus,
  });
  const { liberer: libererMetriques, ...metriques } = creerMetriques(b);
  Object.assign(lien, {
    loadAdminStats: metriques.loadAdminStats,
    destroyAllCharts: metriques.destroyAllCharts,
  });
  const journaux = creerJournaux(b);
  lien.loadRecentLogs = journaux.loadRecentLogs;
  const transferts = creerTransferts(b);
  Object.assign(lien, {
    downloadBackup: transferts.downloadBackup,
    downloadWithModal: transferts.downloadWithModal,
  });
  const comptes = creerComptes(b);
  Object.assign(lien, {
    loadUsers: comptes.loadUsers,
    loadAdmLlmAccessOptions: comptes.loadAdmLlmAccessOptions,
  });
  const inference = creerInference(b);
  Object.assign(lien, {
    loadCompressionCfg: inference.loadCompressionCfg,
    saveCompressionCfg: inference.saveCompressionCfg,
    loadLlmScheduling: inference.loadLlmScheduling,
    saveLlmSchedulingMode: inference.saveLlmSchedulingMode,
    loadAdminLlmConnectors: inference.loadAdminLlmConnectors,
    saveAdmAllowed: inference.saveAdmAllowed,
    onEngineSelect: inference.onEngineSelect,
  });
  const donnees = creerDonnees(b);
  Object.assign(lien, { loadVoiceModels: donnees.loadVoiceModels, loadImageModels: donnees.loadImageModels });
  const prompts = creerPrompts(b);
  Object.assign(lien, { savePrompt: prompts.savePrompt, reloadPrompt: prompts.reloadPrompt });
  const { execConfigPayload, ...sandbox } = creerSandboxAdmin(b);
  Object.assign(lien, {
    loadExecConfig: sandbox.loadExecConfig,
    saveExecConfig: sandbox.saveExecConfig,
    execConfigPayload,
  });
  const agents = creerAgentsAdmin(b);
  Object.assign(lien, {
    loadAgentsConfig: agents.loadAgentsConfig,
    saveAgentsConfig: agents.saveAgentsConfig,
  });
  const config = creerConfig(b);
  Object.assign(lien, { loadAdminConfig: config.loadAdminConfig, saveConfigStore: config.saveConfigStore });
  const { liberer: libererPalette, ...palette } = creerPalette(b, {
    liberer: libererNavigation,
    ...navigation,
  });
  const observabilite = creerObservabilite(b);
  const ax = creerAx(b);

  const rapport = setupAdminRapport(ctx, http);
  const prometheus = setupAdminPrometheus(ctx, http);
  const outilsMcp = setupAdminMcp(ctx, http);
  const hotes = setupAdminHotesOutils(ctx, http);
  const rag = setupAdminRag(b, http);

  vue.onUnmounted(() => {
    libererMetriques();
    libererNavigation();
    libererEnregistrement();
    libererPalette();
  });

  return {
    ...apercu,
    ...navigation,
    ...palette,
    ...enregistrement,
    ...securite,
    ...serveur,
    ...metriques,
    ...journaux,
    ...transferts,
    ...comptes,
    ...inference,
    ...donnees,
    ...prompts,
    ...sandbox,
    ...agents,
    ...config,
    ...observabilite,
    ...ax,
    ...rapport,
    ...prometheus,
    ...outilsMcp,
    ...hotes,
    ...rag,
    adminTab: e.adminTab,
    adminMeOpen: e.adminMeOpen,
    adminChangesOpen: e.adminChangesOpen,
    dashMenu: e.dashMenu,
  };
}

export type SurfaceAdmin = ReturnType<typeof setupAdmin>;
