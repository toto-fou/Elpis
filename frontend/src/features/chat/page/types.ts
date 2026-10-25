// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/types.ts — domaines de la page de chat (en-tête, fil, composeur, modèles, images) lus et modifiés par ses composants. */
import type { SurfaceChat } from "../coeur/chat";
import type { PieceJointe } from "../composeur/composeur";
import type { CollectionActiveChat } from "../../rag/collections-chat";

export interface ReglagesPage {
  enable_model_selector?: boolean;
  enable_editor?: boolean;
  chat_width?: number;
}

export interface AccueilConfig {
  type?: string;
  image_b64?: string;
  icon?: string;
  width?: number;
  height?: number;
}

/** En-tête : titre éditable, mode plan, réglages de génération, menu de la conversation. */
export interface DomaineEntete {
  showSidebar: boolean;
  editingChatTitle: boolean;
  chatTitleDraft: string;
  readonly currentChatId: string | null;
  readonly currentChatTitle: string;
  readonly titleFlash: boolean;
  readonly planMode: boolean;
  readonly settings: ReglagesPage;
  readonly selectedModel: string;
  readonly selectedConnector: string | null;
  readonly activeModelIds: readonly string[];
  readonly showSamplingPanel: boolean;
  readonly features: { opencode?: boolean };
  showChatMenu: boolean;
  showExportFormatMenu: boolean;
  messageSearchActive: boolean;
  messageSearch: string;
  showOpenCodeModal: boolean;
  showInfoModal: boolean;
  commitChatTitleEdit(): unknown;
  cancelChatTitleEdit(): unknown;
  startChatTitleEdit(): unknown;
  togglePanel(nom: string): void;
  exportChatAs(format: string): unknown;
  openHelp(): void;
  loadChat(id: string): unknown;
  renameChat(id: string, titre: string): unknown;
  archiveChat(id: string): unknown;
  deleteChat(id: string): unknown;
}

/** Fil : conteneur de défilement, accueil, recherche dans la conversation, bouton « bas », dépôt de fichiers. */
export interface DomaineConversation {
  readonly chatDragOver: boolean;
  readonly messages: readonly unknown[];
  readonly showEditor: boolean;
  readonly settings: ReglagesPage;
  readonly mascotteVisible: boolean;
  readonly welcomeConfig: AccueilConfig | null;
  readonly user: { username?: string };
  messageSearchActive: boolean;
  messageSearch: string;
  readonly messageSearchQ: string;
  readonly messageSearchCount: number;
  readonly chatBottomPad: number;
  readonly chatAwayFromBottom: boolean;
  isUserScrolling: boolean;
  readonly scrollBtnBottom: number;
  scrollToBottom(force?: boolean): void;
  /** Saut fiable vers un message, même hors de la fenêtre rendue des longues conversations. */
  scrollToMessage(idx: number): void;
}

export interface EtatCompression {
  round: number;
  max: number;
  reason?: string;
}

export interface EtatFileAttente {
  kind: string;
  position: number;
  active: number;
  est_ms: number;
  pct: number | null;
}

export interface QuestionAssistant {
  q: string;
  options?: readonly string[];
  multi?: boolean;
  _free: string;
}

export interface Questionnaire {
  idx: number;
  items: readonly QuestionAssistant[];
}

export interface EntreeSlash {
  name?: string;
  label?: string;
  desc?: string;
  icon?: string;
  args?: readonly { label: string }[];
  value?: string;
  title?: string;
  shared?: boolean;
  domain?: string;
  description?: string;
  icone?: string;
  indice?: string;
}

export interface SkillEpingle {
  name: string;
  description?: string;
}

export interface PromptPartage {
  id: string | number;
  title: string;
  content: string;
  from_username?: string;
}

