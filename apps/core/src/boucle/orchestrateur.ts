// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/orchestrateur.ts — la boucle agentique (seule fonction de chat, E23) : prélude, itérations LLM ↔ outils, budgets, sorties. */
import { config } from "@elpis/config";
import {
  CancelledError,
  estDict,
  estErreurAnnulation,
  intPy,
  longueurPy,
  prefixePy,
  pyJsonDumps,
} from "@elpis/commun";

import { ephemeral, mergeUserSuffix } from "../contexte/elagage";
import { assembleOperationalContext } from "../contexte/assemblage";
import type { CompactionThreshold } from "../contexte/porte-compaction";
import { LLAMA_MAX_TOOL_ITERATIONS } from "../llm/constantes";
import { resolveContextWindow } from "../llm/fenetre-contexte";
import { currentEngine } from "../llm/moteurs";
import type { Slot } from "../llm/ordonnanceur";
import { reflexionDuTourRendue } from "../llm/parametres";
import { verifyLlmAvailability } from "../llm/sante";
import { journal } from "../journal";
import type { ConfigMcp } from "@elpis/mcp";
import { neutraliserMarqueursTour } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import { classeursIntegres, collectMcpTools } from "../outils/catalogue";
import type { ClasseurLot, OutilIntegre } from "../outils/catalogue";
import { debutBoucle } from "../outils/integres/bilan-taches";
import { renderChecklist } from "../outils/integres/format-todo";
import type { Dict } from "../python";
import { compactionAvecSlot, llamaChatCompaction } from "./appels-uniques";
import {
  classifyTextReply,
  CycleGuard,
  jalonDansDernierResultat,
  NATIF,
  openNativeRound,
  openTextRound,
  recordToolCallMetricSafe,
  relaunchUnparsedCall,
  runToolBatch,
  TEXTE,
  TruncationGuard,
} from "./dispatch-outils";
import type { ChannelSpec } from "./dispatch-outils";
import { emit } from "./evenements";
import type { SurEvenement } from "./evenements";
import { llamaChatWithToolsStream } from "./flux-llm";
import { portTodos, portVisionBureau, recordTurnUsage, sandboxLimitsText, tokenHex } from "./ports";
import { ResumeState } from "./reprise";
import { RunContext, RunRecord } from "./run";
import type { LoopDeps } from "./run";
import { finishOk, finishOnError, finishOnLimit } from "./sortie";
import type { SortieRun } from "./sortie";
import { callLlm, LLMTurnState } from "./tour-llm";
import { travailCanonique } from "./travail";

const log = journal("boucle.orchestrateur");

/** Itérations finales qui reçoivent « Wrap up » puis « LAST » : 5, réduites au quart d'un budget de moins de 20 (écart au Python). */
export function fenetreFinBudget(n: number): number {
  return Math.max(1, Math.min(5, Math.floor(n / 4)));
}

/** Vrai si la ligne de `k`/`n` dit « Wrap up » ou « LAST » (et non le plafond d'échecs, prioritaire). */
export function estFinDeBudget(k: number, n: number, hardLeft: number | null = null): boolean {
  if (hardLeft !== null && hardLeft > 0 && hardLeft <= 5) return false;
  return n > 0 && k > 0 && k < n && n - k <= fenetreFinBudget(n);
}

