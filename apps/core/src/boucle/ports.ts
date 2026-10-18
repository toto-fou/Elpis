// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/ports.ts — dépendances de la boucle pas encore portées (contexte d'usage et métriques B1-32, contrôle du raisonnement) et identifiants aléatoires : interfaces et pose. */
import { randomBytes } from "node:crypto";

import { dormirMs } from "@elpis/commun";

import type { Priorite, Slot } from "../llm/ordonnanceur";
import { ErreurPortAbsent } from "../llm/ports";

/** `shared_infra.observability.usage_ctx` : compte de l'appelant courant (`current_usage_ctx().user_id`), `null` s'il est inconnu. */
export interface PortContexteUsage {
  utilisateurCourant(): number | null;
}

let portContexteUsage: PortContexteUsage | null = null;

export function installerContexteUsage(impl: PortContexteUsage | null): void {
  portContexteUsage = impl;
}

export function contexteUsage(): PortContexteUsage {
  if (portContexteUsage === null) throw new ErreurPortAbsent("contexte d'usage non installé");
  return portContexteUsage;
}

/** `shared_infra.llm.reasoning_control` : complétion en cours d'un chat, pour « Répondre maintenant » depuis n'importe quel worker. */
export interface PortControleRaisonnement {
  noteCompletion(chatId: string, completionId: string, model: string, engineKey: string): void;
  clearCompletion(chatId: string): void;
}

let portControleRaisonnement: PortControleRaisonnement | null = null;

export function installerControleRaisonnement(impl: PortControleRaisonnement | null): void {
  portControleRaisonnement = impl;
}

export function controleRaisonnement(): PortControleRaisonnement {
  if (portControleRaisonnement === null) throw new ErreurPortAbsent("contrôle du raisonnement non installé");
  return portControleRaisonnement;
}

/** `shared_infra.db.log_metric(event_type, value, tags, user_id)` : best-effort, absent = métrique omise ; sans `userId`, le compte se déduit de `tags.user`. */
export type JournaliserMetrique = (
  type: string,
  valeur: number,
  tags: Record<string, unknown>,
  userId?: number | null,
) => unknown;

let metriques: JournaliserMetrique | null = null;

export function installerMetriquesBoucle(f: JournaliserMetrique | null): void {
  metriques = f;
}

/** Métrique en arrière-plan (l'écriture en base ne retarde jamais la boucle) ; tout échec est tu. */
export function logMetric(
  type: string,
  valeur: number,
  tags: Record<string, unknown>,
  userId: number | null = null,
): void {
  if (metriques === null) return;
  try {
    void Promise.resolve(metriques(type, valeur, tags, userId)).catch(() => undefined);
  } catch {
    return;
  }
}

/** `secrets.token_hex(n)` : 2n caractères hexadécimaux ; remplaçable par une suite déterministe (tests, goldens). */
let generateurHex: ((n: number) => string) | null = null;

export function installerTokenHex(f: ((n: number) => string) | null): void {
  generateurHex = f;
}

export function tokenHex(n = 32): string {
  return generateurHex ? generateurHex(n) : randomBytes(n).toString("hex");
}

/** `current_run()` de l'observabilité : attente d'un créneau et fichiers modifiés de l'exécution courante (best-effort). */
export interface PortExecutionCourante {
  readonly id: string;
  ajouterAttente(ms: number): void;
  ajouterFichiers(fichiers: readonly unknown[]): void;
  ajouterAppelOutil(categorie: string, statut: string): void;
}

let executionCourante: (() => PortExecutionCourante | null) | null = null;

/** Accesseur de l'exécution courante (`current_run`), relu à chaque mesure. */
export function installerExecutionCourante(f: (() => PortExecutionCourante | null) | null): void {
  executionCourante = f;
}

/** Exécution courante, `null` hors exécution suivie ou port absent. */
export function executionEnCours(): PortExecutionCourante | null {
  return executionCourante?.() ?? null;
}

/** `asyncio.sleep` de la boucle (pauses de relance) : remplaçable par une attente instantanée (goldens). */
let attente: ((s: number, signal?: AbortSignal) => Promise<void>) | null = null;

export function installerDormir(f: ((s: number, signal?: AbortSignal) => Promise<void>) | null): void {
  attente = f;
}

export function dormir(s: number, signal?: AbortSignal): Promise<void> {
  return attente ? attente(s, signal) : dormirMs(s * 1000, signal);
}

/** Captures et trames (`_desktop_session`, `_pw_session`, `_vision`, `tools/image_tool`) : branchées avec B1-19c ; absentes, rien n'est enrichi. */
export interface PortVisionBureau {
  extractDesktopFrame(
    toolName: string,
    toolArgs: unknown,
    resultStr: unknown,
  ): Record<string, unknown> | null;
  desktopFramePath(token: string): string;
  registerDesktopFrameOwner(token: string, username: string): void | Promise<void>;
  extractPwScreenshotUrl(
    toolName: string,
    toolArgs: unknown,
    resultStr: unknown,
  ): { url: string; step: unknown; session_id: unknown } | null;
  pwVerbOf(toolName: string, toolArgs: unknown): string;
  trackPwSessionOwnership(
    toolName: string,
    toolArgs: unknown,
    resultStr: unknown,
    username: string,
  ): Promise<void>;
  getLastScreenshotB64(chatKey: string): string | null;
  trackLastScreenshotForVision(chatKey: string, chemin: string): Promise<void>;
  clearLastScreenshotFor(chatKey: string): void;
  modelSupportsVision(model: string): Promise<boolean>;
  imageToolTimeoutS(): number;
}