/** Composeur hors saisie : menus « / » et « + », collections RAG actives, partages, file d'attente, questionnaire, bandeaux, envoi. */
export interface DomaineComposeur {
  readonly settings: ReglagesPage;
  readonly liveGen: unknown;
  readonly compressionState: EtatCompression | null;
  readonly showSlash: boolean;
  readonly slashLevel: string;
  readonly slashList: readonly EntreeSlash[];
  readonly slashIdx: number;
  readonly slashRaw: { name?: string } | null;
  readonly slashHeaderIcon: string;
  readonly slashHeaderLabel: string;
  readonly slashHeaderCmd: string;
  selectSlash(item: EntreeSlash): unknown;
  slashSetIdx(i: number): void;
  slashRowKey(item: EntreeSlash, i: number): string;
  slashRowTitle(item: EntreeSlash): string;
  slashCmdOk(item: EntreeSlash): boolean;
  promptPreview(item: EntreeSlash): string;
  readonly isStreaming: boolean;
  readonly queueStatus: EtatFileAttente | null;
  stopGeneration(): void;
  readonly conversationTooLong: boolean;
  readonly ctxRealPct: number;
  startNewChat(): unknown;
  readonly askUserPanel: Questionnaire | null;
  readonly askUserCurrent: QuestionAssistant | null;
  dismissAskUser(): void;
  toggleAskOption(opt: string): void;
  isAskOptionOn(opt: string): boolean;
  askUserNext(): unknown;
  askUserPrev(): void;
  pinnedSkills: readonly SkillEpingle[];
  removePinnedSkill(nom: string): void;
  showComposerPlus: boolean;
  showSharedPrompts: boolean;
  sharedSelectMode: boolean;
  sharedSelected: (string | number)[];
  readonly inboxCount: number;
  readonly imageAvailable: boolean;
  readonly imageMode: boolean;
  /** Pastilles des collections RAG actives du chat ; la croix les retire. */
  readonly ragActives: readonly CollectionActiveChat[];
  retirerCollectionRag(id: string): unknown;
  readonly sharedPromptsList: readonly PromptPartage[];
  refreshInboxCount(): unknown;
  triggerFileUpload(): void;
  toggleImageMode(): void;
  loadSharedPrompts(): unknown;
  deleteSelectedSharedPrompts(): unknown;
  clearAllSharedPrompts(): unknown;
  toggleSharedSelect(id: string | number): void;
  useSharedPrompt(contenu: string): void;
  deleteSharedPrompt(id: string | number, e: MouseEvent, titre: string): unknown;
  readonly inputMessage: string;
  readonly attachedFiles: readonly PieceJointe[];
  readonly noEngineAllowed: boolean;
  sendMessage(): unknown;
  readonly currentChatId: string | null;
  readonly planMode: boolean;
  setPlanMode(on: boolean): unknown;
  manualCompress(): unknown;
  /** Catalogue du « + » : skills du compte par portée, prompts enregistrés, gabarits. */
  readonly skillsByScope: Readonly<Record<string, readonly SkillCatalogue[]>>;
  loadAllSkills(): unknown;
  readonly savedPromptsList: readonly PromptCatalogue[];
  loadSavedPrompts(): unknown;
  readonly templatesAll: readonly GabaritCatalogue[];
  loadTemplates(): unknown;
  openTemplate(gabarit: GabaritCatalogue): unknown;
}

export interface SkillCatalogue {
  name: string;
  description?: string;
  domain?: string;
}

export interface PromptCatalogue {
  id: string | number;
  title: string;
  content: string;
}

export interface GabaritCatalogue {
  name: string;
  title?: string;
  content: string;
}

export interface ChargeVisible {
  en_cours: number | null;
  en_attente: number | null;
  debit_tps: number | null;
  cache_prefixe_pct: number | null;
  ttft_s?: number | null;
  prefill_tps?: number | null;
}

export interface SanteMoteur {
  status?: string;
  server_reachable?: boolean;
  kv_cache?: { used: number; total: number; pct: number } | null;
  props?: { n_ctx?: number } | null;
  charge?: ChargeVisible | null;
}

