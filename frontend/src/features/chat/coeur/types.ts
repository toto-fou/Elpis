// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/types.ts — formes du cœur du chat : message et étape d'outil mutables, événement de flux appliqué à la vue, refs et contexte fournis par la racine (app.js). */
import type { BilanTache, ResumeReveil } from "@elpis/contracts";
import type { Ref } from "vue";

import type { FetchAuth } from "../flux/aides.ts";

export type Objet = Record<string, unknown>;

export interface JournalOutil {
  level: string;
  message: string;
  logger: string;
  at: number;
}

/** Étape d'outil d'un message (posée au `tool_call`, complétée au fil des événements). */
export interface EtapeChat {
  name: string;
  status?: string;
  args?: Objet | null;
  result?: unknown;
  callId?: string | null;
  seg?: number;
  round?: number;
  _kind?: string;
  _is_error?: boolean;
  thinking?: string;
  thinkingOpen?: boolean;
  isRag?: boolean;
  ragLabel?: string;
  ragResultLabel?: string;
  durationMs?: number;
  progress?: number;
  progressInfo?: { value: number; total: number | null; pct: number | null; message: string; at: number };
  logs?: JournalOutil[];
  shellOut?: string | null;
  shellSeq?: number;
  shellDone?: boolean;
  shellRc?: number | null;
  shellMs?: number;
  shellLiveTruncated?: boolean;
  stats?: Objet | null;
  reasonLabel?: string;
  [cle: string]: unknown;
}

export interface OutilSousAgent {
  tool: string;
  args_preview: string;
  status: string;
  result_preview?: string;
}

/** Entrée du déroulé d'un sous-agent : narration (`text`) ou étape d'outil. */
export interface EntreeDeroule {
  text?: string;
  tool?: string;
  args_preview?: string;
  status?: string;
  result_preview?: string;
}

/** Exécution d'un sous-agent (outil `task`), carte persistante du message. */
export interface ExecutionTache {
  id: string | null;
  /** Appel `task` du message : les étapes du sous-agent s'y rattachent. */
  callId?: string | null;
  agent?: string;
  label?: string;
  prompt?: string;
  state: string;
  tokens?: number;
  depth?: number;
  steps_total?: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  tools?: OutilSousAgent[];
  transcript?: EntreeDeroule[];
  progress?: { step: number; max_steps: number } | null;
  result?: string;
  cancelRequested?: boolean;
  cancelSent?: boolean;
  /** Bloc du harnais (`harness` de l'étape finale), validé à la réception. */
  harness?: BilanTache;
  [cle: string]: unknown;
}

export interface CaptureChat {
  blobUrl?: string | null;
  serverUrl?: string;
  tool?: string;
  stepIdx?: number;
  step?: number;
  sid?: string | null;
  ts?: number;
  args?: unknown;
  pending?: boolean;
  [cle: string]: unknown;
}

export interface BlocRendu {
  i: number;
  html: string;
}

/** Message de la conversation : champs persistés et champs d'affichage du flux (`_md*`, `_pp*`, statut). */
export interface MessageChat {
  role: string;
  origin?: string | null;
  wake?: ResumeReveil | null;
  content?: string;
  displayContent?: string;
  thinking?: string;
  thinkingOpen?: boolean;
  thinkingTruncated?: boolean;
  resume_thinking?: string;
  isStreaming?: boolean;
  isError?: boolean;
  errorMessage?: string;
  isTruncated?: boolean;
  toolLoopTruncated?: boolean;
  toolLoopStats?: Objet | null;
  iterBudget?: { n: number; max: number } | null;
  toolSteps?: EtapeChat[];
  segTexts?: string[];
  taskRuns?: ExecutionTache[];
  webScreenshots?: CaptureChat[];
  webScreenshotIdx?: number | null;
  webScreenshotExpanded?: boolean;
  images?: { dataUrl: string; name?: string; mimeType?: string }[];
  files?: unknown[];
  image_request?: Objet | null;
  tool_history?: unknown[] | null;
  tool_history_delta?: boolean;
  metrics?: Objet | null;
  run_ids?: unknown[] | null;
  files_changed?: unknown[] | null;
  compactions?: unknown[] | null;
  pruned?: number;
  kind?: string;
  ts?: number | null;
  round?: number | null;
  tokens_after?: number | null;
  summary?: string | null;
  _statusLine?: string;
  _pendingPreContent?: string;
  _mdBlocks?: BlocRendu[] | null;
  _ppBlocks?: BlocRendu[] | null;
  _prefillPct?: number;
  _prefillCachePct?: number;
  _thinkingStartedAt?: number;
  _thinkingEndedAt?: number;
  _lastToolResultAt?: number | null;
  _modelLoad?: Objet | null;
  _imageTurn?: boolean;
  _followBubble?: boolean;
  _respondNowPrefill?: string;
  [cle: string]: unknown;
}

