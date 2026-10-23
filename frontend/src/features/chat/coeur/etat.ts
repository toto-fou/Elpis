// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/etat.ts — état du cœur du chat : refs lues par les gabarits (conversation, tour, outils, modèles, panneaux) et état interne du flux (tampons, minuteries, jetons de génération). */
import { computed, ref, shallowRef, watch } from "vue";
import type { Ref } from "vue";

import type { MetaMoteur, SanteLlm } from "../modeles/modeles.ts";
import type { MessageChat, Objet, ResumeConversation } from "./types.ts";
import type { TacheSession } from "../outils/types.ts";

export interface FileAttente {
  kind: string;
  model: string;
  loaded: unknown;
  position: number;
  active: number;
  est_ms: number;
  pct: number | null;
  stage: string;
  stages: unknown[];
  started_at: number;
}

export interface StatutCompressionFlux {
  path: string;
  external: boolean;
  model: string;
  turns: number;
  tokens: number;
  ctx_size: number;
  pct: number;
  est_ms: number;
  started_at: number;
  msg_idx: number;
}

export interface NoticeCompactage {
  state: string;
  chatId: string;
  pct?: number;
  reason?: string;
}

export interface Occupation {
  used: number;
  total: number;
  pct: number;
  persisted?: boolean;
}

export interface LigneDirect {
  model: string;
  sec: number;
  secLabel: string;
  tokPerSec: number | null;
  ctxLabel: string;
  pct: number;
}

export interface QuestionAsk {
  q: string;
  options: string[];
  multi: boolean;
  _sel: string[];
  _free: string;
}

export interface PanneauAsk {
  items: QuestionAsk[];
  idx: number;
}

export interface CategorieMcp {
  name: string;
  label?: string;
  color?: string;
  default_on?: boolean;
  tools?: { name: string; [cle: string]: unknown }[];
  [cle: string]: unknown;
}

export interface ServeurManifeste {
  name: string;
  default_on?: boolean;
  [cle: string]: unknown;
}

export interface FormulaireSkill {
  open: boolean;
  sujet: string;
  objectif: string;
  domaine: string;
  scripts: string;
}

export interface ModaleTache {
  idx: number;
  ri: number;
  cid: string | null;
  snap: unknown;
}

/** Refs du cœur du chat, exposées telles quelles à la racine. */
export function creerEtatChat() {
  const composeColRef = ref<HTMLElement | null>(null);
  const composerHeight = ref(0);
  let observateur: ResizeObserver | null = null;
  // Hauteur réelle de la colonne du composeur : la fin du fil et le bouton « bas » s'y calent.
  watch(composeColRef, (el) => {
    if (observateur) {
      observateur.disconnect();
      observateur = null;
    }
    if (!el) {
      composerHeight.value = 0;
      return;
    }
    if (typeof ResizeObserver !== "undefined") {
      observateur = new ResizeObserver(() => {
        composerHeight.value = el.offsetHeight || 0;
      });
      observateur.observe(el);
    }
    composerHeight.value = el.offsetHeight || 0;
  });
  const ctxRealPct = ref(0);
  return {
    chats: ref<ResumeConversation[]>([]),
    currentChatTitle: ref(""),
    titleFlash: ref(false),
    chatContainer: ref<HTMLElement | null>(null),
    isThinking: ref(false),
    statusText: ref(""),
    queueStatus: ref<FileAttente | null>(null),
    todoList: ref<TacheSession[]>([]),
    todoPanelOpen: ref(false),
    composeColRef,
    composerHeight,
    chatBottomPad: computed(() => Math.max(128, (composerHeight.value || 0) + 40)),
    scrollBtnBottom: computed(() => Math.max(144, (composerHeight.value || 0) + 36)),
    compressionStatus: ref<StatutCompressionFlux | null>(null),
    compressionProgress: ref(0),
    compressionCapped: ref<{ round: number; max: number } | null>(null),
    compressionState: ref<Objet | null>(null),
    manualCompressBusy: ref(false),
    compactionNotice: ref<NoticeCompactage | null>(null),
    manualCompressChatId: ref<string | null>(null),
    abortController: shallowRef<AbortController | null>(null),
    pendingWrite: ref<{ path: string } | null>(null),
    ctxRealPct,
    conversationTooLong: computed(() => ctxRealPct.value >= 90),
    ctxUsage: ref<Occupation | null>(null),
    showChatMenu: ref(false),
    attachedFiles: ref<{ name: string; content?: string; isImage?: boolean; mimeType?: string }[]>([]),
    localTools: ref<Record<string, boolean>>({}),
    mcpUserCategories: ref<CategorieMcp[]>([]),
    showMcpPanel: ref(false),
    manifestServers: ref<ServeurManifeste[]>([]),
    manifestTools: ref<Record<string, boolean>>({}),
    excludedTools: ref<Record<string, boolean>>({}),
    openToolCats: ref<Record<string, boolean>>({}),
    planMode: ref(false),
    showComposerPlus: ref(false),
    composerPlusRef: ref<HTMLElement | null>(null),
    availableModels: ref<string[]>([]),
    activeModelIds: ref<string[]>([]),
    selectedModel: ref(""),
    selectedConnector: ref<string | number | null>(""),
    selectedEngineMeta: ref<MetaMoteur | Record<string, unknown> | null>({
      key: "builtin",
      llamacpp: true,
      label: "",
      loaded: [],
      n_ctx: 0,
    }),
    llmHealth: ref<SanteLlm | null>(null),
    liveGen: ref<LigneDirect | null>(null),
    isLoadingModel: ref<string | boolean>(false),
    showModelManager: ref(false),
    showModelProps: ref(false),
    modelPropsData: ref<unknown>(null),
    modelPropsLoading: ref(false),
    taskModal: ref<ModaleTache | null>(null),
    taskModalStep: ref<number | null>(null),
    activeRunIds: ref<string[]>([]),
    followedRunChatId: ref<string | null>(null),
    askUserPanel: ref<PanneauAsk | null>(null),
    toolInfo: ref<Objet | null>(null),
    skillAssistForm: ref<FormulaireSkill>({ open: false, sujet: "", objectif: "", domaine: "", scripts: "" }),
    editingChatTitle: ref(false),
    chatTitleDraft: ref(""),
  };
}

