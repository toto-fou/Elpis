// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/tour-llm.ts — un tour LLM de la boucle : rappels de flux, compaction, élagage, ajustement au contexte, appel dans le slot, récupérations, décodage. */
import { config, reloadCompressionConfigFromDisk } from "@elpis/config";
import {
  arrondiEntierPy,
  estDict,
  estErreurAnnulation,
  intPy,
  longueurPy,
  minPy,
  strPy,
  stripPy,
} from "@elpis/commun";

import {
  compressionWasAttempted,
  indexPrunedToolOutputs,
  maybeCompressConversation,
} from "../contexte/compresseur";
import { fitContext, selectPruneKeys, truncateHeadTail } from "../contexte/elagage";
import {
  compactionGate,
  gateTokens,
  resolveThreshold,
  runCompactionBudget,
} from "../contexte/porte-compaction";
import type { CompactionGate, CompactionThreshold } from "../contexte/porte-compaction";
import {
  countImageBlocks,
  countToolsTokensEx,
  measuredPromptTokens,
  noteRealUsage,
  payloadChars,
} from "../contexte/tokens";
import { currentTarget } from "../llm/cible";
import { declaredWindow } from "../llm/fenetre-contexte";
import { nativeReasoningTokens } from "../llm/jetons-raisonnement";
import { getModelContextSize } from "../llm/modeles";
import {
  errorBodyText,
  KIND_CONTEXT_OVERFLOW,
  KIND_FORBIDDEN,
  KIND_INVALID_REQUEST,
  KIND_RATE_LIMITED,
  KIND_UNKNOWN,
  llmErrorKind,
  LLMFailure,
} from "../llm/reprises";
import { journal } from "../journal";
import type { Dict } from "../python";
import { extractThinking } from "./chat-commun";
import { emit } from "./evenements";
import { dormir, executionEnCours, logMetric, tokenHex } from "./ports";
import type { ResumeRequest, ResumeState } from "./reprise";
import { AUCUNE_REPRISE } from "./reprise";
import { clipThinkingHistory } from "./run";
import type { LoopDeps, RunContext, RunRecord } from "./run";
import { watchLlmCall } from "./surveillance";
import { LiveText } from "./texte-direct";

const log = journal("boucle.tour-llm");

export const FLATTEN_RESUME_NUDGE =
  "[SYSTEM] The structured tool history above was flattened to plain text for compatibility. Pick the mission up where it stands and continue.";
const QUOTA_MARKERS = ["insufficient_quota", "exceeded your current quota"];

export const CTX_OVERFLOW_RETRY_MAX = 2;
export const LLM_HICCUP_RETRY_MAX = 3;
export const EMPTY_CHOICES_RETRY_MAX = 3;

/** La relance « hoquet » peut-elle aboutir pour cette famille de panne (non pour les pannes déterministes) ? */
export function llmErrorHiccupOk(kind: string, err: unknown, o: { flattenPending: boolean }): boolean {
  if (kind === KIND_CONTEXT_OVERFLOW || kind === KIND_FORBIDDEN) return false;
  if (kind === KIND_RATE_LIMITED) {
    const corps = errorBodyText(err).toLowerCase();
    if (QUOTA_MARKERS.some((m) => corps.includes(m))) return false;
  }
  return !(kind === KIND_INVALID_REQUEST && !o.flattenPending);
}

/** Ids d'appel uniques sur tout l'historique (copie) : un id vide ou déjà vu en reçoit un neuf. */
export function uniqueToolCallIds(toolCalls: readonly unknown[], history: readonly unknown[]): unknown[] {
  if (!toolCalls.length) return [...toolCalls];
  const vus = new Set<unknown>();
  for (const m of history ?? [])
    if (estDict(m) && m["role"] === "assistant" && Array.isArray(m["tool_calls"]))
      for (const tc of m["tool_calls"]) if (estDict(tc) && tc["id"]) vus.add(tc["id"]);
  return toolCalls.map((tc) => {
    if (!estDict(tc)) return tc;
    let sortie: Dict = tc;
    if (!tc["id"] || vus.has(tc["id"])) sortie = { ...tc, id: `call_${tokenHex(6)}` };
    vus.add(sortie["id"]);
    return sortie;
  });
}