/** Ligne `<harness_status>` aux jalons du budget (50 %, 75 %, fenêtre de fin) ou du plafond d'échecs ; `null` sinon. */
export function harnessStatusLine(
  k: number,
  n: number,
  o: {
    wallLeftS?: number | null;
    hardLeft?: number | null;
    ctxLeft?: number | null;
    ctxSize?: number | null;
    sandboxLimits?: string | null;
  } = {},
): string | null {
  const hardLeft = o.hardLeft ?? null;
  if (hardLeft !== null && hardLeft > 0 && hardLeft <= 5 && (n <= 0 || k < n))
    return (
      `<harness_status>Failed-call ceiling: only ${hardLeft} attempt(s) left before this turn is stopped for repeated ` +
      "tool failures (this is NOT the step budget). Your recent tool calls are failing: change approach — re-read the " +
      "actual error, verify arguments and paths, or report the blocker instead of retrying.</harness_status>"
    );
  if (n <= 0 || k <= 0 || k >= n) return null;
  const left = n - k;
  const moitie = k === Math.floor((n + 1) / 2);
  const troisQuarts = k === Math.floor((3 * n + 3) / 4);
  const fin = fenetreFinBudget(n);
  if (!(moitie || troisQuarts || left <= fin)) return null;
  let corps: string;
  if (left === 1)
    corps = `Tool-iteration budget: ${k}/${n} used — LAST iteration available. Deliver your final answer now; call one more tool only if answering is impossible without it.`;
  else if (left <= fin)
    corps = `Tool-iteration budget: ${k}/${n} used — only ${left} left. Wrap up: finish the essential steps, then deliver the final answer. Do not start anything new.`;
  else
    corps = `Tool-iteration budget: ${k}/${n} used, ${left} left. Plan the remaining work to fit. If the goal is already reached, stop calling tools and answer now; otherwise keep going — do not stop early while budget remains.`;
  if (o.wallLeftS !== null && o.wallLeftS !== undefined)
    corps += ` Wall-clock remaining: ~${Math.max(0, Math.floor(Math.floor(o.wallLeftS / 60)))} min.`;
  if (o.ctxSize && o.ctxSize > 0 && o.ctxLeft !== null && o.ctxLeft !== undefined)
    corps += ` Context window: ~${Math.floor(Math.max(0, Math.trunc(o.ctxLeft)) / 1000)}k of ${Math.floor(Math.trunc(o.ctxSize) / 1000)}k tokens left.`;
  if (o.sandboxLimits) corps += ` Sandbox limits: ${o.sandboxLimits}.`;
  return `<harness_status>${corps}</harness_status>`;
}

/** Bloc `<todo_status>` de début de tour (contenus aux marqueurs de tour inertes) quand la liste persistée du chat garde des tâches ouvertes ; `null` sinon. */
export async function todoStatusReminder(username: string, chatId: string | null): Promise<string | null> {
  if (!chatId || chatId === "default") return null;
  const port = portTodos();
  if (port === null) return null;
  let todos: readonly unknown[] | null;
  try {
    todos = await port.todosDuChat(username, chatId);
  } catch {
    return null;
  }
  const ouvertes = (todos ?? []).filter(
    (t) => estDict(t) && (t["status"] === "pending" || t["status"] === "in_progress"),
  ).length;
  if (!ouvertes) return null;
  return (
    `<todo_status>Your session todo list from previous turns still has ${ouvertes} open task(s):\n` +
    neutraliserMarqueursTour(renderChecklist(todos)) +
    "\nUnless the user's latest message changes the plan, resume this work: set the task you start to in_progress, " +
    "mark each task completed as soon as it is done (or cancelled if obsolete) — always via todowrite with the FULL " +
    "updated list, every item with its content (copied verbatim) and its status.</todo_status>"
  );
}

/** Catalogue et tête déjà prêts d'un enfant `fork` : ni collecte des outils ni assemblage de la tête, `messages` part tel quel ; seuls les outils de `permis` s'exécutent. */
export interface TeteFigee {
  toolsPayload: readonly Dict[];
  toolCfgMap: ReadonlyMap<string, ConfigMcp>;
  builtinHandlers: ReadonlyMap<string, OutilIntegre["handler"]>;
  lectureSeule: ReadonlyMap<string, boolean>;
  permis: ReadonlySet<string>;
}

