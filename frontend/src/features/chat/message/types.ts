// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/types.ts — message affiché et adaptateur de données et d'actions des composants Message (l'app historique pendant la coexistence). */
import type { ResumeReveil, SourceCiteeRag } from "@elpis/contracts";
import type { MessageMarkdown } from "../../../components/chat/ContenuMarkdown.vue";
import type { MessageNarration } from "../../../components/chat/NarrationVivante.vue";
import type {
  EtapeOutil,
  ExecutionSousAgent,
  GroupeSegment,
  MessageOutils,
  PatchUiMessage,
} from "../outils/types";
import type { ProgressionImage } from "../../images/formats";
import type { ImageAffichee } from "../../images/partage";

export interface MetriquesMessage {
  model?: string;
  duration?: number;
  read_tps?: number | string;
  write_tps?: number | string;
  output_tokens?: number;
  thinking_tokens_estimated?: boolean;
  kv_cache?: { used: number; total: number; pct: number } | null;
}

export interface CaptureWeb {
  tool?: string;
  blobUrl?: string | null;
  /** Adresse de la capture sur le serveur (relue au rechargement, peut avoir expiré). */
  serverUrl?: string;
  pending?: boolean;
}

export interface FichierJoint {
  name: string;
  lines?: number;
}

export interface ImageJointe {
  dataUrl: string;
  name?: string;
}

export interface DemandeImage {
  ref_image_id?: string | null;
  size?: string;
  n?: number;
}

export interface StatsBoucle {
  iterations?: number;
  max_iterations?: number;
  tool_calls_done?: number;
}

export interface MessageAffiche extends MessageMarkdown, MessageNarration, MessageOutils {
  role: string;
  /** « job_wake » : message remis par une tâche de fond, affiché en ligne de réveil. */
  origin?: string | null;
  wake?: ResumeReveil | null;
  content?: string | null;
  isError?: boolean;
  /** Genre d'une notice du fil : « compaction » (défaut) ou « rag_search » (`/rag search`). */
  kind?: string;
  errorMessage?: string | null;
  errorDetail?: string | null;
  errorKind?: string | null;
  isTruncated?: boolean;
  toolLoopTruncated?: boolean;
  toolLoopStats?: StatsBoucle | null;
  iterBudget?: { n: number; max: number } | null;
  pruned?: number;
  thinking?: string | null;
  thinkingOpen?: boolean;
  thinkingTruncated?: boolean;
  _pipelineOpen?: boolean;
  summary?: string | null;
  tokens_after?: number | null;
  ts?: string | number | null;
  metrics?: MetriquesMessage | null;
  webScreenshots?: readonly CaptureWeb[] | null;
  webScreenshotIdx?: number | null;
  webScreenshotExpanded?: boolean;
  taskRuns?: readonly ExecutionSousAgent[] | null;
  images?: readonly ImageJointe[] | null;
  files?: readonly (string | FichierJoint)[] | null;
  image_request?: DemandeImage | null;
  generated_images?: readonly ImageAffichee[] | null;
  revised_prompt?: string | null;
  image_meta?: unknown;
  image_error?: unknown;
  _imageProgress?: ProgressionImage | null;
  _imageErrorLive?: boolean;
  _toolImageProgress?: ProgressionImage | null;
  tool_images?: readonly ImageAffichee[] | null;
  tool_history?: readonly unknown[] | null;
  run_ids?: readonly string[] | null;
  _journalTruncated?: boolean;
  /** Documents des sources RAG du tour en cours (ligne « Sources » pendant le flux). */
  _ragSources?: readonly string[] | null;
  /** Sources structurées du message (passages numérotés `[n]` par les outils `rag_*`), enregistrées avec lui. */
  rag_sources?: readonly SourceCiteeRag[] | null;
  toolSteps?: readonly EtapeOutil[] | null;
  /** Narrations des segments du tour (texte écrit entre deux outils), dans l'ordre. */
  segTexts?: readonly string[] | null;
  /** Lignes dépliées du fil chronologique (réflexions, groupes d'étapes), par clé de bloc. */
  _filOuverts?: Readonly<Record<string, boolean>> | null;
  _thinkingMs?: number;
  _thinkingStartedAt?: number;
  _thinkingEndedAt?: number;
}

export interface EntreeMessage {
  idx: number;
  msg: MessageAffiche;
  /** Réveils et réponses qui continuent la bulle de ce message de l'agent (regroupement d'affichage). */
  suite?: readonly EntreeMessage[];
}

export interface ReglagesAffichage {
  hide_thinking?: boolean;
  assistant_name?: string;
  live_shell_enabled?: boolean;
  skin?: string;
  enable_editor?: boolean;
}

export type Pipeline =
  | { show: false }
  | { show: true; nTools: number; nComp: number; running: boolean; label: string; summary: string };

export interface PhaseStatut {
  kind: string;
  label: string;
}

export interface LigneEffet {
  key: string;
  kind: string;
  label: string;
  storeLabel?: string;
  title?: string;
  running?: boolean;
  error?: boolean;
  full?: boolean;
  op?: string | null;
  content?: string;
  target?: string;
  message?: string;
}

export interface DetailEffet {
  state: string;
  error?: string;
  undoing?: boolean;
  data?: {
    undone?: boolean;
    action?: string;
    n_before?: number;
    n_after?: number;
    removed?: readonly string[];
    added?: readonly string[];
    can_undo?: boolean;
  } | null;
}