/** Profil du moteur déclaré, décrit par le serveur. */
export interface MoteurVisible {
  type: string;
  libelle: string;
  chargement: boolean;
  file: boolean;
  contexte: boolean;
}

export interface ConnecteurLlm {
  id: string;
  label?: string;
  provider_type?: string;
  base_url?: string;
  scope?: string;
}

export interface EtatConnecteur {
  ok?: boolean;
  error?: string;
  router?: boolean;
  canManage?: boolean;
  moteur?: MoteurVisible | null;
  kv?: { used: number; total: number; pct: number } | null;
  nCtx?: number;
  charge?: ChargeVisible | null;
}

export interface StatsDirect {
  secLabel: string;
  tokPerSec: number | null;
  ctxLabel?: string;
  pct: number;
}

export interface OccupationContexte {
  used: number;
  total: number;
  pct: number;
  persisted?: boolean;
}

/** Modèles : sélecteur (intégré et connecteurs), chargement, effort de réflexion, statistiques du tour. */
export interface DomaineModeles {
  readonly imageMode: boolean;
  showModelManager: boolean;
  readonly selectedModel: string;
  readonly selectedModelLabel: string;
  readonly selectedConnector: string | null;
  readonly selectedEngineMeta: { label?: string; n_ctx?: number } | null;
  readonly builtinAllowed: boolean;
  readonly noEngineAllowed: boolean;
  readonly canManageModels: boolean;
  readonly moteurIntegre: MoteurVisible | null;
  /** Boutons charger et décharger du moteur intégré : droit de gérer ET moteur qui charge à la demande. */
  readonly chargementIntegre: boolean;
  readonly llmHealth: SanteMoteur | null;
  readonly availableModels: readonly string[];
  readonly modelsLoading: boolean;
  readonly modelsError: string;
  readonly isLoadingModel: string;
  readonly pickerConnectors: readonly ConnecteurLlm[];
  readonly pickerConnState: Readonly<Record<string, EtatConnecteur | undefined>>;
  readonly pickerConnModels: Readonly<Record<string, readonly string[] | undefined>>;
  readonly pickerConnFree: Readonly<Record<string, Readonly<Record<string, boolean>> | undefined>>;
  readonly pickerConnLoading: Readonly<Record<string, boolean | undefined>>;
  toggleModelMenu(): void;
  onModelMenuKeydown(e: KeyboardEvent): void;
  pickLocalModel(m: string): unknown;
  pickConnectorModel(conn: ConnecteurLlm, m: string): unknown;
  isModelFailed(m: string): boolean;
  isModelLoaded(m: string): boolean;
  isConnModelLoaded(connId: string, m: string): boolean;
  fetchModelProps(m: string, cle?: string): unknown;
  toggleLlmModel(m: string): unknown;
  toggleConnModel(conn: ConnecteurLlm, m: string): unknown;
  retryConnModels(connId: string): unknown;
  loadAvailableModels(): unknown;
  kvTextClass(pct: number): string;
  kvBarClass(pct: number): string;
  readonly modelLoadingId: string;
  readonly modelLoadPct: number | null;
  readonly modelLoadStage: string;
  readonly reasoningEffortValues: readonly string[];
  readonly samplingOverride: { reasoning_effort?: string | null };
  readonly showReasoningEffortMenu: boolean;
  toggleReasoningEffortMenu(): void;
  pickReasoningEffort(v: string | null): void;
  readonly liveGen: StatsDirect | null;
  readonly ctxUsage: OccupationContexte | null;
  fmtCtxUsage(u: OccupationContexte): string;
}

export interface OptionsImage {
  ratio: string;
  side: number;
  n: number;
  enhance: boolean;
  fixed: string;
  custom: boolean;
  cw: number;
  ch: number;
  seed: string | number;
  negative_prompt: string;
  steps: string | number;
  strength: number;
}