function texteDe(m: Dict): string {
  const c = m["content"];
  if (Array.isArray(c))
    return c
      .filter((b) => estDict(b) && typeof b["text"] === "string")
      .map((b) => (b as Record<string, string>)["text"])
      .join(" ");
  return strPy(c || "");
}

/** Dernier recours : tout l'historique d'outils en texte, forme conversationnelle stricte (system en tête, rôles alternés, jamais un assistant en dernier). */
export function flattenToolMessages(messages: readonly unknown[]): Dict[] {
  const systems: Dict[] = [];
  const body: Dict[] = [];
  const pousser = (role: string, texte: string, o: { ephemeral?: boolean; anchor?: boolean } = {}): void => {
    const t = stripPy(texte || "");
    if (!t) return;
    const prev = body[body.length - 1];
    if (prev && prev["role"] === role) {
      prev["content"] = `${strPy(prev["content"])}\n\n${t}`;
      if (!(o.ephemeral && prev["_ephemeral"])) delete prev["_ephemeral"];
      if (o.anchor) prev["_task_anchor"] = true;
      return;
    }
    const msg: Dict = { role, content: t };
    if (o.ephemeral) msg["_ephemeral"] = true;
    if (o.anchor) msg["_task_anchor"] = true;
    body.push(msg);
  };
  for (const m of messages) {
    if (!estDict(m)) continue;
    const role = m["role"];
    if (role === "system") systems.push({ ...m, content: texteDe(m) });
    else if (role === "tool") {
      let txt = texteDe(m);
      if (longueurPy(txt) > 8000) txt = truncateHeadTail(txt, 8000);
      pousser("user", `[Tool result — previous turn]\n${txt}`, { ephemeral: true });
    } else if (role === "assistant") {
      let content = texteDe(m);
      const appels = m["tool_calls"];
      if (Array.isArray(appels) && appels.length) {
        const noms = appels.filter(estDict).map((tc) => {
          const fn = tc["function"] || {};
          return strPy(estDict(fn) && Object.hasOwn(fn, "name") ? fn["name"] : "?");
        });
        content = stripPy(content + `\n[Tools called: ${noms.join(", ")}]`);
      }
      pousser("assistant", content || "(...)", { ephemeral: Boolean(m["_ephemeral"]) });
    } else {
      pousser("user", texteDe(m), {
        ephemeral: Boolean(m["_ephemeral"]),
        anchor: Boolean(m["_task_anchor"]),
      });
    }
  }
  if (!body.length || body[body.length - 1]!["role"] === "assistant")
    body.push({ role: "user", content: FLATTEN_RESUME_NUDGE, _ephemeral: true });
  return [...systems, ...body];
}

/** État privé des tours LLM d'un run : mesure du contexte, compactions, séries de récupération. */
export class LLMTurnState {
  runCompactionMax: number;
  compactionThreshold: CompactionThreshold;
  comprStateCur: Dict | null;
  comprCapped = false;
  compactionsThisRun = 0;
  lastCompressionIter = -1_000_000;
  comprFailStreak = 0;
  compactionThresholdLogged = false;
  fenetreDepasseeSignalee = false;
  fitDropped = false;
  lastRealCtxTok: number | null = null;
  realCtxMsgCount: number | null = null;
  occAnchorTok: number | null = null;
  occAnchorCount: number | null = null;
  lastPruneIter = -10_000;
  overBudgetWarned = false;
  flattenRetryDone = false;
  ctxOverflowRetries = 0;
  llmHiccupStreak = 0;
  emptyChoicesStreak = 0;

  constructor(runCompactionMax: number, threshold: CompactionThreshold, comprStateCur: Dict | null = null) {
    this.runCompactionMax = runCompactionMax;
    this.compactionThreshold = threshold;
    this.comprStateCur = comprStateCur;
  }

