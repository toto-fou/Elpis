// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/chat.ts — composant chat : crée l'état et les parties du cœur, monte les modules du chat (composeur, historique, modèles, voix, images, échantillonnage…), les relie et rend la surface lue par la racine et les domaines. */
import * as Vue from "vue";
import { nextTick, watch } from "vue";
import type { ShallowUnwrapRef } from "vue";

import { fmtElapsed, fmtElapsedMs } from "../../../utils/utils-purs";
import type { GestionnaireSession } from "../../auth/session";
import { setupChatSystemSSE } from "../../auth/sse-systeme";
import type { CtxSse } from "../../auth/sse-systeme";
import { creerComposeur } from "../composeur/composeur";
import { creerDepotChat } from "../composeur/depot";
import { setupRunDetails } from "../details-run";
import { setupChatHelpersMisc } from "../flux/aides";
import { setupChatCompressionUI } from "../flux/compression";
import { _thinkingTitle } from "../flux/titre-reflexion";
import { creerHistoriqueChat } from "../historique/historique";
import { creerJobs } from "../jobs/jobs";
import { imageInitialProgress } from "../../images/formats";
import type { DemandeImage } from "../../images/formats";
import type { CtxImages, RefsImages, SurfaceImages } from "../../images/images";
import type {
  CtxEchantillonnage,
  RefsEchantillonnage,
  SurfaceEchantillonnage,
} from "../../reglages/echantillonnage";
import type { CtxVoix, RefsVoix, SurfaceVoix } from "../../voix/voix";
import type { DepsHistorique, RefsHistorique } from "../historique/historique";
import { creerRechercheChat } from "../historique/recherche";
import { creerDefilementVirtuel } from "../liste/defilement-virtuel";
import type { RefsDefilement } from "../liste/defilement-virtuel";
import { compterBulles } from "../liste/regroupement";
import { setupChatWebshot } from "../message/captures-web";
import { setupChatMessageEdit } from "../message/edition";
import type { RefsEdition } from "../message/edition";
import { creerCartesMemoire } from "../message/effets";
import { creerCarteFichiers, mergeFiles } from "../message/fichiers-modifies";
import { setupChatModels } from "../modeles/modeles";
import type { RefsModeles } from "../modeles/modeles";
import { moteurMarkdown } from "../rendu/instance";
import { creerRenduChat } from "../rendu/rendu-chat";
import type { RefsRenduChat } from "../rendu/rendu-chat";
import { creerCompressionManuelle } from "./compression-manuelle";
import { creerDeltasOutils } from "./deltas-outils";
import { creerEnvoi } from "./envoi";
import { creerEtatChat, creerEtatFlux } from "./etat";
import * as formats from "./formats";
import { creerGeneration } from "./generation";
import type { CoeurChat, LiensChat } from "./liens";
import { creerOutilsChat } from "./outils-chat";
import { analyserBlocsFichiers } from "./persistance";
import { creerQuestionnaire, normaliserQuestions } from "./questionnaire";
import { creerRenduFlux } from "./rendu-flux";
import { creerRuns } from "./runs";
import { creerSegmentsVue } from "./segments-vue";
import type { CtxChat, MessageChat, Objet, RefsRacineChat } from "./types";
import { creerVueFlux } from "./vue-flux";
import type { TacheSession } from "../outils/types";

/** Modules du chat que la racine fournit : la console n'embarque que ceux qu'elle monte. */
export interface ModulesChat {
  echantillonnage(refs: RefsEchantillonnage, ctx: CtxEchantillonnage): SurfaceEchantillonnage;
  voix(refs: RefsVoix, ctx: CtxVoix): SurfaceVoix;
  images(refs: RefsImages, ctx: CtxImages): SurfaceImages;
}

/** Surface du chat vue des gabarits (refs déballées par la racine). */
export type SurfaceChat = ShallowUnwrapRef<ReturnType<typeof setupChat>>;