export interface ImageAModifier {
  url: string;
  thumb_url?: string;
}

/** Mode Images du composeur : options de la demande, image à modifier, galerie. */
export interface DomaineImage {
  readonly imageMode: boolean;
  readonly imageEditRef: ImageAModifier | null;
  readonly imageOpts: OptionsImage;
  readonly imagePop: string;
  readonly imageStatus: { enhance_enabled?: boolean; max_side?: number; step?: number } | null;
  readonly imageFeatures: { seed?: boolean; steps?: boolean; negative?: boolean; strength?: boolean };
  readonly imageFixedSizes: readonly string[];
  readonly imageSides: readonly number[];
  readonly imageBaseRatios: readonly string[];
  readonly imageMaxN: number;
  readonly imageSeedSet: boolean;
  readonly attachedFiles: readonly PieceJointe[];
  clearImageEditRef(): void;
  closeImageMode(): void;
  setImageFixed(v: string): void;
  toggleImagePop(nom: string): void;
  imageSize(): { w: number; h: number };
  ratioBox(r: string): Record<string, string>;
  imageFormatLabel(): string;
  imageBaseRatio(r: string): string;
  imageIsPortrait(r: string): boolean;
  imageFlipRatio(r: string): string;
  setImageRatio(r: string): void;
  flipImageRatio(): void;
  setImageSide(v: string): void;
  setImageN(v: string): void;
  imageSizeLabel(sz: string): string;
  toggleImageEnhance(): void;
  clearImageSeed(): void;
  openImageGallery(filtre: string): void;
  setImageCustom(v: boolean): void;
}

export interface ChatResume {
  id: string;
  title: string;
  _renamed?: boolean;
}

export interface GroupeChats {
  key: string;
  label: string;
  items: readonly ChatResume[];
}

export interface NotificationApp {
  id: string;
  kind: string;
  title: string;
  body?: string;
  created_at: string;
  read_at?: string | null;
}

export interface GroupeNotifications {
  label: string;
  items: readonly NotificationApp[];
}

/** Barre latérale : marque, menu des pages, recherche et historique des chats, notifications, compte. */
export type DomaineBarre = Pick<
  SurfaceChat,
  | "activeRunIds"
  | "bulkArchiveChats"
  | "bulkDeleteChats"
  | "chatSearch"
  | "chatSearchRef"
  | "chatSearchResults"
  | "chatSelectMode"
  | "chatSelected"
  | "closeChatSearch"
  | "isSearchingChats"
  | "loadChat"
  | "openChatSearch"
  | "renameChat"
  | "searchOpen"
  | "showMcpPanel"
  | "startNewChat"
  | "toggleChatSelect"
  | "toggleChatSelectMode"
  | "togglePanel"