export interface OptionsRun {
  messages: readonly unknown[];
  mcpConfigs?: readonly unknown[] | null;
  onEvent?: SurEvenement;
  username?: string;
  model?: string | null;
  builtinTools?: ReadonlyMap<string, OutilIntegre> | Readonly<Record<string, OutilIntegre>> | null;
  isCancelled?: (() => boolean) | null;
  signal?: AbortSignal | undefined;
  chatId?: string | null;
  samplingOverride?: Dict | null;
  thinkingMode?: boolean;
  allowedToolNames?: ReadonlySet<string> | null;
  memoryEnabled?: boolean;
  priority?: string;
  compressionPrevState?: Dict | null;
  denyToolNames?: Iterable<string> | null;
  liveShell?: boolean;
  compressionEnabled?: boolean | null;
  compactionThreshold?: CompactionThreshold | null;
  compactionMaxRounds?: number | null;
  pruneKeys?: readonly unknown[] | null;
  /** Tour éphémère (rien n'est persisté) : ni l'élagage ni la compression n'indexent pour session_search. */
  ephemeral?: boolean;
  readOnly?: boolean;
  userId?: number | null;
  /** Périmètre d'un sous-agent (`task`) : manifeste filtré, porté au `_meta` des appels locaux, sans alerte disque. */
  subagent?: SousAgent | null;
  /** Échéance souple absolue (epoch ms) fixée par l'appelant, prélude et attente de slot compris (un sous-agent : début de `task`) : jalons et arrêt propre avec synthèse s'y mesurent ; absente, seul `LLAMA_TOOL_LOOP_MAX_S` joue. */
  echeanceMs?: number | null;
  /** Ajouté à la consigne de synthèse quand un budget s'épuise (rapport d'un sous-agent). */
  wrapupSuffix?: string | null;
  /** Reçoit le texte de la synthèse finale au fil de sa génération : un délai dur qui l'interrompt en garde ce qui a été produit. */
  surTexteSynthese?: ((delta: string) => void) | null;
  /** Place (caractères) du suffixe de la question dans celui enregistré, pour un rejeu à l'octet ; absent = sans borne. */
  userSuffixRoom?: number | null;
  /** Chaque `<harness_status>` envoyé au modèle ; `finDeBudget` : ligne « Wrap up » ou « LAST » (bilan d'un sous-agent). */
  surPointEtape?: ((p: { texte: string; finDeBudget: boolean }) => void) | null;
  /** Slot du tour (`withLLM(…, { outils: true })`) ; absent, les appels partent sans file. */
  slot?: Slot | null;
  /** Clé d'affinité de slot llama.cpp, distincte du chatId (défaut : le chatId) : un sous-agent garde le même slot d'un lancement à l'autre. */
  slotKey?: string | null;
  /** Slots que les appels du run ne prennent pas si un autre est libre (parent en attente, frères en cours) ; absent, aucune exclusion. */
  slotAvoid?: (() => Iterable<number>) | null;
  /** Slot que les appels du run préfèrent s'il est libre et non évité (le dernier du sous-agent, le slot du parent pour un fork neuf), relu à chaque choix. */
  slotPrefere?: (() => number | null) | null;
  /** Reçoit le slot retenu pour chaque appel (≥ 0) : le parent y note celui que ses sous-agents doivent éviter. */
  surSlot?: ((slot: number) => void) | null;
  /** Appelé avec le rang du premier message de la liste de travail que l'envoi au moteur retire ou réécrit (ajustement à la fenêtre, sorties effacées) : le préfixe du moteur diverge à partir de là. */
  surDivergence?: ((rang: number) => void) | null;
  /** Reçoit, une fois le contexte assemblé, le lecteur des messages de travail courants en forme canonique (tête brute, ce que le moteur a vu, paires appel/résultat complètes) : reprise d'un sous-agent. */
  exposerTravail?: ((lire: () => Dict[]) => void) | null;
  /** Catalogue et tête figés (sous-agent `fork`) : `mcpConfigs`, `builtinTools`, `allowedToolNames`, `denyToolNames` et `memoryEnabled` sont sans effet, `messages` est déjà la tête assemblée du parent. */
  teteFigee?: TeteFigee | null;
  /** Points de substitution des tests (fonction de flux, métrique d'outil, résumé de compaction). */
  deps?: Partial<LoopDeps>;
}

/** Usage d'un run mort annulé ou sur une exception, s'il a consommé quelque chose et n'est pas déjà enregistré. */
function usageRunInterrompu(acc: Dict, t0: number, status: string, errorKind = ""): void {
  if (!Object.keys(acc).length || acc["recorded"]) return;
  const entree = intPy(acc["in"] || 0) + intPy(acc["inflight_in"] || 0);
  const sortie = intPy(acc["out"] || 0);
  if (entree <= 0 && sortie <= 0) return;
  recordTurnUsage({
    model: String(acc["model"] || config.LLAMA_MODEL),
    path: "tools",
    inputTokens: entree,
    outputTokens: sortie,
    submittedTokens: entree,
    thinkingTokens: 0,
    usage: {
      cache_read_input_tokens: intPy(acc["cache_read"] || 0),
      cache_creation_input_tokens: intPy(acc["cache_creation"] || 0),
      tool_input_tokens: intPy(acc["tool_in"] || 0),
    },
    durationMs: Math.trunc((Date.now() / 1000 - t0) * 1000),
    iterations: intPy(acc["iterations"] || 0),
    status,
    errorKind,
  });
  acc["recorded"] = true;
}