let visionBureau: PortVisionBureau | null = null;

export function installerVisionBureau(impl: PortVisionBureau | null): void {
  visionBureau = impl;
}

export function portVisionBureau(): PortVisionBureau | null {
  return visionBureau;
}

/** Ligne `tool_call_metrics` (observabilité, B1-32) : le compte est résolu par l'implémentation. */
export interface LigneMetriqueOutil {
  username: string;
  run_id: string;
  tool_name: string;
  status: string;
  duration_ms: number;
  error_short: string | null;
  category: string;
  call_id?: unknown;
  started_at?: number;
  exit_code?: number | null;
  args_bytes?: number;
  result_bytes?: number;
}

let metriquesOutils: ((ligne: LigneMetriqueOutil) => unknown) | null = null;

export function installerMetriquesOutils(f: ((ligne: LigneMetriqueOutil) => unknown) | null): void {
  metriquesOutils = f;
}

export function metriqueOutil(): ((ligne: LigneMetriqueOutil) => unknown) | null {
  return metriquesOutils;
}

/** `usage_ctx.record_turn_usage` : UNE ligne de registre par tour (B1-32) ; best-effort, absent = rien d'enregistré. */
export interface UsageTour {
  model: string;
  path: string;
  inputTokens: number;
  outputTokens: number;
  submittedTokens: number;
  thinkingTokens: number;
  usage: Record<string, unknown>;
  durationMs: number;
  iterations: number;
  status: string;
  errorKind?: string;
  /** `usage_scope` du tour : `title`, `compression`, `image_prompt`… (absent = scope courant). */
  scope?: string;
}

let registreUsage: ((u: UsageTour) => unknown) | null = null;

export function installerRegistreUsage(f: ((u: UsageTour) => unknown) | null): void {
  registreUsage = f;
}

export function recordTurnUsage(u: UsageTour): void {
  if (registreUsage === null) return;
  try {
    void Promise.resolve(registreUsage(u)).catch(() => undefined);
  } catch {
    return;
  }
}

/** File LLM de l'ordonnanceur (`withLLM`) : boucle enfant des sous-agents, appels uniques hors tour ; absente, l'appel part sans file. */
export interface PortFileLlm {
  withLLM<T>(
    model: string | null | undefined,
    priority: Priorite,
    signal: AbortSignal | undefined,
    fn: (slot: Slot) => Promise<T>,
    options?: { outils?: boolean },
  ): Promise<T>;
}

let fileLlmCourante: PortFileLlm | null = null;

export function installerFileLlm(impl: PortFileLlm | null): void {
  fileLlmCourante = impl;
}

export function fileLlm(): PortFileLlm | null {
  return fileLlmCourante;
}

/** Liste de tâches persistée du chat (`chat.store.get_chat_todos`, compte résolu par l'implémentation). */
export interface PortTodos {
  todosDuChat(username: string, chatId: string): Promise<readonly unknown[] | null>;
}

let todos: PortTodos | null = null;

export function installerTodos(impl: PortTodos | null): void {
  todos = impl;
}

export function portTodos(): PortTodos | null {
  return todos;
}

/** Événements de jobs d'une conversation joints au prochain résultat d'outil d'un tour actif (JB-07). */
export interface PortJobsBoucle {
  /** Drapeau mémoire : vrai s'il y a peut-être des événements non livrés (aucune requête sinon). */
  enAttente(uid: number, chatId: string): boolean;
  /** Prise atomique, texte `<job_event>` à suffixer au résultat ; `null` sans événement. */
  prendrePourResultat(uid: number, chatId: string): Promise<string | null>;
}

let jobsBoucle: PortJobsBoucle | null = null;

export function installerJobsBoucle(impl: PortJobsBoucle | null): void {
  jobsBoucle = impl;
}

export function portJobsBoucle(): PortJobsBoucle | null {
  return jobsBoucle;
}

/** Limites du conteneur de la sandbox en une ligne courte (`load_admin_config`), `null` si illisibles. */
let limitesSandbox: (() => string | null) | null = null;

export function installerLimitesSandbox(f: (() => string | null) | null): void {
  limitesSandbox = f;
}

export function sandboxLimitsText(): string | null {
  try {
    return limitesSandbox ? limitesSandbox() : null;
  } catch {
    return null;
  }
}

/** `run_scope` + `usage_scope` de l'observabilité (B1-32) : exécution et registre d'usage rattachés à un sous-agent. */
export interface PorteeExecution {
  genre: string;
  userId: number | null;
  chatId: string;
  model: string;
  engine: string;
  parentId?: string;
}

let porteeExecution: (<T>(p: PorteeExecution, fn: () => Promise<T>) => Promise<T>) | null = null;

export function installerPorteeExecution(
  f: (<T>(p: PorteeExecution, fn: () => Promise<T>) => Promise<T>) | null,
): void {
  porteeExecution = f;
}

/** Exécute `fn` dans la portée ; sans port, `fn` seule. */
export function dansPorteeExecution<T>(p: PorteeExecution, fn: () => Promise<T>): Promise<T> {
  return porteeExecution ? porteeExecution(p, fn) : fn();
}