> & {
  showSidebar: boolean;
  currentView: string;
  readonly currentChatId: string | null;
  readonly editorFullscreen: boolean;
  readonly showEditor: boolean;
  readonly features: { opencode?: boolean };
  readonly settings: {
    enable_mcp?: boolean;
    enable_editor?: boolean;
  };
  readonly skinCourant: { mascot?: string };
  readonly nomMarque: string;
  readonly logoApp: string;
  readonly user: { avatar?: string; username: string; is_admin?: boolean; role?: string };
  readonly groupedHistory: readonly GroupeChats[];
  notifDropdownRef: unknown;
  readonly notifications: readonly NotificationApp[];
  readonly groupedNotifications: readonly GroupeNotifications[];
  readonly notifUnread: number;
  readonly showNotifPanel: boolean;
  readonly notifLoading: boolean;
  readonly notifError: boolean;
  readonly notifHasMore: boolean;
  readonly notifNowTick: number;
  notifTimeAgo(ts: string, tick: number): string;
  notifIcon(kind: string): string;
  notifColor(kind: string): string;
  isNotifNew(n: NotificationApp): boolean;
  openNotifItem(n: NotificationApp): unknown;
  toggleNotifReadState(n: NotificationApp): unknown;
  deleteNotif(id: string): unknown;
  markAllNotifsRead(): unknown;
  clearNotifs(): unknown;
  loadNotifications(): unknown;
  loadMoreNotifs(): unknown;
  openNotifPanel(): unknown;
  toggleNotifPanel(): unknown;
  openContextMenu(e: Event, type: string, item: ChatResume): unknown;
  toggleEditor(): unknown;
  openRoutinesPage(): unknown;
  /** Sous-menu « Plus » du volet ouvert (RAG, Studio, Remote code). */
  menuPagesOuvert: boolean;
  /** Le compte a le droit RAG : l'entrée « RAG » du sous-menu « Plus » n'existe que pour lui. */
  readonly ragAllowed: boolean;
  openRagPage(): unknown;
  openStudio(): unknown;
  openCodePage(): unknown;
  openSettings(): unknown;
  goToAdmin(tab?: unknown): unknown;
  logout(): unknown;
  /** Menu du compte (interface nouvelle) : aide, informations, installation d'opencode. */
  openHelp(): void;
  showInfoModal: boolean;
  showOpenCodeModal: boolean;
};

/** Colonne du chat : dépôt de fichiers, composeur (saisie, mentions, micro, mode plan, tâches), perchoir de la mascotte. */
export type DomainePage = Pick<
  SurfaceChat,
  | "attachedFiles"
  | "chatContainer"
  | "composeColRef"
  | "composerPlaceholder"
  | "composerPlusRef"
  | "editMessageText"
  | "handleChatDragEnter"
  | "handleChatDragLeave"
  | "handleChatDragOver"
  | "handleChatDrop"
  | "handleFileUpload"
  | "handleInputInput"
  | "handleInputKeydown"
  | "imageMode"
  | "jobsChat"
  | "jobsTous"
  | "jobsPortee"
  | "jobsOuvert"
  | "jobsFileReveil"
  | "jobsReveilEnCours"
  | "jobsReveilDesactive"
  | "jobsLimites"
  | "jobsActifsChat"
  | "jobsActifsTotal"
  | "jobsBasculer"
  | "jobsChoisirPortee"
  | "jobsArreter"
  | "jobsToutArreter"
  | "jobsBasculerReveil"
  | "jobsOuvrirJournal"
  | "jobsOuvrirConversation"
  | "isMentionLoading"
  | "mentionFiles"
  | "mentionHasMore"
  | "mentionIndex"
  | "mentionQuery"
  | "mentionRecentCount"
  | "onMentionScroll"
  | "planMode"
  | "removeAttachedFile"
  | "selectMention"
  | "setPlanMode"
  | "showMentionDropdown"
  | "todoList"
  | "todoPanelOpen"
  | "toggleDictation"
  | "voiceBusy"
  | "voiceCanDictate"
  | "voiceState"
> & {
  readonly currentChatId: string | null;
  readonly messages: readonly unknown[];
  readonly isStreaming: boolean;
  inputMessage: string;
  inputRef: unknown;
  fileInput: unknown;
  accueilHote: unknown;
  imgZoom: string | null;
  readonly showEditor: boolean;
  readonly settings: { enable_editor?: boolean; chat_width?: number };
  readonly perchee: boolean;
  readonly percheX: string;
  readonly percheDuree: string;
  readonly percheAnim: string;
  readonly percheDort: boolean;
  readonly mascotteId: string;
  showToast(
    message: string,
    type?: string,
    opts?: { duration?: number; actionLabel?: string; onAction?: () => void },
  ): unknown;
  /** Ouvre le déroulé d'un sous-agent (entrée de message et rang de l'exécution). */
  openTaskModal(entree: { idx?: number; msg: unknown }, ri: number): void;
};