export function setupChat(
  session: GestionnaireSession,
  refs: RefsRacineChat,
  ctx: CtxChat,
  modules: ModulesChat,
) {
  const { user, settings, messages, currentChatId, inputMessage, inputRef, isStreaming, isUserScrolling } =
    refs;
  const e = creerEtatChat();
  const f = creerEtatFlux();
  const md = moteurMarkdown();
  // Table des fonctions croisées, remplie plus bas (résolues à l'appel).
  const l = {} as LiensChat;
  const c: CoeurChat = { r: refs, ctx, e, f, md, l };

  // Fin de tour : les onglets ouverts sont revérifiés (écritures hors flux).
  watch(isStreaming, (v, avant) => {
    if (avant && !v) ctx.checkExternalModsSoon?.(500);
  });

  const compression = setupChatCompressionUI(
    Vue,
    { compressionStatus: e.compressionStatus, compressionProgress: e.compressionProgress },
    { _getStreamMsgs: () => l.getStreamMsgs(), _patch: (i, p) => l.patch(i, p) },
  );
  const manuelle = creerCompressionManuelle(c);
  const recherche = creerRechercheChat(Vue, {}, { fetchAuth: ctx.fetchAuth });
  const echantillonnage = modules.echantillonnage(
    {
      selectedModel: e.selectedModel,
      activeModelIds: e.activeModelIds,
      selectedConnector: e.selectedConnector,
      selectedEngineMeta: e.selectedEngineMeta,
    } as unknown as RefsEchantillonnage,
    { fetchAuth: ctx.fetchAuth },
  );
  const panneaux: Record<string, { value: boolean }> = {
    mcp: e.showMcpPanel,
    rag: e.showRagPanel,
    sampling: echantillonnage.showSamplingPanel,
  };
  // Un seul panneau du chat ouvert à la fois ; l'ouverture charge ce qu'il affiche.
  function togglePanel(nom: string): void {
    const cible = panneaux[nom];
    if (!cible) return;
    const ouvrir = !cible.value;
    for (const p of Object.values(panneaux)) p.value = false;
    cible.value = ouvrir;
    if (ouvrir && nom === "sampling") void echantillonnage.loadEffectiveParams(e.selectedModel.value);
  }

  const outils = creerOutilsChat(c);
  let images: SurfaceImages | null = null;
  const composeur = creerComposeur(
    Vue,
    { inputRef, inputMessage, attachedFiles: e.attachedFiles, isStreaming },
    {
      fetchAuth: ctx.fetchAuth,
      showToast: ctx.showToast,
      sendMessage: () => l.sendMessage(),
      manualCompress: () => l.manualCompress(),
      setPlanMode: (on: boolean) => outils.setPlanMode(on),
      get autoResize() {
        return ctx.autoResize;
      },
      openSettingsTab: (onglet: string) => ctx.openSettingsTab?.(onglet),
      openHelp: (doc?: string) => ctx.openHelp?.(doc),
      get env() {
        return {
          chatId: currentChatId.value,
          isStreaming: isStreaming.value,
          planMode: e.planMode.value,
          imageAvailable: !!images?.imageAvailable.value,
        };
      },
      imageSlash: (raw: unknown) => envoi.runImageSlash(raw),
      get jobs() {
        return jobs.jobsSlash;
      },
      get userName() {
        const u = user.value;
        return (u && (u.display_name || u.username)) || "";
      },
    },
  );
  const captures = setupChatWebshot(Vue, { messages });
  const voix = modules.voix(
    { settings, features: refs.features, inputMessage, inputRef, messages },
    {
      fetchAuth: ctx.fetchAuth,
      showToast: ctx.showToast,
      get announce() {
        return ctx.announce;
      },
      get autoResize() {
        return ctx.autoResize;
      },
      get nextTick() {
        return nextTick;
      },
    },
  );
  images = modules.images(
    { settings, isStreaming, attachedFiles: e.attachedFiles, currentChatId },
    {
      showToast: ctx.showToast,
      focusInput: () => void nextTick(() => inputRef.value?.focus()),
      openChat: (id: unknown) => historique.loadChat(String(id)),
    },
  );
  const moduleImages = images;

  const rendu = creerRenduFlux(c);
  const runs = creerRuns(c, session);
  const fenetre = creerDefilementVirtuel(
    Vue,
    { messages, chatContainer: e.chatContainer, isUserScrolling } as unknown as RefsDefilement,
    ctx,
  );
  const renduChat = creerRenduChat(
    md,
    Vue,
    {
      messages,
      currentChatId,
      user,
      settings,
      inputRef,
      chatContainer: e.chatContainer,
      currentChatTitle: e.currentChatTitle,
    } as unknown as RefsRenduChat,
    ctx,
  );
  const messageSearchCount = Vue.computed(() => {
    const q = (recherche.messageSearchQ.value || "").toLowerCase();
    if (!q) return 0;
    return compterBulles(messages.value, (m) => (m.content ? m.content.toLowerCase().includes(q) : false));
  });
  const deltas = creerDeltasOutils(c);
  const aides = setupChatHelpersMisc(
    Vue,
    { settings },
    {
      fetchAuth: ctx.fetchAuth,
      _getStreamMsgs: () => l.getStreamMsgs(),
      _patch: (i, p) => l.patch(i, p),
    },
  );
  const carteFichiers = creerCarteFichiers(
    Vue,
    { settings },
    ctx as Parameters<typeof creerCarteFichiers>[2],
  );
  const cartesMemoire = creerCartesMemoire(Vue, { currentChatId }, ctx);
  const detailsRun = setupRunDetails(Vue, ctx);
  const edition = setupChatMessageEdit(
    Vue,
    { messages, isStreaming, isUserScrolling } as unknown as RefsEdition,
    {
      scrollToBottom: (force) => l.scrollToBottom(force),
      generateResponse: () => l.generateResponse(),
      openConfirm: ctx.openConfirm,
      resetDiffCardState: carteFichiers.resetDiffCardState,
      sweepOrphanCharts: renduChat.sweepOrphanCharts,
    },
  );
  const vueFlux = creerVueFlux(c);
  const generation = creerGeneration(c, session);
  const questionnaire = creerQuestionnaire(c);
  const segments = creerSegmentsVue(c, (s) => cartesMemoire.toolStepsForDisplay(s));
  const modeles = setupChatModels(
    Vue,
    {
      availableModels: e.availableModels,
      selectedModel: e.selectedModel,
      activeModelIds: e.activeModelIds,
      llmHealth: e.llmHealth,
      isLoadingModel: e.isLoadingModel,
      showModelProps: e.showModelProps,
      modelPropsData: e.modelPropsData,
      modelPropsLoading: e.modelPropsLoading,
      showModelManager: e.showModelManager,
      selectedConnector: e.selectedConnector,
      selectedEngineMeta: e.selectedEngineMeta,
    } as RefsModeles,
    ctx,
  );
  const composeurTyped = composeur as typeof composeur & {
    pinnedSkills: { value: { name: string; description?: string; domain?: string }[] };
    resetSlash(): void;
    slashResolve(texte: string): unknown;
    slashRun(entree: unknown): Promise<unknown>;
    slashDismiss(): void;
  };
  const historique = creerHistoriqueChat(
    Vue,
    {
      messages,
      currentChatId,
      currentChatTitle: e.currentChatTitle,
      currentView: refs.currentView,
      isStreaming,
      isThinking: e.isThinking,
      statusText: e.statusText,
      isUserScrolling,
      chats: e.chats,
      inputRef,
      attachedFiles: e.attachedFiles,
      user,
    } as unknown as RefsHistorique,
    {
      fetchAuth: ctx.fetchAuth,
      showToast: ctx.showToast,
      openConfirm: ctx.openConfirm,
      openPrompt: (t: string, v?: string) => ctx.openPrompt(t, v).then((x) => x ?? null),
      showSidebar: ctx.showSidebar ?? Vue.ref(false),
      clearSavedSession: () => ctx.clearSavedSession?.(),
      announce: (m: string) => ctx.announce?.(m),
    },
    {
      compterJobsActifs: (ids: readonly string[]) => jobs.jobsCompterActifs(ids),
      detachFromStream: () => void runs.detachFromStream(),
      stopRunForChat: (id: string) => runs.stopRunForChat(id),
      attachRun: (id: string, st: Objet) => runs.attachRun(id, st),
      followRun: (id: string, o: { silent: boolean }) => runs.followRun(id, o),
      _parseFileBlocks: analyserBlocsFichiers,
      scrollToBottom: (force?: boolean) => l.scrollToBottom(force),
      settleScrollBottom: () => rendu.settleScrollBottom(),
      _revokeAllWebShotBlobs: captures._revokeAllWebShotBlobs,
      _vsReset: fenetre._vsReset,
      _vsInitTail: fenetre._vsInitTail,
      clearMarkdownCache: renduChat.clearMarkdownCache,
      clearChartInstances: renduChat.clearChartInstances,
      resetDiffCardState: carteFichiers.resetDiffCardState,
      resetMessageSearch: recherche.resetMessageSearch,
      loadAvailableModels: () => modeles.loadAvailableModels(),
      cancelEditMessage: edition.cancelEditMessage,
      setTodoList: (t: readonly unknown[]) => {
        e.todoList.value = (Array.isArray(t) ? t : []) as TacheSession[];
        e.todoPanelOpen.value = false;
      },
      activeToolCats: outils.activeToolCats,
      applyChatTools: outils.applyChatTools,
      defaultToolKeys: outils.defaultToolKeys,
      resetSlash: composeurTyped.resetSlash,
      resetImageCompose: moduleImages.closeImageMode,
      clearPinnedSkills: () => {
        composeurTyped.pinnedSkills.value = [];
      },
      resetAskUser: questionnaire.resetAskUser,
      closeTaskModal: segments.closeTaskModal,
      applyChatPlanMode: outils.applyChatPlanMode,
      applyChatCtxUsage: (u: unknown, id: string) => outils.applyChatCtxUsage(u, id),
    } as unknown as DepsHistorique,
    session,
  );
  const jobs = creerJobs(
    { currentChatId, inputMessage, isStreaming },
    {
      fetchAuth: ctx.fetchAuth,
      showToast: ctx.showToast,
      openConfirm: (t, x, d, o) => ctx.openConfirm(t, x ?? "", d, o),
      ...(typeof ctx.openInEditor === "function"
        ? { openInEditor: ctx.openInEditor as (chemin: string) => unknown }
        : {}),
      loadChat: (id, o) => historique.loadChat(id, o),
      reattachOrFollow: (id) => runs.reattachOrFollow(id),
    },
  );
  const envoi = creerEnvoi(c, {
    closeMentionDropdown: composeur.closeMentionDropdown,
    slashResolve: composeurTyped.slashResolve,
    slashRun: composeurTyped.slashRun,
    slashDismiss: composeurTyped.slashDismiss,
    pinnedSkills: composeurTyped.pinnedSkills,
    images: moduleImages,
    ensureServerChat: (s) => generation.ensureServerChat(s),
    startNewChat: () => historique.startNewChat(),
  });
  const depot = creerDepotChat(Vue, { attachedFiles: e.attachedFiles }, ctx);
  const sse = setupChatSystemSSE(
    { user, isLoadingModel: e.isLoadingModel as unknown as Vue.Ref<boolean>, isStreaming },
    ctx as unknown as CtxSse,
    {
      onReconnect: () => {
        void modeles.loadAvailableModels();
        void historique.loadChatsList();
        void jobs.jobsRecharger();
        ctx.refreshNotifBadge?.();
      },
      onModelStatus: (data) => modeles._applyModelData(data),
      onModelChanged: () => void modeles.loadAvailableModels(),
      onNotification: (data) => ctx.onNotificationEvent?.(data),
      onChatJob: (data) => jobs.jobsSurChatJob(data),
      onChatWake: (data) => jobs.jobsSurChatWake(data),
      pollModels: () => void modeles.loadAvailableModels(),
    },
    { session },
  );

  // Titre généré par le modèle : flash de renommage sur l'en-tête et l'entrée de la barre latérale.
  let minuterieTitre: ReturnType<typeof setTimeout> | null = null;
  function flashRenamedTitle(entree: { _renamed?: boolean } | undefined): void {
    e.titleFlash.value = true;
    if (minuterieTitre) clearTimeout(minuterieTitre);
    minuterieTitre = setTimeout(() => {
      e.titleFlash.value = false;
    }, 1600);
    if (entree) {
      entree._renamed = true;
      setTimeout(() => {
        entree._renamed = false;
      }, 1600);
    }
  }

  Object.assign(l, {
    getStreamMsgs: rendu.getStreamMsgs,
    streamIdx: rendu.streamIdx,
    patch: rendu.patch,
    setMsgUi: rendu.setMsgUi,
    scrollToBottom: rendu.scrollToBottom,
    scheduleStreamScroll: rendu.scheduleStreamScroll,
    vsEnsureTail: fenetre._vsEnsureTail,
    stopThinkFlush: rendu.stopThinkFlush,
    stopPreContentFlush: rendu.stopPreContentFlush,
    flushPreContentBuf: rendu.flushPreContentBuf,
    flushThinkBuf: rendu.flushThinkBuf,
    stopStreamFlush: rendu.stopStreamFlush,
    armStreamFlush: rendu.armStreamFlush,
    applyPreRender: rendu.applyPreRender,
    flushShellPend: rendu.flushShellPend,
    armerShell: rendu.armerShell,
    shellFoldPend: rendu.shellFoldPend,
    seedLiveCtx: generation.seedLiveCtx,
    clearLiveCtx: generation.clearLiveCtx,
    getCtxSize: generation.getCtxSize,
    ctxGaugeApplicable: generation.ctxGaugeApplicable,
    markRunActive: runs.markRunActive,
    markRunDone: runs.markRunDone,
    stopFollowRun: runs.stopFollowRun,
    followRun: runs.followRun,
    setFollowBubble: runs.setFollowBubble,
    reattachOrFollow: runs.reattachOrFollow,
    handleStreamEvent: vueFlux.handleStreamEvent,
    doGenerate: generation.doGenerate,
    generateResponse: generation.generateResponse,
    sendMessage: envoi.sendMessage,
    stopGeneration: generation.stopGeneration,
    closeToolStreamsFor: deltas.closeToolStreamsFor,
    purgeToolStreams: deltas.purgeToolStreams,
    clearToolStreams: deltas.clearToolStreams,
    finalizeAllToolStreams: deltas.finalizeAllToolStreams,
    cancelAllToolStreams: deltas.cancelAllToolStreams,
    handleToolCallDelta: deltas.handleToolCallDelta,
    finalizeToolStream: deltas.finalizeToolStream,
    resetToolStreamsForIter: deltas.resetToolStreamsForIter,
    noteDeltaStatus: deltas.noteDeltaStatus,
    forgetDeltaNames: deltas.forgetDeltaNames,
    resetDeltaStatus: deltas.resetDeltaStatus,
    oublierLibelleDelta: deltas.oublierLibelleDelta,
    refreshCompressionState: manuelle.refreshCompressionState,
    manualCompress: manuelle.manualCompress,
    estimateCompressionMs: compression._estimateCompressionMs,
    recordCompressionDuration: compression._recordCompressionDuration,
    startCompressionTick: compression._startCompressionTick,
    stopCompressionTick: compression._stopCompressionTick,
    loadChatsList: historique.loadChatsList,
    loadChat: historique.loadChat,
    loadAvailableModels: modeles.loadAvailableModels,
    loadLlmConnectors: modeles.loadLlmConnectors,
    resetAskUser: questionnaire.resetAskUser,
    normalizeAskUser: normaliserQuestions,
    flashRenamedTitle,
    mergeFilesChanged: (idx: number, files: unknown) => {
      if (!Array.isArray(files) || !files.length) return;
      const cur = l.getStreamMsgs()[idx];
      if (cur) l.patch(idx, { files_changed: mergeFiles(cur.files_changed, files) });
    },
    extractAndStoreDiffStats: (idx: number, path: string, resultStr: unknown) => {
      try {
        const p: unknown = JSON.parse(typeof resultStr === "string" && resultStr ? resultStr : "{}");
        if (!p || typeof p !== "object" || typeof (p as Objet)["lines_added"] !== "number") return;
        const cur = l.getStreamMsgs()[idx];
        if (!cur) return;
        const avant = (cur["_diffStats"] || {}) as Objet;
        const o = p as Objet;
        l.patch(idx, {
          _diffStats: {
            ...avant,
            [path]: { additions: o["lines_added"], deletions: o["lines_removed"] || 0 },
          },
        });
      } catch {
        /* résultat non JSON */
      }
    },
    recordDiffForMessage: aides._recordDiffForMessage,
    relPath: (p: string) => String(aides._relPath(p)),
    prefetchSandboxFile: aides._prefetchSandboxFile,
    thinkingTitle: _thinkingTitle,
    voix: () => voix,
    imageInitialProgress: (req: unknown) => imageInitialProgress(req as DemandeImage | null),
    imageGenFor: (msgs: readonly unknown[]) => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as MessageChat | undefined;
        if (m && m.role === "user") return (m.image_request as Objet | undefined) || null;
      }
      return null;
    },
    cleanSamplingOverride: () => echantillonnage._cleanSamplingOverride(),
    thinkingBudget: () => echantillonnage.samplingOverride.value.thinking_budget_tokens,
    excludedNames: outils.excludedNames,
    pinnedServers: outils.pinnedServers,
    pinnedSkillNames: () => (composeurTyped.pinnedSkills.value || []).map((s) => s.name),
    clearPinnedSkills: () => {
      composeurTyped.pinnedSkills.value = [];
    },
    cancelPendingChatSearch: () => recherche.cancelPendingSearch(),
    resetDiffCardState: carteFichiers.resetDiffCardState,
    autoResize: renduChat.autoResize,
  } satisfies LiensChat);

  // Nettoyage de session : un départ volontaire arrête le tour, une simple expiration laisse le run finir.
  function resetOnLogout(explicite?: boolean): void {
    try {
      voix.cancelVoice();
    } catch {
      /* voix absente */
    }
    if (explicite) generation.stopGeneration();
    else {
      try {
        e.abortController.value?.abort();
      } catch {
        /* déjà interrompu */
      }
      e.abortController.value = null;
      isStreaming.value = false;
      e.isThinking.value = false;
      e.statusText.value = "";
    }
    runs.stopFollowRun();
    runs.oublierRuns();
    e.attachedFiles.value = [];
    inputMessage.value = "";
    composeurTyped.pinnedSkills.value = [];
    questionnaire.resetAskUser();
    e.todoList.value = [];
    e.queueStatus.value = null;
    jobs.jobsReinitialiser();
    try {
      sse.disconnectSystemEvents();
    } catch {
      /* flux déjà fermé */
    }
  }

  function startChatTitleEdit(): void {
    if (!currentChatId.value) return;
    e.chatTitleDraft.value = e.currentChatTitle.value || "";
    e.editingChatTitle.value = true;
    void nextTick(() => {
      const el = document.getElementById("chat-title-edit-input") as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  }

  async function commitChatTitleEdit(): Promise<void> {
    if (!e.editingChatTitle.value) return;
    const id = currentChatId.value;
    const brouillon = (e.chatTitleDraft.value || "").trim();
    e.editingChatTitle.value = false;
    if (!id || !brouillon || brouillon === e.currentChatTitle.value) return;
    await historique._doRenameChat(id, brouillon);
  }

  function cancelChatTitleEdit(): void {
    e.editingChatTitle.value = false;
    e.chatTitleDraft.value = "";
  }

  const composerPlaceholder =
    window.innerWidth < 640 ? "Envoyer un message..." : "Envoyer un message... (@ pour insérer un fichier)";
  const ech = echantillonnage;
  const v = voix;

  return {
    ...moduleImages,
    ...jobs,
    ...detailsRun,
    _modelPollTimer: sse._modelPollTimer,
    chats: e.chats,
    currentChatTitle: e.currentChatTitle,
    titleFlash: e.titleFlash,
    chatContainer: e.chatContainer,
    isThinking: e.isThinking,
    statusText: e.statusText,
    queueStatus: e.queueStatus,
    todoList: e.todoList,
    todoPanelOpen: e.todoPanelOpen,
    composeColRef: e.composeColRef,
    chatBottomPad: e.chatBottomPad,
    scrollBtnBottom: e.scrollBtnBottom,
    compressionStatus: e.compressionStatus,
    compressionProgress: e.compressionProgress,
    compressionCapped: e.compressionCapped,
    abortController: e.abortController,
    pendingWrite: e.pendingWrite,
    compressionState: e.compressionState,
    manualCompressBusy: e.manualCompressBusy,
    manualCompress: manuelle.manualCompress,
    compactionNotice: e.compactionNotice,
    manualCompressChatId: e.manualCompressChatId,
    fmtNoticeTs: formats.fmtNoticeTs,
    conversationTooLong: e.conversationTooLong,
    ctxRealPct: e.ctxRealPct,
    ctxUsage: e.ctxUsage,
    fmtCtxUsage: formats.fmtCtxUsage,
    applyChatCtxUsage: outils.applyChatCtxUsage,
    toolLimitLabel: formats.toolLimitLabel,
    editingMessageIndex: edition.editingMessageIndex,
    editMessageText: edition.editMessageText,
    chatSearch: recherche.chatSearch,
    chatSearchResults: recherche.chatSearchResults,
    isSearchingChats: recherche.isSearchingChats,
    searchOpen: recherche.searchOpen,
    chatSearchRef: recherche.chatSearchRef,
    openChatSearch: recherche.openChatSearch,
    closeChatSearch: recherche.closeChatSearch,
    attachedFiles: e.attachedFiles,
    localTools: e.localTools,
    mcpUserCategories: e.mcpUserCategories,
    showMcpPanel: e.showMcpPanel,
    showRagPanel: e.showRagPanel,
    ragDropdownRef: e.ragDropdownRef,
    ragCollections: e.ragCollections,
    manifestServers: e.manifestServers,
    manifestTools: e.manifestTools,
    loadManifestServers: outils.loadManifestServers,
    showComposerPlus: e.showComposerPlus,
    composerPlusRef: e.composerPlusRef,
    messageSearch: recherche.messageSearch,
    messageSearchActive: recherche.messageSearchActive,
    messageSearchQ: recherche.messageSearchQ,
    messageSearchCount,
    showChatMenu: e.showChatMenu,
    availableModels: e.availableModels,
    selectedModel: e.selectedModel,
    activeModelIds: e.activeModelIds,
    llmHealth: e.llmHealth,
    isLoadingModel: e.isLoadingModel,
    showModelManager: e.showModelManager,
    modelLoadPct: modeles.modelLoadPct,
    modelLoadStage: modeles.modelLoadStage,
    modelLoadingId: modeles.modelLoadingId,
    showModelProps: e.showModelProps,
    modelPropsData: e.modelPropsData,
    modelPropsLoading: e.modelPropsLoading,
    fetchModelProps: modeles.fetchModelProps,
    fmtPropVal: modeles.fmtPropVal,
    modelsLoading: modeles.modelsLoading,
    modelsError: modeles.modelsError,
    toggleModelMenu: modeles.toggleModelMenu,
    onModelMenuKeydown: modeles.onModelMenuKeydown,
    selectedConnector: e.selectedConnector,
    pickerConnectors: modeles.pickerConnectors,
    pickerConnModels: modeles.pickerConnModels,
    pickerConnLoading: modeles.pickerConnLoading,
    pickerConnFree: modeles.pickerConnFree,
    pickerConnState: modeles.pickerConnState,
    retryConnModels: modeles.retryConnModels,
    isConnModelLoaded: modeles.isConnModelLoaded,
    toggleConnModel: modeles.toggleConnModel,
    selectedModelLabel: modeles.selectedModelLabel,
    builtinAllowed: modeles.builtinAllowed,
    canManageModels: modeles.canManageModels,
    noEngineAllowed: modeles.noEngineAllowed,
    moteurIntegre: modeles.moteurIntegre,
    chargementIntegre: modeles.chargementIntegre,
    selectedEngineMeta: e.selectedEngineMeta,
    pickLocalModel: modeles.pickLocalModel,
    pickConnectorModel: modeles.pickConnectorModel,
    loadMcpUserCategories: outils.loadMcpUserCategories,
    mcpCategoryBgClass: formats.mcpCategoryBgClass,
    mcpCategoryToggleClass: formats.mcpCategoryToggleClass,
    showSamplingPanel: ech["showSamplingPanel"],
    samplingOverride: ech["samplingOverride"],
    thinkingEnabled: ech["thinkingEnabled"],
    clampThinkingBudget: ech["clampThinkingBudget"],
    effectiveParamsData: ech["effectiveParamsData"],
    effectiveParamsLoading: ech["effectiveParamsLoading"],
    ignoredByEngine: ech["ignoredByEngine"],
    isIgnoredByEngine: ech["isIgnoredByEngine"],
    openSamplingPanel: ech["openSamplingPanel"],
    closeSamplingPanel: ech["closeSamplingPanel"],
    loadEffectiveParams: ech["loadEffectiveParams"],
    resetSamplingOverride: ech["resetSamplingOverride"],
    preserveReasoningSupported: ech["preserveReasoningSupported"],
    preserveReasoningEnabled: ech["preserveReasoningEnabled"],
    reasoningEffortValues: ech["reasoningEffortValues"],
    showReasoningEffortMenu: ech["showReasoningEffortMenu"],
    toggleReasoningEffortMenu: ech["toggleReasoningEffortMenu"],
    pickReasoningEffort: ech["pickReasoningEffort"],
    visibleMessages: fenetre.visibleMessages,
    vsTopPad: fenetre.vsTopPad,
    vsBotPad: fenetre.vsBotPad,
    vsFlashIdx: fenetre.vsFlashIdx,
    onChatScroll: fenetre.onChatScroll,
    lastAssistantIdx: fenetre.lastAssistantIdx,
    scrollToMessage: fenetre.scrollToMessage,
    togglePanel,
    activeRunIds: e.activeRunIds,
    refreshActiveRuns: runs.refreshActiveRuns,
    attachRun: runs.attachRun,
    showMentionDropdown: composeur.showMentionDropdown,
    mentionQuery: composeur.mentionQuery,
    mentionFiles: composeur.mentionFiles,
    mentionIndex: composeur.mentionIndex,
    mentionRecentCount: composeur.mentionRecentCount,
    isMentionLoading: composeur.isMentionLoading,
    mentionHasMore: composeur.mentionHasMore,
    loadMoreMentionFiles: composeur.loadMoreMentionFiles,
    onMentionScroll: composeur.onMentionScroll,
    closeMentionDropdown: composeur.closeMentionDropdown,
    selectMention: composeur.selectMention,
    handleInputKeydown: composeur.handleInputKeydown,
    handleInputInput: composeur.handleInputInput,
    mentionIconClass: composeur.mentionIconClass,
    mentionFilenameOf: composeur.mentionFilenameOf,
    mentionDirOf: composeur.mentionDirOf,
    showSlash: composeur.showSlash,
    slashLevel: composeur.slashLevel,
    slashList: composeur.slashList,
    slashIdx: composeur.slashIdx,
    slashRaw: composeur.slashRaw,
    pinnedSkills: composeur.pinnedSkills,
    selectSlash: composeur.selectSlash,
    removePinnedSkill: composeur.removePinnedSkill,
    slashDismiss: composeur.slashDismiss,
    slashSetIdx: composeur.slashSetIdx,
    slashCmdOk: composeur.slashCmdOk,
    slashRowKey: composeur.slashRowKey,
    slashRowTitle: composeur.slashRowTitle,
    promptPreview: composeur.promptPreview,
    slashHeaderIcon: composeur.slashHeaderIcon,
    slashHeaderLabel: composeur.slashHeaderLabel,
    templatesAll: composeur.templatesAll,
    loadTemplates: composeur.loadTemplates,
    openTemplate: composeur.openTemplate,
    templateFill: composeur.templateFill,
    submitTemplateFill: composeur.submitTemplateFill,
    cancelTemplateFill: composeur.cancelTemplateFill,
    templateFillKeydown: composeur.templateFillKeydown,
    templateVarsLabel: composeur.templateVarsLabel,
    planMode: e.planMode,
    setPlanMode: outils.setPlanMode,
    askUserPanel: e.askUserPanel,
    askUserCurrent: questionnaire.askUserCurrent,
    isAskOptionOn: questionnaire.isAskOptionOn,
    toggleAskOption: questionnaire.toggleAskOption,
    askUserPrev: questionnaire.askUserPrev,
    askUserNext: questionnaire.askUserNext,
    dismissAskUser: questionnaire.dismissAskUser,
    submitAskUser: questionnaire.submitAskUser,
    startSkillAssistantChat: envoi.startSkillAssistantChat,
    launchSkillAssistantChat: envoi.launchSkillAssistantChat,
    skillAssistForm: e.skillAssistForm,
    startDocumentChat: envoi.startDocumentChat,
    renderMarkdown: renduChat.renderMarkdown,
    renderMarkdownHighlight: renduChat.renderMarkdownHighlight,
    handleMarkdownClick: renduChat.handleMarkdownClick,
    renderMarkdownLive: renduChat.renderMarkdownLive,
    loadChatsList: historique.loadChatsList,
    loadAvailableModels: modeles.loadAvailableModels,
    startNewChat: historique.startNewChat,
    loadChat: historique.loadChat,
    activeToolCats: outils.activeToolCats,
    applyChatTools: outils.applyChatTools,
    defaultToolKeys: outils.defaultToolKeys,
    excludedTools: e.excludedTools,
    openToolCats: e.openToolCats,
    isToolOn: outils.isToolOn,
    toggleTool: outils.toggleTool,
    setToolOn: outils.setToolOn,
    resetCatTools: outils.resetCatTools,
    catToolsCount: outils.catToolsCount,
    toggleToolCatOpen: outils.toggleToolCatOpen,
    toolInfo: e.toolInfo,
    openToolInfo: outils.openToolInfo,
    closeToolInfo: outils.closeToolInfo,
    loadLlmModel: modeles.loadLlmModel,
    unloadLlmModel: modeles.unloadLlmModel,
    toggleLlmModel: modeles.toggleLlmModel,
    isModelLoaded: modeles.isModelLoaded,
    isModelFailed: modeles.isModelFailed,
    kvColor: modeles.kvColor,
    kvTextClass: modeles.kvTextClass,
    kvDimClass: modeles.kvDimClass,
    kvBarClass: modeles.kvBarClass,
    archiveChat: historique.archiveChat,
    renameChat: historique.renameChat,
    deleteChat: historique.deleteChat,
    chatSelectMode: historique.chatSelectMode,
    chatSelected: historique.chatSelected,
    toggleChatSelectMode: historique.toggleChatSelectMode,
    toggleChatSelect: historique.toggleChatSelect,
    bulkArchiveChats: historique.bulkArchiveChats,
    bulkDeleteChats: historique.bulkDeleteChats,
    startEditMessage: edition.startEditMessage,
    cancelEditMessage: edition.cancelEditMessage,
    submitEditMessage: edition.submitEditMessage,
    stopGeneration: generation.stopGeneration,
    continueGeneration: generation.continueGeneration,
    respondNow: generation.respondNow,
    generateResponse: generation.generateResponse,
    retryGeneration: generation.retryGeneration,
    resumeAfterError: generation.resumeAfterError,
    handleStreamEvent: vueFlux.handleStreamEvent,
    sendMessage: envoi.sendMessage,
    copyAssistantMessage: envoi.copyAssistantMessage,
    getToolPillsFor: formats.getToolPillsFor,
    segGroupsFor: segments.segGroupsFor,
    pipelineFor: segments.pipelineFor,
    toggleToolDetail: segments.toggleToolDetail,
    liveGen: e.liveGen,
    fmtTokens: formats.fmtTokens,
    cancelTaskRun: segments.cancelTaskRun,
    taskModal: e.taskModal,
    taskModalStep: e.taskModalStep,
    openTaskModal: segments.openTaskModal,
    closeTaskModal: segments.closeTaskModal,
    taskModalRun: segments.taskModalRun,
    statusPhase: formats.statusPhase,
    statusDotClass: formats.statusDotClass,
    toolKeyArg: formats.toolKeyArg,
    fmtKvCache: formats.fmtKvCache,
    metricsTooltip: formats.metricsTooltip,
    thinkingTokensOf: formats.thinkingTokensOf,
    cachePctOf: formats.cachePctOf,
    cacheTitle: formats.cacheTitle,
    fmtThinkingTokens: formats.fmtThinkingTokens,
    fmtElapsed,
    fmtElapsedMs,
    fmtToolMs: formats.fmtToolMs,
    fmtThinkingMeta: formats.fmtThinkingMeta,
    editingChatTitle: e.editingChatTitle,
    chatTitleDraft: e.chatTitleDraft,
    startChatTitleEdit,
    commitChatTitleEdit,
    cancelChatTitleEdit,
    scrollToBottom: rendu.scrollToBottom,
    addCodeCopyButtons: renduChat.addCodeCopyButtons,
    autoResize: renduChat.autoResize,
    composerPlaceholder,
    exportChatAs: renduChat.exportChatAs,
    showExportFormatMenu: renduChat.showExportFormatMenu,
    triggerFileUpload: depot.triggerFileUpload,
    handleFileUpload: depot.handleFileUpload,
    removeAttachedFile: depot.removeAttachedFile,
    chatDragOver: depot.chatDragOver,
    handleChatDragEnter: depot.handleChatDragEnter,
    handleChatDragOver: depot.handleChatDragOver,
    handleChatDragLeave: depot.handleChatDragLeave,
    handleChatDrop: depot.handleChatDrop,
    connectSystemEvents: sse.connectSystemEvents,
    disconnectSystemEvents: sse.disconnectSystemEvents,
    resetOnLogout,
    webShotPrev: captures.webShotPrev,
    webShotNext: captures.webShotNext,
    webShotToggleExpand: captures.webShotToggleExpand,
    webShotGoto: captures.webShotGoto,
    voiceState: v.voiceState,
    voiceLevel: v.voiceLevel,
    voiceBusy: v.voiceBusy,
    voiceReading: v.voiceReading,
    voiceReadingIdx: v.voiceReadingIdx,
    voiceCanDictate: v.voiceCanDictate,
    voiceCanRead: v.voiceCanRead,
    toggleDictation: v.toggleDictation,
    cancelVoice: v.cancelVoice,
    voiceEscape: v.voiceEscape,
    speakMessage: v.speakMessage,
    stopSpeaking: v.stopSpeaking,
    setMsgUi: rendu.setMsgUi,
    imageVariants: envoi.imageVariants,
    runImageSlash: envoi.runImageSlash,
    imagePromptFor: envoi.imagePromptFor,
    imageRequestFor: envoi.imageRequestFor,
    diffCardState: carteFichiers.diffCardState,
    diffFilesFor: carteFichiers.diffFilesFor,
    hasDiffFiles: carteFichiers.hasDiffFiles,
    diffCardRev: carteFichiers.diffCardRev,
    isDiffEditorEnabled: carteFichiers.isDiffEditorEnabled,
    onDiffRowClick: carteFichiers.onDiffRowClick,
    downloadOneFile: carteFichiers.downloadOneFile,
    downloadAllFilesAsZip: carteFichiers.downloadAllFilesAsZip,
    memorySavesFor: cartesMemoire.memorySavesFor,
    effectLinesFor: cartesMemoire.effectLinesFor,
    effectIsOpen: cartesMemoire.effectIsOpen,
    effectDetail: cartesMemoire.effectDetail,
    toggleEffect: cartesMemoire.toggleEffect,
    undoMemoryEffect: cartesMemoire.undoMemoryEffect,
    manageMemory: cartesMemoire.manageMemory,
    effectUiRev: cartesMemoire.effectUiRev,
    toolStepsForDisplay: cartesMemoire.toolStepsForDisplay,
  };
}
