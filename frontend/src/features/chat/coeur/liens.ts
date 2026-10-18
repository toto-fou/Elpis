// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/liens.ts — liaisons entre les parties du cœur du chat : état partagé et table des fonctions croisées, remplie par `setupChat` et résolue à l'appel. */
import type { MoteurMarkdown } from "../rendu/markdown.ts";
import type { EtatChat, EtatFlux, QuestionAsk } from "./etat.ts";
import type { CtxChat, DonneesFlux, MessageChat, Objet, RefsRacineChat } from "./types.ts";

/** Crochets de la voix (module de la session FONCTIONS), appelés par le flux. */
export interface CrochetsVoix {
  onAssistantStart(continuation: boolean): void;
  onAssistantStream(texte: string): void;
  onAssistantToolStream(texte: string): void;
  onAssistantFinal(texte: string, coupe: boolean): void;
  stopDictation(): void;
  cancelVoice(): void;
}

export interface EntreeAffichee {
  idx?: number;
  msg: MessageChat;
}

export interface StatutGeneration {
  generation_running?: boolean;
  resumable?: boolean;
  run_id?: string;
  base_count?: number;
  is_continue?: boolean;
  user_message?: string;
  image_request?: Objet | null;
}

/** Fonctions d'une partie appelées par une autre (résolues à l'appel). */
export interface LiensChat {
  getStreamMsgs(): MessageChat[];
  streamIdx(msgs: readonly MessageChat[]): number;
  patch(idx: number, patch: Objet): void;
  setMsgUi(entry: EntreeAffichee | null | undefined, patch: Objet): void;
  scrollToBottom(force?: boolean): void;
  scheduleStreamScroll(): void;
  vsEnsureTail(): void;
  stopThinkFlush(): void;
  stopPreContentFlush(): void;
  flushPreContentBuf(force?: boolean): void;
  flushThinkBuf(): void;
  stopStreamFlush(): void;
  armStreamFlush(): void;
  applyPreRender(cur: MessageChat, texte: string): Objet;
  flushShellPend(): void;
  armerShell(): void;
  shellFoldPend(st: { shellOut?: string | null }, pend: { chunk: string }): string;
  seedLiveCtx(): void;
  clearLiveCtx(): void;
  getCtxSize(): number;
  ctxGaugeApplicable(): boolean;
  markRunActive(chatId: unknown): void;
  markRunDone(chatId: unknown): void;
  stopFollowRun(): void;
  followRun(chatId: unknown, opts?: { silent?: boolean }): void;
  setFollowBubble(on: boolean): void;
  reattachOrFollow(chatId: string): Promise<void>;
  handleStreamEvent(data: DonneesFlux): Promise<void>;
  doGenerate(continuation: boolean): Promise<void>;
  generateResponse(): Promise<void>;
  sendMessage(): Promise<void>;
  stopGeneration(): void;
  closeToolStreamsFor(chatId: string | null): void;
  purgeToolStreams(chatId: string): void;
  clearToolStreams(): void;
  cancelAllToolStreams(): void;
  finalizeAllToolStreams(chatId?: string): Promise<void>;
  handleToolCallDelta(data: DonneesFlux, chatId: string, sansOuverture: boolean): Promise<void>;
  finalizeToolStream(
    data: DonneesFlux,
    chatId: string,
    o: { resultStr?: unknown; finalContent: string | null; disk: unknown },
  ): Promise<{ handled: boolean; ok?: boolean; path?: string; preSnapshot?: string | null }>;
  resetToolStreamsForIter(chatId: string, iter: unknown): Promise<void>;
  noteDeltaStatus(data: DonneesFlux, idx: number): void;
  forgetDeltaNames(iter: unknown): void;
  resetDeltaStatus(): void;
  oublierLibelleDelta(): void;
  refreshCompressionState(): Promise<void>;
  manualCompress(): Promise<void>;
  estimateCompressionMs(path: string): number;
  recordCompressionDuration(path: string, ms: number): void;
  startCompressionTick(idx: number): void;
  stopCompressionTick(): void;
  loadChatsList(): Promise<void>;
  loadChat(id: string, opts?: { force?: boolean; noAttach?: boolean }): Promise<void>;
  loadAvailableModels(): Promise<void>;
  loadLlmConnectors(): Promise<void>;
  resetAskUser(): void;
  normalizeAskUser(raw: unknown): QuestionAsk[] | null;
  flashRenamedTitle(entry: { _renamed?: boolean } | undefined): void;
  mergeFilesChanged(idx: number, files: unknown): void;
  extractAndStoreDiffStats(idx: number, path: string, resultStr: unknown): void;
  recordDiffForMessage(idx: number, path: string, avant: string | null): void;
  relPath(p: string): string;
  prefetchSandboxFile(path: string): Promise<string | null>;
  thinkingTitle(texte: string): string;
  voix(): CrochetsVoix;
  imageInitialProgress(req: unknown): unknown;
  imageGenFor(msgs: readonly unknown[]): Objet | null;
  cleanSamplingOverride(): unknown;
  thinkingBudget(): unknown;
  excludedNames(): string[];
  pinnedServers(): { id?: unknown; name?: string; type?: string; shared?: boolean }[];
  pinnedSkillNames(): string[];
  clearPinnedSkills(): void;
  cancelPendingChatSearch(): void;
  resetDiffCardState(): void;
  autoResize(): void;
}

/** Parties du cœur : refs de la racine, contexte, état, état du flux, moteur Markdown et liaisons. */
export interface CoeurChat {
  readonly r: RefsRacineChat;
  readonly ctx: CtxChat;
  readonly e: EtatChat;
  readonly f: EtatFlux;
  readonly md: MoteurMarkdown;
  readonly l: LiensChat;
}