export type EtatChat = ReturnType<typeof creerEtatChat>;

export interface CompteurDirect {
  base: number;
  gen: number;
  /** Jetons générés depuis la dernière occupation réelle (`base`) : réflexion et réponse encore dans le cache du moteur. */
  enCours: number;
  total: number;
}

/** Run lu en ce moment (envoi ou rattachement). */
export interface RunLu {
  gen: number;
  chatId: string | null;
  posted: boolean;
  detached: boolean;
  attached?: boolean;
  stopped?: boolean;
}

export type Minuterie = ReturnType<typeof setTimeout>;

/** État interne du flux (hors réactivité) : tampons, minuteries, garde de génération. */
export interface EtatFlux {
  streamBuf: string;
  thinkBuf: string;
  preContentBuf: string;
  streamFlushTimer: Minuterie | null;
  thinkFlushTimer: ReturnType<typeof setInterval> | null;
  preContentFlushTimer: ReturnType<typeof setInterval> | null;
  toolsExecutedThisTurn: boolean;
  streamToolPhase: boolean;
  ctxLive: CompteurDirect | null;
  inThinkPhase: boolean;
  lastCtxUsed: number;
  genStartMs: number;
  genTicker: ReturnType<typeof setInterval> | null;
  scrollPending: boolean;
  lastContentFlushTs: number;
  liveRenderTs: { _md: number; _pp: number };
  liveRenderDirty: { _md: boolean; _pp: boolean };
  streamingForChatId: string | null;
  currentRun: RunLu | null;
  replaying: boolean;
  activeGen: number;
  pendingReattach: string | null;
  pendingAskUser: QuestionAsk[] | null;
  composeRestoreDraft: string | null;
  todoTouchedThisTurn: boolean;
  shellPend: Map<string, { chunk: string; seq: number }>;
  shellFlushTimer: Minuterie | null;
}

export function creerEtatFlux(): EtatFlux {
  return {
    streamBuf: "",
    thinkBuf: "",
    preContentBuf: "",
    streamFlushTimer: null,
    thinkFlushTimer: null,
    preContentFlushTimer: null,
    toolsExecutedThisTurn: false,
    streamToolPhase: false,
    ctxLive: null,
    inThinkPhase: false,
    lastCtxUsed: 0,
    genStartMs: 0,
    genTicker: null,
    scrollPending: false,
    lastContentFlushTs: 0,
    liveRenderTs: { _md: 0, _pp: 0 },
    liveRenderDirty: { _md: false, _pp: false },
    streamingForChatId: null,
    currentRun: null,
    replaying: false,
    activeGen: 0,
    pendingReattach: null,
    pendingAskUser: null,
    composeRestoreDraft: null,
    todoTouchedThisTurn: false,
    shellPend: new Map(),
    shellFlushTimer: null,
  };
}

export type MessagesRef = Ref<MessageChat[]>;