/** Événement de flux décodé par `SuiviFlux` (valide, ou hors contrat signalé et passé à la vue). */
export interface DonneesFlux {
  type: string;
  chat_id?: string;
  text?: string;
  n?: number;
  name?: string;
  call_id?: string;
  args?: Objet | null;
  result?: string;
  iter?: number;
  index?: number;
  name_delta?: string;
  args_delta?: string;
  reset?: boolean;
  [cle: string]: unknown;
}

export interface ResumeConversation {
  id: string;
  title: string;
  _renamed?: boolean;
  [cle: string]: unknown;
}

export interface Utilisateur {
  username?: string;
  display_name?: string;
  role?: string;
  [cle: string]: unknown;
}

export interface ReglagesChat {
  sandbox_path_display?: string | null;
  enable_editor?: boolean;
  enable_mcp?: boolean;
  live_shell_enabled?: boolean;
  mcp_servers?: { id?: unknown; visible?: boolean; [cle: string]: unknown }[];
  assistant_name?: string;
  [cle: string]: unknown;
}

export interface ConfigChat {
  active_mcp_ids: string[];
  use_rag?: boolean;
  rag_collection?: string;
  rag_search_mode?: string;
  rag_top_k?: number;
  rag_use_mmr?: boolean;
  [cle: string]: unknown;
}

/** Refs partagées fournies par la racine historique (app.js). */
export interface RefsRacineChat {
  user: Ref<Utilisateur | null>;
  settings: Ref<ReglagesChat>;
  config: Ref<ConfigChat>;
  messages: Ref<MessageChat[]>;
  currentChatId: Ref<string | null>;
  inputMessage: Ref<string>;
  inputRef: Ref<HTMLTextAreaElement | null>;
  isStreaming: Ref<boolean>;
  currentView: Ref<string>;
  isAdminView?: Ref<boolean>;
  isUserScrolling: Ref<boolean>;
  showSidebar?: Ref<boolean>;
  features?: Ref<Record<string, unknown> | null>;
}

export interface OptionsToast {
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
}

export interface FinEcriture {
  success: boolean;
  finalContent?: string | null;
  disk?: unknown;
}

export interface ModeleEditeur {
  isDisposed(): boolean;
}

/** Contexte de la racine (app.js) : utilitaires et proxies paresseux vers les autres modules. */
export interface CtxChat {
  showToast(message: string, type?: string, options?: OptionsToast): void;
  fetchAuth: FetchAuth;
  openConfirm(
    titre: string,
    texte: string,
    danger?: boolean,
    ok?: string,
    annuler?: string,
  ): Promise<boolean>;
  openPrompt(titre: string, valeur?: string, indice?: string): Promise<string | null | undefined>;
  readonly showSidebar?: Ref<boolean>;
  readonly autoResize?: () => void;
  readonly announce?: (message: string) => void;
  readonly pinnedServers?: Ref<{ id?: unknown; name?: string; type?: string; shared?: boolean }[]>;
  readonly models?: Record<string, ModeleEditeur | undefined> | null;
  _lockAutoScroll?: () => void;
  checkAuth?: () => Promise<unknown>;
  clearSavedSession?: () => void;
  loadChatsList?: () => unknown;
  notifyChatDone?: (id: string, titre: string) => void;
  refreshNotifBadge?: () => void;
  onNotificationEvent?: (data: unknown) => void;
  onAnnotationFrame?: (data: unknown) => void;
  openSettingsTab?: (onglet: string) => unknown;
  openHelp?: (doc?: string) => unknown;
  closeSettings?: (sansConfirmer?: boolean) => unknown;
  loadSettingsData?: () => unknown;
  checkExternalModsSoon?: (delai?: number) => void;
  loadSandboxFiles?: () => unknown;
  isStreamActive?: (chemin: string) => boolean;
  streamOpenForWrite?: (
    chemin: string,
    o: { append: boolean; preloadContent: string | null },
  ) => Promise<boolean>;
  streamLocateEdit?: (chemin: string, o: Objet) => Promise<boolean>;
  streamWriteChunk?: (chemin: string, morceau: string) => void;
  streamFinalize?: (chemin: string, o: FinEcriture) => Promise<unknown> | unknown;
  getStreamPreSnapshot?: (chemin: string) => string | null;
  capturePreWrite?: (chemin: string) => string | null;
  updateEditor?: (chemin: string, contenu: string, disque?: unknown) => Promise<unknown>;
  editorIsViewerPath?: (chemin: string) => boolean;
  editorRefreshViewer?: (chemin: string) => Promise<unknown>;
  [cle: string]: unknown;
}
