// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/reglages.ts — composition des Paramètres du compte (`setupSettings`) : persistance, apparence, MCP, prompts, archives, aide, sandbox, préférences, agents et familles dédiées, sous la surface plate lue par la racine. */
import type { ClientHttp } from "../../platform/http/client";
import { creerAgents } from "./agents";
import { creerAide } from "./aide";
import { creerApparence } from "./apparence";
import { creerArchives } from "./archives";
import { setupCoffre } from "../coffre/coffre";
import { setupGitConnecteurs } from "./connecteurs-git";
import { setupLlmConnecteurs } from "./connecteurs-llm";
import { setupConnexions } from "./connexions";
import { creerMcp } from "./mcp";
import { setupMemoire } from "./memoire";
import { creerModale } from "./modale";
import { creerPersistance } from "./persistance";
import { creerPreferences } from "./preferences";
import { creerPrompts } from "./prompts";
import { creerSandbox } from "./sandbox";
import type { CtxReglages, RefsReglages, VueReglages } from "./types";
import { setupUtilisation } from "./utilisation";

export function setupReglages(vue: VueReglages, refs: RefsReglages, ctx: CtxReglages, http: ClientHttp) {
  const { settings, config } = refs;
  const showSettingsModal = vue.ref(false);
  const liens = { closeSettings: (_sauter?: boolean): Promise<void> | void => undefined };

  const persistance = creerPersistance(vue, settings, ctx, {
    closeSettings: (sauter) => liens.closeSettings(sauter),
  });
  persistance.activerEnregistrementAuto(showSettingsModal);
  const apparence = creerApparence(vue, settings, ctx, persistance);
  const mcp = creerMcp(vue, settings, config, ctx, persistance);
  const { reinitialiserAFermeture: razPrompts, ...prompts } = creerPrompts(
    vue,
    refs,
    ctx,
    showSettingsModal,
    {
      closeSettings: async () => {
        await liens.closeSettings();
      },
    },
  );
  const { reinitialiserAFermeture: razArchives, ...archives } = creerArchives(vue, ctx);
  const aide = creerAide(vue, ctx);
  const { stopSandboxPolling, ...sandbox } = creerSandbox(vue, ctx);
  const { reinitialiserEpingles, ...preferences } = creerPreferences(vue, settings, ctx, persistance);
  const agents = creerAgents(vue, settings, ctx, persistance);

  const connexions = setupConnexions(ctx, http);
  const git = setupGitConnecteurs(ctx, http);
  const coffre = setupCoffre(ctx, http);
  const llm = setupLlmConnecteurs(ctx, http);
  const utilisation = setupUtilisation(http);
  const memoire = setupMemoire(
    ctx,
    {
      settings,
      snapshot: persistance.snapshot,
      showSettingsModal,
      closeSettings: () => liens.closeSettings(),
    },
    http,
  );

  const modale = creerModale(vue, refs, ctx, persistance, showSettingsModal, {
    loadAppSkins: apparence.loadAppSkins,
    loadSharedMcpServers: mcp.loadSharedMcpServers,
    reinitialiserEpingles: reinitialiserEpingles,
    loadSavedPrompts: prompts.loadSavedPrompts,
    loadSharedPrompts: prompts.loadSharedPrompts,
    loadPromptTemplates: prompts.loadPromptTemplates,
    loadArchives: archives.loadArchives,
    loadLlmConnectors: llm.loadLlmConnectors,
    loadUsageData: utilisation.loadUsageData,
    loadUserMemory: memoire.loadUserMemory,
    loadSandboxState: sandbox.loadSandboxState,
    loadGitConnectors: git.loadGitConnectors,
    loadCoffre: coffre.loadCoffre,
    loadConnexions: connexions.loadConnexions,
    cnxReset: connexions.cnxReset,
    cancelMemoryEdit: memoire.cancelMemoryEdit,
    startNewTemplate: () => prompts.startNewTemplate(),
    stopSandboxPolling: stopSandboxPolling,
    reinitialisations: [
      razArchives,
      razPrompts,
      () => {
        mcp.mcpSearch.value = "";
      },
    ],
    etatsSales: [persistance.settingsDirty, memoire.memoryDirty, prompts.templateDirty],
  });
  liens.closeSettings = (sauter) => modale.closeSettings(sauter);

  return {
    ...llm,
    ...connexions,
    ...git,
    ...coffre,
    ...memoire,
    ...utilisation,
    ...apparence,
    ...mcp,
    ...prompts,
    ...archives,
    ...aide,
    ...sandbox,
    ...preferences,
    ...agents,
    ...modale,
    showSettingsModal,
    settingsSaving: persistance.settingsSaving,
    passwordSaving: persistance.passwordSaving,
    settingsDirty: persistance.settingsDirty,
    saveSettings: persistance.saveSettings,
  };
}

export type SurfaceReglages = ReturnType<typeof setupReglages>;