  /** Budget de compactions du run mis à l'échelle des itérations (cap du compte compris) ; seuil du compte ou d'instance. */
  static forRun(o: {
    compressionPrevState: Dict | null;
    compactionThreshold: CompactionThreshold | null;
    compactionMaxRounds: number | null;
    maxIter: number;
  }): LLMTurnState {
    const parRun = Math.max(1, intPy(config.COMPACTIONS_PER_RUN_MAX || 2));
    const max = runCompactionBudget(
      Math.max(parRun, Math.min(64, Math.max(1, Math.floor(o.maxIter / 25)))),
      o.compactionMaxRounds,
    );
    if (max !== parRun)
      log.info(
        `[run_chat_multi_mcp] budget de compactions du run : ${max} (réglage ${parRun}, mis à l'échelle sur ${o.maxIter} itérations, cap du compte ${o.compactionMaxRounds === null ? "—" : o.compactionMaxRounds <= 0 ? "illimité" : o.compactionMaxRounds})`,
      );
    return new LLMTurnState(max, o.compactionThreshold ?? resolveThreshold(), o.compressionPrevState);
  }
}

export type TurnOutcome = "ok" | "retry" | "retry_counted" | "stop_empty" | "fatal";

/** Issue d'un tour LLM ; `messages` est TOUJOURS la liste de travail courante (compaction, aplatissement). */
export interface LLMTurn {
  outcome: TurnOutcome;
  messages: Dict[];
  live: LiveText;
  thinkingParts: string[];
  error: unknown;
  errKind: string | null;
  rawResponse: Dict;
  usage: Dict;
  finish: unknown;
  msg: Dict;
  toolCalls: unknown[];
  iterThinking: string;
  iterClean: string;
  rawContentExact: string;
}

/** Compaction automatique : décision de l'appelant, sinon interrupteur maître relu du disque. */
export function autoCompactionOn(ctx: RunContext): boolean {
  if (ctx.c.compressionEnabled !== null) return Boolean(ctx.c.compressionEnabled);
  try {
    reloadCompressionConfigFromDisk();
  } catch (e) {
    log.debug(`auto_compaction_reload : ${String(e)}`);
  }
  return Boolean(config.COMPRESSION_ENABLED ?? true);
}

function nombre(v: unknown): number {
  return typeof v === "number" ? v : Number(v || 0) || 0;
}

/** Option de lancement qui fixe la fenêtre de chaque moteur, citée par l'avis de dépassement. */
const OPTION_FENETRE: Readonly<Partial<Record<string, string>>> = {
  llamacpp: " (--ctx-size)",
  vllm: " (--max-model-len)",
  sglang: " (--context-length)",
};