/** La boucle agentique : `[texte final, mutations de fichiers, métriques]` ; tracée parmi les runs du compte (attribution des fichiers des sous-agents), usage d'un run interrompu enregistré, capture libérée. */
export async function runChatMultiMcp(o: OptionsRun): Promise<SortieRun> {
  const acc: Dict = {};
  const t0 = Date.now() / 1000;
  const finBoucle = o.subagent ? null : debutBoucle(o.username ?? "guest", o.chatId ?? null, !o.readOnly);
  try {
    return await runImpl(o, acc);
  } catch (e) {
    if (estErreurAnnulation(e) || o.signal?.aborted) usageRunInterrompu(acc, t0, "cancelled");
    else usageRunInterrompu(acc, t0, "error", e instanceof Error ? e.name : typeof e);
    throw e;
  } finally {
    finBoucle?.();
    try {
      portVisionBureau()?.clearLastScreenshotFor(`${o.username ?? "guest"}:${o.chatId || "default"}`);
    } catch (e) {
      log.debug(`capture non libérée : ${String(e)}`);
    }
  }
}

async function runImpl(o: OptionsRun, acc: Dict): Promise<SortieRun> {
  const onEvent = o.onEvent ?? null;
  const username = o.username ?? "guest";
  const model = o.model ?? null;
  const chatId = o.chatId ?? null;
  const signal = o.signal;
  await verifyLlmAvailability();
  const startTime = Date.now() / 1000;
  let modelHasVision: boolean;
  try {
    modelHasVision =
      (await portVisionBureau()?.modelSupportsVision(model || config.LLAMA_MODEL || "")) ?? false;
  } catch {
    modelHasVision = false;
  }
  const chatKeySuffix = chatId || "default";
  const figee = o.teteFigee ?? null;
  let toolCfgMap: ReadonlyMap<string, ConfigMcp>;
  let toolsPayload: Dict[];
  let builtinHandlers: ReadonlyMap<string, OutilIntegre["handler"]>;
  let lectureSeule: ReadonlyMap<string, boolean>;
  let classeurs: ReadonlyMap<string, ClasseurLot> = new Map();
  let allowed: string[];
  if (figee) {
    ({ toolCfgMap, builtinHandlers, lectureSeule } = figee);
    toolsPayload = [...figee.toolsPayload];
    allowed = [...figee.permis].sort();
  } else {
    const catalogue = await collectMcpTools(o.mcpConfigs ?? [], o.builtinTools ?? null, onEvent, {
      allowedToolNames: o.allowedToolNames ?? null,
      memoryEnabled: o.memoryEnabled ?? true,
      denyToolNames: o.denyToolNames ?? null,
      readOnly: o.readOnly ?? false,
      sousAgent: o.subagent ?? null,
      signal,
    });
    ({ toolCfgMap, toolsPayload, builtinHandlers, lectureSeule } = catalogue);
    classeurs = classeursIntegres(o.builtinTools ?? null, builtinHandlers);
    allowed = [...new Set([...toolCfgMap.keys(), ...builtinHandlers.keys()])].sort();
    if (onEvent && catalogue.connectedServerNames.length)
      await emit(onEvent, {
        type: "mode",
        text: `Connecté : ${catalogue.connectedServerNames.join(", ")} (${toolsPayload.length} outil(s))`,
      });
  }
  let workingMessages: Dict[];
  if (figee) workingMessages = o.messages.filter(estDict);
  else {
    const [assemble, ax] = await assembleOperationalContext(o.messages, {
      allowedToolNames: allowed,
      username,
    });
    workingMessages = assemble as Dict[];
    const rappel = allowed.includes("todowrite") ? await todoStatusReminder(username, chatId) : null;
    const brut = [rappel, ax].filter(Boolean).join("\n\n");
    const room = o.userSuffixRoom;
    const suffixe = room === null || room === undefined ? brut : prefixePy(brut, Math.max(0, room));
    if (suffixe) {
      const queue = workingMessages[workingMessages.length - 1];
      if (estDict(queue) && queue["role"] === "user") {
        workingMessages[workingMessages.length - 1] = {
          ...queue,
          content: mergeUserSuffix(queue["content"], suffixe),
        };
        await emit(onEvent, { type: "llm_user_suffix", text: suffixe });
      } else if (!(estDict(queue) && queue["role"] === "assistant"))
        workingMessages.push(ephemeral("user", suffixe));
    }
  }
  const rec = new RunRecord();
  rec.usageAcc = acc;
  rec.travail = workingMessages;

  let maxIter = LLAMA_MAX_TOOL_ITERATIONS;
  const plafondUi = Math.max(500, LLAMA_MAX_TOOL_ITERATIONS * 4);
  const override = o.samplingOverride?.["max_tool_iterations"];
  if (typeof override === "number" || typeof override === "boolean") {
    const v = Math.trunc(Number(override));
    if (v >= 1 && v <= plafondUi) maxIter = v;
  }
  if (maxIter !== LLAMA_MAX_TOOL_ITERATIONS)
    log.info(
      `[run_chat_multi_mcp] max_tool_iterations override : ${maxIter} (défaut ${LLAMA_MAX_TOOL_ITERATIONS})`,
    );
  let toolsPayloadChars: number;
  try {
    toolsPayloadChars = toolsPayload.length
      ? longueurPy(pyJsonDumps(toolsPayload, { ensureAscii: false }))
      : 0;
  } catch {
    toolsPayloadChars = 0;
  }
  try {
    rec.ctxSize = await resolveContextWindow(model || config.LLAMA_MODEL || "");
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    rec.ctxSize = 0;
  }
  rec.gaugeCtxTotal = rec.ctxSize > 0 ? rec.ctxSize : 0;
  const budget = maxIter;
  const capDur = Math.max(maxIter * 2, maxIter + 10);
  let effectiveIter = 0;
  let hardIter = 0;
  const st = LLMTurnState.forRun({
    compressionPrevState: o.compressionPrevState ?? null,
    compactionThreshold: o.compactionThreshold ?? null,
    compactionMaxRounds: o.compactionMaxRounds ?? null,
    maxIter,
  });
  let emptyChoicesStop = false;
  const murS = Number(config.LLAMA_TOOL_LOOP_MAX_S || 0);
  const debutBoucle = performance.now() / 1000;
  const echeanceMs = o.echeanceMs && o.echeanceMs > 0 ? o.echeanceMs : null;
  /** Temps restant (s) avant le mur de la boucle, le plus proche de l'échéance absolue et du mur relatif ; `null` sans mur. */
  const murRestantS = (): number | null => {
    const relatif = murS > 0 ? murS - (performance.now() / 1000 - debutBoucle) : null;
    const absolu = echeanceMs !== null ? (echeanceMs - Date.now()) / 1000 : null;
    return relatif === null || (absolu !== null && absolu < relatif) ? absolu : relatif;
  };
  const cycle = new CycleGuard();
  let cycleHardStopped = false;
  rec.runPruneKeys = new Set((o.pruneKeys ?? []).filter((k): k is string => typeof k === "string"));
  let malformedRetry = 0;
  let dernierJalon: string | null = null;
  let limitesSandbox: string | null = null;
  const runLogTok = tokenHex(4);
  const trunc = new TruncationGuard();
  let forcedStop = false;
  const resume = new ResumeState();
  let wallclockStop = false;
  const reflexionRendue = reflexionDuTourRendue(currentEngine().profil, o.samplingOverride ?? null);

  /** Jalon du budget : dans le dernier résultat d'outil du lot quand la réflexion est rendue au moteur (un message `user` mi-tour lui ferait retirer cette réflexion par le gabarit), sinon message éphémère. */
  const injecterPointEtape = (natif: boolean): void => {
    const hardLeft = Math.max(0, capDur - hardIter);
    const u = (rec.lastRaw["usage"] || {}) as Dict;
    const occ = intPy(u["prompt_tokens"] || 0) + intPy(u["completion_tokens"] || 0);
    if (limitesSandbox === null)
      limitesSandbox = allowed.includes("execute_shell") ? (sandboxLimitsText() ?? "") : "";
    const ligne = harnessStatusLine(effectiveIter, budget, {
      wallLeftS: murRestantS(),
      hardLeft,
      ctxLeft: occ ? rec.ctxSize - occ : null,
      ctxSize: rec.ctxSize,
      sandboxLimits: limitesSandbox || null,
    });
    if (!ligne) return;
    const cle = hardLeft <= 5 ? `hard:${hardLeft}` : `steps:${effectiveIter}`;
    if (cle === dernierJalon) return;
    dernierJalon = cle;
    if (limitesSandbox && ligne.includes("Sandbox limits:")) limitesSandbox = "";
    if (!(reflexionRendue && natif && jalonDansDernierResultat(workingMessages, ligne)))
      workingMessages.push(ephemeral("user", ligne));
    o.surPointEtape?.({
      texte: ligne,
      finDeBudget: estFinDeBudget(effectiveIter, budget, hardLeft),
    });
  };

  const ctx = new RunContext({
    onEvent,
    username,
    model,
    chatId,
    userId: o.userId ?? null,
    samplingOverride: o.samplingOverride ?? null,
    thinkingMode: o.thinkingMode ?? false,
    reflexionRendue,
    isCancelled: o.isCancelled ?? null,
    signal,
    slot: o.slot ?? null,
    compressionEnabled: o.compressionEnabled ?? null,
    ephemeral: o.ephemeral ?? false,
    compactionMaxRounds: o.compactionMaxRounds ?? null,
    priority: o.priority ?? "high",
    liveShell: o.liveShell ?? false,
    subagent: o.subagent ?? null,
    wrapupSuffix: o.wrapupSuffix ?? null,
    surTexteSynthese: o.surTexteSynthese ?? null,
    slotKey: o.slotKey ?? null,
    slotAvoid: o.slotAvoid ?? null,
    slotPrefere: o.slotPrefere ?? null,
    surSlot: o.surSlot ?? null,
    surDivergence: o.surDivergence ?? null,
    compactionThreshold: o.compactionThreshold ?? null,
    outilsPermis: figee ? figee.permis : null,
    lectureSeule,
    startTime,
    modelHasVision,
    chatKeySuffix,
    runLogTok,
    toolsPayload,
    toolCfgMap,
    builtinHandlers,
    classeurs,
    toolsPayloadChars,
    maxIter,
    effectiveIterBudget: budget,
    hardIterCap: capDur,
  });
  const deps: LoopDeps = {
    stream: o.deps?.stream ?? llamaChatWithToolsStream,
    recordMetric:
      o.deps?.recordMetric ??
      ((...a: unknown[]) => recordToolCallMetricSafe(...(a as Parameters<typeof recordToolCallMetricSafe>))),
    llamaChat:
      o.deps?.llamaChat ?? (ctx.c.subagent ? compactionAvecSlot(ctx.optionsSlot()) : llamaChatCompaction),
  };

  o.exposerTravail?.(() => travailCanonique(ctx, rec, o.messages));

  while (effectiveIter < budget && hardIter < capDur && !forcedStop) {
    await rec.guardCancel(onEvent, Promise.resolve(), signal);
    if (ctx.cancelled()) {
      log.info("[run_chat_multi_mcp] Cancellation demandée par l'utilisateur → arrêt");
      await rec.emitPartialSnapshot(onEvent);
      throw new CancelledError("User cancelled");
    }
    if ((murRestantS() ?? 1) < 0 && (effectiveIter > 0 || hardIter > 0)) {
      forcedStop = true;
      wallclockStop = true;
      await emit(onEvent, {
        type: "notice",
        level: "warn",
        message: "budget de temps de la tâche atteint — synthèse et arrêt",
      });
      log.warn(
        `[run_chat_multi_mcp] budget mur d'horloge atteint (mur ${murS}s, échéance ${echeanceMs ?? "aucune"}) → synthèse`,
      );
      continue;
    }
    const iteration = hardIter;
    const derniere = (rec.lastRaw["usage"] || {}) as Dict;
    await emit(onEvent, {
      type: "iteration",
      n: effectiveIter + 1,
      max: budget,
      tokens_used: rec.cumulIn + rec.cumulOut,
      context_tokens: intPy(derniere["prompt_tokens"] || 0) + intPy(derniere["completion_tokens"] || 0),
    });
    await emit(onEvent, { type: "mode", text: "Réflexion…" });

    const turn = await callLlm(ctx, rec, st, resume, deps, workingMessages, { iteration, effectiveIter });
    workingMessages = turn.messages;
    rec.travail = workingMessages;
    if (turn.outcome === "retry") continue;
    if (turn.outcome === "retry_counted") {
      hardIter += 1;
      continue;
    }
    if (turn.outcome === "stop_empty") {
      emptyChoicesStop = true;
      break;
    }
    if (turn.outcome === "fatal")
      return finishOnError(ctx, rec, resume, {
        error: turn.error,
        errKind: turn.errKind,
        live: turn.live,
        thinkingParts: turn.thinkingParts,
        iteration,
        effectiveIter,
        hardIter,
      });

    const { live, rawResponse, usage, finish, msg, toolCalls, iterThinking, rawContentExact } = turn;
    let iterClean = turn.iterClean;
    if (finish === "length" && toolCalls.length) {
      await live.flush();
      if (await trunc.cut(NATIF.name, ctx, rec, workingMessages, { usage, iterClean, iteration }))
        forcedStop = true;
      hardIter += 1;
      continue;
    }
    let channel: ChannelSpec;
    let prepared: Dict[];
    if (finish === "tool_calls" || toolCalls.length) {
      channel = NATIF;
      prepared = await openNativeRound(ctx, rec, workingMessages, {
        live,
        msg,
        toolCalls,
        iterClean,
        iteration,
        iterThinking,
      });
    } else {
      const reply = classifyTextReply(ctx, live, iterClean, iteration);
      const rawText = reply.rawText;
      iterClean = reply.iterClean;
      const legacy = reply.calls;
      if (finish === "length" && legacy) {
        await live.flush();
        if (await trunc.cut(TEXTE.name, ctx, rec, workingMessages, { usage, iterClean, iteration }))
          forcedStop = true;
        hardIter += 1;
        continue;
      }
      let relance: boolean;
      [relance, malformedRetry] = await relaunchUnparsedCall(rec, workingMessages, reply, {
        live,
        iterThinking,
        iteration,
        malformedRetry,
      });
      if (relance) {
        hardIter += 1;
        continue;
      }
      if (!legacy) {
        if (
          await resume.plan(ctx, {
            live,
            finish,
            toolCalls,
            legacyCalls: legacy,
            iterThinking,
            iterClean,
            rawContentExact,
            rawResponse,
            gaugeCtxTotal: rec.gaugeCtxTotal,
            iteration,
          })
        ) {
          hardIter += 1;
          continue;
        }
        return finishOk(ctx, rec, resume, workingMessages, {
          live,
          msg,
          rawText,
          finish,
          iterThinking,
          iteration,
          effectiveIter,
        });
      }
      malformedRetry = 0;
      channel = TEXTE;
      prepared = openTextRound(ctx, rec, workingMessages, { rawText, calls: legacy, finish, iteration });
    }
    trunc.reset();
    resume.resetChain();
    const issue = await runToolBatch(channel, ctx, rec, deps, workingMessages, prepared, {
      iteration,
      cycle,
    });
    if (issue.cycleHardStopped) {
      cycleHardStopped = true;
      forcedStop = true;
    }
    hardIter += 1;
    if (issue.hadSuccess) {
      effectiveIter += 1;
      malformedRetry = 0;
      cycle.onProductive();
    } else
      log.info(
        `[run_chat_multi_mcp] iter ${iteration} (${channel.name}) non productive — effective_iter reste à ${effectiveIter}/${budget} (hard ${hardIter}/${capDur})`,
      );
    injecterPointEtape(channel === NATIF);
  }
  return finishOnLimit(ctx, rec, resume, deps, workingMessages, {
    effectiveIter,
    hardIter,
    wallclockStop,
    ctxSaturatedStop: trunc.stop === "ctx_saturated",
    genCapStop: trunc.stop === "gen_cap",
    cycleHardStopped,
    emptyChoicesStop,
  });
}