export interface LigneDiff {
  t: string;
  text: string;
}

export interface FichierModifie {
  path: string;
  name: string;
  dir: string;
  change?: string;
  from?: string;
  loading?: boolean;
  error?: string | null;
  computed?: boolean;
  noStats?: boolean;
  additions: number;
  deletions: number;
  open?: boolean;
  lines?: readonly LigneDiff[] | null;
  truncated?: boolean;
}

export interface ImageVisionneuse {
  id: string;
  url: string;
}

/** Ce que les composants Message lisent et appellent sur l'app historique (sa racine, `$root`). */
export interface ContexteMessage {
  readonly settings: ReglagesAffichage;
  readonly user: { username?: string; avatar?: string | null };
  readonly skinCourant: { brand?: unknown };
  readonly nomMarque: string;
  /** Avatar de l'assistant : logo de l'application (console), sinon celui d'Elpis. */
  readonly logoApp: string;
  readonly lastAssistantIdx: number;
  readonly isStreaming: boolean;
  readonly editingMessageIndex: number | null;
  readonly editMessageText: string;
  readonly messageSearchQ: string;
  readonly messageSearchActive: boolean;
  readonly compressionStatus: unknown;
  readonly voiceReadingIdx: number | null;
  readonly voiceCanRead: boolean;
  /** Ligne mise en évidence après un saut (plan, recherche), posée par le fenêtrage. */
  readonly vsFlashIdx?: number | null;
  setMsgUi(entry: EntreeMessage, patch: PatchUiMessage): void;
  handleMarkdownClick(e: MouseEvent): void;
  showToast(message: string, type?: string): void;
  startEditMessage(idx: number): void;
  submitEditMessage(idx: number): unknown;
  cancelEditMessage(): void;
  saveThisPrompt(content: string | null | undefined): unknown;
  fmtNoticeTs(ts: string | number): string;
  fmtThinkingMeta(msg: MessageAffiche): string;
  respondNow(idx: number): unknown;
  pipelineFor(msg: MessageAffiche): Pipeline;
  segGroupsFor(msg: MessageAffiche): readonly GroupeSegment[];
  toggleToolDetail(entry: EntreeMessage, flat: number, gi: number): void;
  webShotToggleExpand(msg: MessageAffiche): void;
  webShotPrev(msg: MessageAffiche): void;
  webShotNext(msg: MessageAffiche): void;
  webShotGoto(msg: MessageAffiche, i: number): void;
  openTaskModal(entry: EntreeMessage, index: number): void;
  cancelTaskRun(run: ExecutionSousAgent): unknown;
  effectLinesFor(msg: MessageAffiche, idx: number): readonly LigneEffet[];
  effectIsOpen(line: LigneEffet): boolean;
  effectDetail(line: LigneEffet): DetailEffet | null;
  toggleEffect(line: LigneEffet): void;
  undoMemoryEffect(line: LigneEffet): unknown;
  manageMemory(): void;
  statusPhase(msg: MessageAffiche): PhaseStatut | null;
  statusDotClass(kind: string): string;
  isImageMessage(msg: MessageAffiche): boolean;
  imagePromptFor(idx: number): string;
  imageVariants(idx: number): unknown;
  imageReqDims(req: DemandeImage | null): { w: number; h: number; n: number };
  imageRequestFor(idx: number): DemandeImage | null;
  imageRequestLabel(req: DemandeImage): string;
  openImageViewer(
    items: readonly ImageVisionneuse[],
    idx: number,
    info: Readonly<Record<string, unknown>>,
  ): void;
  stopGeneration(): void;
  retryGeneration(idx: number): unknown;
  continueGeneration(): unknown;
  resumeAfterError(idx: number): unknown;
  isDiffEditorEnabled(): boolean;
  hasDiffFiles(msg: MessageAffiche): boolean;
  diffFilesFor(msg: MessageAffiche, idx: number): readonly FichierModifie[];
  onDiffRowClick(idx: number, file: FichierModifie): unknown;
  downloadOneFile(path: string): void;
  downloadAllFilesAsZip(paths: readonly string[], nom: string): unknown;
  metricsTooltip(m: MetriquesMessage): string;
  fmtElapsed(sec: number): string;
  thinkingTokensOf(m: MetriquesMessage): number;
  fmtThinkingTokens(m: MetriquesMessage): string;
  cachePctOf(m: MetriquesMessage): number;
  cacheTitle(m: MetriquesMessage): string;
  kvDimClass(pct: number): string;
  fmtKvCache(m: MetriquesMessage): string;
  copyAssistantMessage(content: string | null | undefined): unknown;
  openRunDetails(msg: MessageAffiche): void;
  speakMessage(idx: number, texte: string | null | undefined): void;
  toolLimitLabel(stats: StatsBoucle | null | undefined): string;
}

export interface NoticeCompaction {
  chatId: string | null;
  state: string;
  pct?: number;
  reason?: string;
}

/** Ce que la liste lit en plus sur l'app historique : fenêtre virtuelle, révisions des états hors message, statut du tour. */
export interface ContexteListe extends ContexteMessage {
  readonly visibleMessages: readonly EntreeMessage[];
  readonly vsTopPad: number;
  readonly vsBotPad: number;
  readonly effectUiRev: number;
  readonly diffCardRev: number;
  readonly isThinking: boolean;
  readonly statusText: string;
  readonly compactionNotice: NoticeCompaction | null;
  readonly currentChatId: string | null;
}