/** Un tour LLM (tête d'itération → réponse décodée) ; une panne devient une issue, une annulation remonte après l'instantané. */
export async function callLlm(
  ctx: RunContext,
  rec: RunRecord,
  st: LLMTurnState,
  resume: ResumeState,
  deps: LoopDeps,
  workingMessages: Dict[],
  o: { iteration: number; effectiveIter: number },
): Promise<LLMTurn> {
  const { onEvent, model, username, chatId, samplingOverride, thinkingMode, toolsPayload, signal } = ctx.c;
  const iteration = o.iteration;
  const modele = model || config.LLAMA_MODEL || null;
  const thinkingParts: string[] = [];
  const live = new LiveText(onEvent);
  const fin = (outcome: TurnOutcome, champs: Partial<LLMTurn> = {}): LLMTurn => ({
    outcome,
    messages: workingMessages,
    live,
    thinkingParts,
    error: null,
    errKind: null,
    rawResponse: {},
    usage: {},
    finish: "",
    msg: {},
    toolCalls: [],
    iterThinking: "",
    iterClean: "",
    rawContentExact: "",
    ...champs,
  });

  const onThink = async (tok: string): Promise<void> => {
    thinkingParts.push(tok);
    await emit(onEvent, { type: "thinking_token", text: tok });
  };
  if (rec.deltaPendingIter !== null) {
    await emit(onEvent, { type: "tool_call_delta", reset: true, index: -1, iter: rec.deltaPendingIter });
    rec.deltaPendingIter = null;
  }
  const onToolCallDelta = async (index: unknown, nameDelta: string, argsDelta: string): Promise<void> => {
    await live.flush();
    const evt: Dict = { type: "tool_call_delta", index, iter: iteration };
    rec.deltaPendingIter = iteration;
    if (nameDelta) evt["name_delta"] = nameDelta;
    if (argsDelta) evt["args_delta"] = argsDelta;
    await emit(onEvent, evt);
  };
  let ppDernier = 0;
  let ppJournalise = false;
  const onPromptProgress = async (pp: Dict): Promise<void> => {
    const total = intPy(pp["total"] || 0);
    const fait = intPy(pp["processed"] || 0);
    const cache = intPy(pp["cache"] || 0);
    if (rec.usageAcc !== null && total > 0) rec.usageAcc["inflight_in"] = total;
    const final = total > 0 && fait >= total;
    const maintenant = performance.now() / 1000;
    if (final || maintenant - ppDernier >= 0.5) {
      ppDernier = maintenant;
      await emit(onEvent, {
        type: "prompt_progress",
        total,
        processed: fait,
        cache,
        time_ms: intPy(pp["time_ms"] || 0),
        iter: iteration,
      });
    }
    if (final && !ppJournalise && total > 0) {
      ppJournalise = true;
      log.info(
        `[run_chat_multi_mcp] pré-remplissage iter ${iteration} : ${total} tokens, ${cache} réutilisés du cache KV`,
      );
      logMetric("kv_prefix_reuse_pct", Math.trunc((100.0 * cache) / total), {
        model: modele || "",
        iteration,
      });
    }
  };

  let resumeConsumed = false;
  let resumeReq: ResumeRequest = AUCUNE_REPRISE;
  let toolsFixedTok = 0;
  const fitStats: Dict = {};
  let compacted: unknown[] = workingMessages;
  let raw: Dict;
  try {
    if (!rec.ctxSize || rec.ctxSize <= 0) {
      try {
        rec.ctxSize = await getModelContextSize(modele || "");
        if (
          rec.ctxSize &&
          rec.ctxSize > 0 &&
          rec.gaugeCtxTotal <= 0 &&
          currentTarget().profil.capacites.contexte !== "aucune"
        )
          rec.gaugeCtxTotal = rec.ctxSize;
      } catch (e) {
        if (estErreurAnnulation(e)) throw e;
        log.debug(`taille de contexte : ${String(e)}`);
      }
    }
    if (rec.toolsTokCounted === null && toolsPayload.length && rec.ctxSize)
      rec.toolsTokCounted = await countToolsTokensEx(toolsPayload, modele);
    toolsFixedTok = rec.toolsTokCounted ? intPy(rec.toolsTokCounted[0]) : 0;

    if (autoCompactionOn(ctx) && !st.comprCapped && st.compactionsThisRun < st.runCompactionMax) {
      const enBackoff =
        st.comprFailStreak > 0 &&
        iteration - st.lastCompressionIter < 3 * 2 ** Math.min(st.comprFailStreak, 3);
      let usable = 0;
      let seuil = 0;
      let porte: CompactionGate | null = null;
      if (rec.ctxSize && rec.ctxSize > 0) {
        try {
          reloadCompressionConfigFromDisk();
        } catch (e) {
          log.debug(`resynchronisation de la compression : ${String(e)}`);
        }
        porte = compactionGate(rec.ctxSize, { thinkingMode, threshold: st.compactionThreshold });
        usable = porte.usableTokens;
        seuil = gateTokens(porte);
      }
      let occ: number | null = null;
      let occReelle = false;
      if (seuil > 0 && !enBackoff) {
        const reel = st.fitDropped ? null : st.lastRealCtxTok;
        if (
          reel &&
          reel > 0 &&
          st.realCtxMsgCount !== null &&
          st.realCtxMsgCount >= 0 &&
          st.realCtxMsgCount <= workingMessages.length
        ) {
          occ =
            Math.trunc(reel) +
            measuredPromptTokens(workingMessages.slice(st.realCtxMsgCount), { modelId: modele });
          occReelle = true;
        } else if (
          st.occAnchorTok &&
          st.occAnchorCount !== null &&
          st.occAnchorCount >= 0 &&
          st.occAnchorCount <= workingMessages.length
        ) {
          occ =
            Math.trunc(st.occAnchorTok) +
            measuredPromptTokens(workingMessages.slice(st.occAnchorCount), { modelId: modele });
          occReelle = true;
        } else {
          occ = measuredPromptTokens(workingMessages, { modelId: modele, extraFixed: toolsFixedTok });
        }
      }
      if (
        occ !== null &&
        porte !== null &&
        porte.isUserThreshold &&
        !st.compactionThresholdLogged &&
        occ >= seuil
      ) {
        st.compactionThresholdLogged = true;
        log.info(
          `[run_chat_multi_mcp] compaction sur le seuil du compte (${porte.triggerTokens} tk, réglé ${porte.describe()}) à l'itération ${iteration} — occupation ≈${occ}, plafond technique à ${usable} tk.`,
        );
      }
      if (occ !== null && occ >= seuil) {
        const occupation = occ;
        const [messages, stats] = await ctx.appelLLM(() =>
          maybeCompressConversation(workingMessages, {
            llamaChatFn: deps.llamaChat,
            onEvent: onEvent ?? null,
            model,
            userId: strPy(username),
            logPrefix: `multi_mcp[iter${iteration}]`,
            ctxSizeTokens: rec.ctxSize || null,
            realTokens: occReelle ? occupation : null,
            usableTokens: usable,
            triggerTokens: seuil,
            maxRounds: ctx.c.compactionMaxRounds,
            prevState: st.comprStateCur,
            extraFixedTokens: toolsFixedTok,
            ftsSessionId: chatId,
            ftsDejaIndexees: rec.runPruneKeys,
            ftsIndexer: !ctx.c.ephemeral,
            autoEnabled: ctx.c.compressionEnabled,
            signal,
          }),
        );
        workingMessages = messages;
        if (stats["reason"] === "max_rounds_reached") st.comprCapped = true;
        const nouvel = stats["new_state"];
        if (estDict(nouvel))
          st.comprStateCur = {
            ...nouvel,
            applied_drop: true,
            applied_drop_turns: intPy(nouvel["covered_turns"] || 0),
          };
        if (compressionWasAttempted(stats) || stats["defer_retry"]) {
          st.comprFailStreak =
            stats["compressed"] && !stats["defer_retry"] ? 0 : Math.min(st.comprFailStreak + 1, 3);
          st.lastCompressionIter = iteration;
          if (stats["compressed"]) {
            st.compactionsThisRun += 1;
            rec.budgetDropFloor = 0;
            st.ctxOverflowRetries = 0;
            st.lastRealCtxTok = null;
            st.realCtxMsgCount = null;
            st.occAnchorTok = null;
            st.occAnchorCount = null;
          }
        } else if (stats["reason"] === "threshold_not_reached" && stats["occupancy_tokens"]) {
          st.occAnchorTok = intPy(stats["occupancy_tokens"]);
          st.occAnchorCount = workingMessages.length;
        }
      }
    }

    const tousLes = intPy(config.PRUNE_EVERY_ITERS || 0);
    if (tousLes > 0 && rec.ctxSize && iteration - st.lastPruneIter >= tousLes) {
      st.lastPruneIter = iteration;
      try {
        const nouvelles = await selectPruneKeys(workingMessages, {
          ctxSize: rec.ctxSize,
          modelId: modele,
          alreadyMarked: rec.runPruneKeys,
          signal,
        });
        if (nouvelles.length) {
          if (!ctx.c.ephemeral)
            await indexPrunedToolOutputs(workingMessages, nouvelles, strPy(username), chatId);
          for (const k of nouvelles) rec.runPruneKeys.add(k);
          rec.pruneKeysNew.push(...nouvelles);
          st.lastRealCtxTok = null;
          st.realCtxMsgCount = null;
          log.info(
            `[run_chat_multi_mcp] élagage intra-run iter ${iteration} : ${nouvelles.length} sortie(s) d'outil effacée(s) de la vue (total marqué : ${rec.runPruneKeys.size})`,
          );
        }
      } catch (e) {
        if (estErreurAnnulation(e) || signal?.aborted) throw e;
        log.debug(`[run_chat_multi_mcp] élagage intra-run échoué : ${String(e)}`);
      }
    }

    compacted = await fitContext(workingMessages, {
      ctxSize: rec.ctxSize,
      modelId: modele,
      thinkingMode,
      toolsFixedTokens: toolsFixedTok,
      realCtxTokens: st.lastRealCtxTok,
      realCtxMsgCount: st.realCtxMsgCount,
      statsOut: fitStats,
      pruneKeys: rec.runPruneKeys,
      dropFloor: rec.budgetDropFloor,
      signal,
    });
    rec.budgetDropFloor = intPy(fitStats["drop_floor"] || 0);
    st.fitDropped =
      Boolean(fitStats["dropped"]) || rec.budgetDropFloor > 0 || compacted.length !== workingMessages.length;
    if (fitStats["over_budget"] && !st.overBudgetWarned) {
      st.overBudgetWarned = true;
      const est = fitStats["estimated"];
      const bud = fitStats["budget"];
      const chiffres = est && bud ? ` (~${strPy(est)} tokens estimés pour ~${strPy(bud)} disponibles)` : "";
      await emit(onEvent, {
        type: "warning",
        text:
          "Contexte maximum atteint : la conversation est trop longue pour la fenêtre du modèle et n'a pas pu être " +
          `réduite davantage${chiffres}. Compactez la conversation (/compact), retirez les pièces jointes ` +
          "volumineuses, ou démarrez un nouveau chat.",
      });
    }

    resumeReq = resume.take();
    resumeConsumed = true;
    const t0 = performance.now();
    raw = await ctx.appelLLM(async () => {
      if (ctx.c.slot?.mode === "optimized") {
        const attenteMs = Math.trunc(performance.now() - t0);
        executionEnCours()?.ajouterAttente(attenteMs);
        logMetric("llm_wait_time_ms", attenteMs, { model: modele || "", mode: "optimized", iteration });
      }
      return deps.stream(compacted, toolsPayload, {
        modelOverride: model,
        userId: username,
        onThinkingToken: onThink,
        onContentToken: (t) => live.onToken(t),
        onToolCallDelta,
        onPromptProgress,
        isCancelled: ctx.c.isCancelled,
        signal,
        samplingOverride,
        thinkingMode,
        chatId,
        resumeThink: resumeReq.think,
        resumeNativeOk: resumeReq.nativeOk,
        resumeContent: resumeReq.content,
      });
    });
  } catch (llmErr) {
    if (estErreurAnnulation(llmErr) || signal?.aborted) {
      await rec.emitPartialSnapshot(onEvent);
      throw llmErr;
    }
    log.warn(
      `[run_chat_multi_mcp] Erreur LLM iter ${iteration}: ${String(llmErr).slice(0, 200)} — termine avec partiel`,
    );
    if (resumeConsumed) resume.restore(resumeReq);
    const cause = llmErr instanceof LLMFailure ? llmErr.cause : llmErr;
    const errKind = llmErrorKind(cause);

    if (
      errKind === KIND_CONTEXT_OVERFLOW &&
      st.compactionsThisRun < st.runCompactionMax &&
      st.ctxOverflowRetries < CTX_OVERFLOW_RETRY_MAX &&
      autoCompactionOn(ctx)
    ) {
      st.ctxOverflowRetries += 1;
      const porte =
        rec.ctxSize && rec.ctxSize > 0
          ? compactionGate(rec.ctxSize, { thinkingMode, threshold: st.compactionThreshold })
          : null;
      let stats: Dict;
      try {
        [workingMessages, stats] = await ctx.appelLLM(() =>
          maybeCompressConversation(workingMessages, {
            llamaChatFn: deps.llamaChat,
            onEvent: onEvent ?? null,
            model,
            userId: strPy(username),
            logPrefix: `multi_mcp[iter${iteration}:overflow]`,
            ctxSizeTokens: rec.ctxSize || null,
            usableTokens: porte ? porte.usableTokens : null,
            triggerTokens: porte ? porte.triggerTokens : null,
            maxRounds: ctx.c.compactionMaxRounds,
            triggeredByOverflow: true,
            prevState: st.comprStateCur,
            extraFixedTokens: toolsFixedTok,
            ftsSessionId: chatId,
            ftsDejaIndexees: rec.runPruneKeys,
            ftsIndexer: !ctx.c.ephemeral,
            autoEnabled: ctx.c.compressionEnabled,
            signal,
          }),
        );
      } catch (e) {
        if (estErreurAnnulation(e) || signal?.aborted) await rec.emitPartialSnapshot(onEvent);
        throw e;
      }
      if (stats["compressed"]) {
        st.compactionsThisRun += 1;
        rec.budgetDropFloor = 0;
        st.lastRealCtxTok = null;
        st.realCtxMsgCount = null;
        st.occAnchorTok = null;
        st.occAnchorCount = null;
        const nouvel = stats["new_state"];
        if (estDict(nouvel))
          st.comprStateCur = {
            ...nouvel,
            applied_drop: true,
            applied_drop_turns: intPy(nouvel["covered_turns"] || 0),
          };
        log.warn(
          `[run_chat_multi_mcp] contexte dépassé iter ${iteration} → compaction puis relance (${st.ctxOverflowRetries}/${CTX_OVERFLOW_RETRY_MAX} de la série)`,
        );
        return fin("retry");
      }
    }

    const aplatir =
      !st.flattenRetryDone &&
      (errKind === KIND_INVALID_REQUEST || errKind === KIND_UNKNOWN) &&
      (iteration === 0 || st.llmHiccupStreak >= LLM_HICCUP_RETRY_MAX);
    if (aplatir) {
      st.flattenRetryDone = true;
      log.warn(
        `[run_chat_multi_mcp] échec iter ${iteration} (${errKind}) → aplatissement de l'historique tool et nouvelle tentative (récupération)`,
      );
      await emit(onEvent, {
        type: "info",
        text: "Historique de conversation incompatible avec le moteur — récupération automatique en cours (les détails d'outils des tours précédents sont simplifiés en texte).",
      });
      workingMessages = flattenToolMessages(workingMessages);
      rec.budgetDropFloor = 0;
      st.realCtxMsgCount = null;
      st.occAnchorTok = null;
      st.occAnchorCount = null;
      return fin("retry");
    }

    if (
      st.llmHiccupStreak < LLM_HICCUP_RETRY_MAX &&
      !live.parts.length &&
      !thinkingParts.length &&
      llmErrorHiccupOk(errKind, cause, { flattenPending: !st.flattenRetryDone })
    ) {
      st.llmHiccupStreak += 1;
      log.warn(
        `[run_chat_multi_mcp] hoquet moteur iter ${iteration} (${errKind}) → nouvelle tentative ${st.llmHiccupStreak}/${LLM_HICCUP_RETRY_MAX} (aucun token émis)`,
      );
      await emit(onEvent, { type: "info", text: "Hoquet du moteur LLM — nouvelle tentative…" });
      await rec.guardCancel(onEvent, dormir(2 * st.llmHiccupStreak, signal), signal);
      return fin("retry");
    }
    return fin("fatal", { error: llmErr, errKind });
  }

  rec.lastRaw = raw;
  st.llmHiccupStreak = 0;
  st.ctxOverflowRetries = 0;
  const usage = (raw["usage"] || {}) as Dict;
  rec.cumulIn += nombre(usage["prompt_tokens"] ?? 0);
  rec.cumulOut += nombre(usage["completion_tokens"] ?? 0);
  rec.cumulCacheRead += intPy(usage["cache_read_input_tokens"] || 0);
  rec.cumulCacheCreation += intPy(usage["cache_creation_input_tokens"] || 0);
  rec.noteToolInput(compacted, toolsPayload, modele, usage["prompt_tokens"] ?? 0);
  rec.usageNote({ effectiveIter: o.effectiveIter, model: modele });
  const rsn = nativeReasoningTokens(usage);
  if (rsn !== null) rec.cumulReasoning = (rec.cumulReasoning ?? 0) + rsn;

  const ptReel = intPy(usage["prompt_tokens"] || 0);
  if (ptReel > 0) {
    st.lastRealCtxTok = ptReel;
    try {
      noteRealUsage(
        modele,
        payloadChars(compacted) + ctx.c.toolsPayloadChars,
        ptReel,
        countImageBlocks(compacted),
      );
    } catch (e) {
      log.debug(`ratio mesuré : ${String(e)}`);
    }
    st.realCtxMsgCount = st.fitDropped ? null : workingMessages.length;
  }
  watchLlmCall({
    chatId,
    path: "tools",
    iteration,
    model: modele || "",
    messages: compacted,
    toolsPayload,
    usage,
    timings: (raw["timings"] || {}) as Dict,
    fit: { ...fitStats, fit_dropped: st.fitDropped },
  });
  const kvTotal = intPy(rec.gaugeCtxTotal || 0);
  if (ptReel > 0 && kvTotal > 0)
    await emit(onEvent, {
      type: "kv_cache",
      used: ptReel,
      total: kvTotal,
      pct: minPy(100, arrondiEntierPy((ptReel / kvTotal) * 100)),
    });
  if (ptReel > kvTotal && kvTotal > 0 && !st.fenetreDepasseeSignalee) {
    st.fenetreDepasseeSignalee = true;
    log.warn(
      `[run_chat_multi_mcp] prompt réel ${ptReel} tk > fenêtre connue ${kvTotal} tk (iter ${iteration}) — fenêtre ` +
        "déclarée, lue ou devinée trop petite : jauge et compaction se fondent sur une valeur fausse",
    );
    const cible = currentTarget();
    if (cible.profil.capacites.contexte !== "aucune" || (await declaredWindow(cible.connectorId)) > 0)
      await emit(onEvent, {
        type: "notice",
        level: "warn",
        message:
          `Le moteur a traité ${ptReel} jetons, plus que la fenêtre connue (${kvTotal}) : vérifiez la fenêtre ` +
          `déclarée du connecteur (context_window) ou celle du moteur${OPTION_FENETRE[cible.profil.type] ?? ""}.`,
      });
  }

  const choices = (raw["choices"] || []) as unknown[];
  if (!choices.length) {
    if (resumeConsumed) resume.restore(resumeReq);
    if (st.emptyChoicesStreak < EMPTY_CHOICES_RETRY_MAX) {
      st.emptyChoicesStreak += 1;
      log.warn(
        `[run_chat_multi_mcp] réponse sans 'choices' iter ${iteration} → nouvelle tentative ${st.emptyChoicesStreak}/${EMPTY_CHOICES_RETRY_MAX}`,
      );
      await emit(onEvent, { type: "info", text: "Réponse vide du moteur — nouvelle tentative…" });
      await rec.guardCancel(onEvent, dormir(2 * st.emptyChoicesStreak, signal), signal);
      return fin("retry_counted");
    }
    log.error(
      `[run_chat_multi_mcp] réponse sans 'choices' ${st.emptyChoicesStreak} fois de suite — arrêt du run`,
    );
    return fin("stop_empty");
  }
  st.emptyChoicesStreak = 0;

  const choice = choices[0] as Dict;
  const finish = Object.hasOwn(choice, "finish_reason") ? choice["finish_reason"] : "";
  const msg = (choice["message"] || {}) as Dict;
  const toolCalls = uniqueToolCallIds((msg["tool_calls"] || []) as unknown[], workingMessages);
  let iterThinking = thinkingParts.join("");
  let rc = msg["content"];
  if (Array.isArray(rc)) rc = rc.map((b) => (estDict(b) ? strPy(b["text"] || "") : strPy(b))).join("");
  let rawContent = stripPy(rc !== null && rc !== undefined ? strPy(rc) : "");
  const rawContentExact = rc !== null && rc !== undefined ? strPy(rc) : "";
  if (!iterThinking) {
    [iterThinking, rawContent] = extractThinking(rawContent, { truncated: strPy(finish || "") === "length" });
    if (iterThinking) {
      await emit(onEvent, { type: "thinking_content", text: iterThinking });
      await live.remplacer(rawContent);
    }
  }
  let iterClean = rawContent;
  if (iterThinking) {
    rec.allThinking.push(iterThinking);
    clipThinkingHistory(rec.allThinking);
  }
  if (resumeReq.think) {
    const tous = rec.allThinking;
    if (iterThinking && tous.length && tous[tous.length - 1] === iterThinking) tous.pop();
    if (tous.length && tous[tous.length - 1] === resumeReq.think) tous.pop();
    iterThinking = resumeReq.think + (iterThinking || "");
    tous.push(iterThinking);
    clipThinkingHistory(tous);
  }
  if (resumeReq.content) {
    iterClean = resumeReq.content + (iterClean || "");
    live.prefixerDejaEmis(resumeReq.content);
  }
  return fin("ok", {
    rawResponse: raw,
    usage,
    finish,
    msg,
    toolCalls,
    iterThinking,
    iterClean,
    rawContentExact,
  });
}
