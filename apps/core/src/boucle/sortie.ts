// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/sortie.ts — les trois sorties d'un run : réponse finale, limite atteinte (tour de synthèse sans outils), erreur ; métriques et registre d'usage. */
import { config } from "@elpis/config";
import { estErreurAnnulation, intPy, longueurPy, splitPy, strPy, stripPy } from "@elpis/commun";

import { indexPrunedToolOutputs } from "../contexte/compresseur";
import { fitContext, selectPruneKeys } from "../contexte/elagage";
import { measureThinkingTokens, nativeReasoningTokens } from "../llm/jetons-raisonnement";
import { currentEngine } from "../llm/moteurs";
import { llmErrorUserMessage, LLMFailure } from "../llm/reprises";
import { noterObservation } from "../llm/sonde-moteur";
import { journal } from "../journal";
import type { Dict } from "../python";
import { stripToolCallMarkup } from "./analyse-appels";
import { extractThinking } from "./chat-commun";
import { emit } from "./evenements";
import { calculateMetrics } from "./metriques";
import { logMetric, portVisionBureau, recordTurnUsage } from "./ports";
import { reconcileThinkingContent } from "./reconciliation-raisonnement";
import type { ResumeState } from "./reprise";
import { clipThinkingHistory, contentText } from "./run";
import type { LoopDeps, RunContext, RunRecord } from "./run";
import type { LiveText } from "./texte-direct";

const log = journal("boucle.sortie");

export const MARKUP_ONLY_REPLY =
  "Ma dernière réponse était une tentative d'appel d'outil mal formée, qui n'a pas pu être exécutée. Relancez la " +
  "demande, au besoin en la reformulant.";

export const MAX_STEPS_WRAPUP =
  "[SYSTEM] MAXIMUM STEPS REACHED. The step budget for this task is exhausted and tools are disabled for this turn. " +
  "Respond with TEXT ONLY: state that the step limit was reached, summarize concisely what was actually accomplished " +
  "(real results only), list what remains to be done, and recommend the next action. Do not attempt any tool call.";

export const WRAPUP_BY_KIND: Readonly<Record<string, string>> = {
  wallclock:
    "[SYSTEM] TIME BUDGET REACHED. The wall-clock budget for this task ran out (the step budget was NOT exhausted) " +
    "and tools are disabled for this turn. Respond with TEXT ONLY: state that the time limit was reached, summarize " +
    "concisely what was actually accomplished (real results only), list what remains to be done, and recommend the " +
    "next action. Do not attempt any tool call.",
  ctx_saturated:
    "[SYSTEM] CONTEXT SATURATED. Your tool calls kept being cut off mid-emission, so the loop stopped (the step " +
    "budget was NOT exhausted). Tools are disabled for this turn. Respond with TEXT ONLY: state that the context " +
    "filled up, summarize concisely what was actually accomplished (real results only), list what remains to be " +
    "done, and recommend the next action — restarting from a fresh, narrower request is usually the fix. Do not " +
    "attempt any tool call.",
  gen_cap:
    "[SYSTEM] OUTPUT LENGTH LIMIT. Your tool calls kept being cut off by the generation length limit (the context " +
    "window is NOT full and the step budget was NOT exhausted), so the loop stopped. Tools are disabled for this " +
    "turn. Respond with TEXT ONLY: state that the tool calls were too long for the output limit, summarize concisely " +
    "what was actually accomplished (real results only), list what remains to be done, and recommend the next action " +
    "— split large writes into several smaller calls. Do not attempt any tool call.",
  hard:
    "[SYSTEM] TOO MANY FAILED STEPS. The loop stopped on its failed-iteration guard, not on the step budget: too many " +
    "tool calls in a row returned errors. Tools are disabled for this turn. Respond with TEXT ONLY: state that the " +
    "run was stopped after repeated tool failures, quote the decisive error, summarize what was actually accomplished " +
    "(real results only), list what remains, and recommend the next action. Do not attempt any tool call.",
};

export type SortieRun = [string, Dict[], Dict];

/** Forme de comparaison d'un raisonnement : blancs repliés. */
export function normThinking(text: unknown): string {
  return splitPy(strPy(text || "")).join(" ");
}

function modeleDe(ctx: RunContext): string {
  return ctx.c.model || config.LLAMA_MODEL;
}

function effacerCapture(ctx: RunContext): void {
  try {
    portVisionBureau()?.clearLastScreenshotFor(`${ctx.c.username}:${ctx.c.chatKeySuffix}`);
  } catch (e) {
    log.debug(`capture non libérée : ${String(e)}`);
  }
}

/** Élagage de fin de tour : marques du run et de la passe finale, émises en `prune_state` (best-effort, l'annulation remonte). */
async function elagageFinDeTour(ctx: RunContext, rec: RunRecord, workingMessages: Dict[]): Promise<void> {
  const { onEvent, signal } = ctx.c;
  try {
    const nouvelles = await rec.guardCancel(
      onEvent,
      selectPruneKeys(workingMessages, {
        ctxSize: rec.ctxSize,
        modelId: modeleDe(ctx) || null,
        alreadyMarked: rec.runPruneKeys,
        signal,
      }),
      signal,
    );
    const fraiches = nouvelles.filter((k) => !rec.runPruneKeys.has(k));
    if (fraiches.length && !ctx.c.ephemeral)
      await rec.guardCancel(
        onEvent,
        indexPrunedToolOutputs(workingMessages, fraiches, strPy(ctx.c.username), ctx.c.chatId),
        signal,
      );
    const toutes = [...rec.pruneKeysNew, ...fraiches];
    if (toutes.length)
      await rec.guardCancel(onEvent, emit(onEvent, { type: "prune_state", keys: toutes }), signal);
  } catch (e) {
    if (estErreurAnnulation(e) || signal?.aborted) throw e;
    log.debug(`[run_chat_multi_mcp] select_prune_keys a échoué (best-effort) : ${String(e)}`);
  }
}

function usageCumule(rec: RunRecord): Dict {
  return {
    cache_read_input_tokens: rec.cumulCacheRead,
    cache_creation_input_tokens: rec.cumulCacheCreation,
    tool_input_tokens: rec.cumulToolIn,
  };
}

function mesurerRaisonnement(ctx: RunContext, rec: RunRecord, texte: string): Promise<[number, boolean]> {
  return rec.guardCancel(
    ctx.c.onEvent,
    measureThinkingTokens(texte, {
      modelId: modeleDe(ctx),
      usage: rec.cumulReasoning !== null ? { reasoning_tokens: rec.cumulReasoning } : null,
      outputTokens: rec.cumulOut,
    }),
    ctx.c.signal,
  );
}

/** Réponse finale (aucun appel d'outil) : contenu et raisonnement nettoyés, réponse piégée promue, queue émise, métriques et usage. */
export async function finishOk(
  ctx: RunContext,
  rec: RunRecord,
  resume: ResumeState,
  workingMessages: Dict[],
  o: {
    live: LiveText;
    msg: Dict;
    rawText: string;
    finish: unknown;
    iterThinking: string;
    iteration: number;
    effectiveIter: number;
  },
): Promise<SortieRun> {
  const { onEvent, username, startTime, signal } = ctx.c;
  const coupe = strPy(o.finish || "") === "length";
  const streame = o.live.parts.join("");
  const raisonnementFinal = stripPy(strPy(o.msg["reasoning_content"] || ""));
  let finalThinking: string;
  let finalClean: string;
  if (raisonnementFinal) [finalThinking, finalClean] = [raisonnementFinal, o.rawText];
  else
    [finalThinking, finalClean] = o.rawText
      ? extractThinking(o.rawText, { truncated: coupe })
      : ["", o.rawText];
  if (finalThinking && !new Set(rec.allThinking.map(normThinking)).has(normThinking(finalThinking))) {
    rec.allThinking.push(finalThinking);
    clipThinkingHistory(rec.allThinking);
    await emit(onEvent, { type: "thinking_content", text: finalThinking });
  }
  if (streame) {
    const [stThink, stClean] = extractThinking(streame, { truncated: coupe });
    if (stThink) noterObservation(currentEngine(), "reflexion_en_ligne");
    if (stThink && !new Set(rec.allThinking.map(normThinking)).has(normThinking(stThink))) {
      rec.allThinking.push(stThink);
      clipThinkingHistory(rec.allThinking);
    }
    finalClean = stClean || finalClean || o.rawText || "";
  } else finalClean = finalClean || o.rawText || "";
  const avantNettoyage = finalClean;
  finalClean = stripToolCallMarkup(finalClean);
  if (finalClean !== avantNettoyage) noterObservation(currentEngine(), "outils_en_texte");
  if (finalClean !== avantNettoyage)
    log.warn(
      `[run_chat_multi_mcp] markup d'appel d'outil nettoyé du flux final (iter ${o.iteration}, model=${modeleDe(ctx)}) — le modèle a émis un tool call en TEXTE non capté par le canal natif. Vérifier que llama-server tourne avec --jinja + un chat template tool-aware.`,
    );
  let allThinkingText = rec.allThinking.join("\n\n");
  let truncatedInThink = false;
  if (!stripPy(finalClean || "") && stripPy(o.iterThinking || "")) {
    let [, promu] = reconcileThinkingContent(o.iterThinking, finalClean, {
      hadToolCalls: false,
      finish: strPy(o.finish || ""),
    });
    if (promu) promu = stripToolCallMarkup(promu);
    if (promu) {
      finalClean = promu;
      if (rec.allThinking.length && rec.allThinking[rec.allThinking.length - 1] === o.iterThinking)
        rec.allThinking.pop();
      allThinkingText = rec.allThinking.join("\n\n");
      await emit(onEvent, { type: "thinking_content", text: "" });
      log.warn(
        `[run_chat_multi_mcp] réponse finale piégée dans le thinking — promue en réponse visible (chars=${longueurPy(finalClean)}, iter ${o.iteration}).`,
      );
    } else {
      truncatedInThink = true;
      log.warn(
        `[run_chat_multi_mcp] raisonnement non promu en réponse (finish=${strPy(o.finish || "")}, ${longueurPy(o.iterThinking || "")} chars) — thinking gardé, Continuer armé (iter ${o.iteration}).`,
      );
    }
  }
  if (!stripPy(finalClean || "") && !truncatedInThink && stripPy(avantNettoyage || "")) {
    log.warn(
      `[run_chat_multi_mcp] réponse finale réduite à du balisage d'appel d'outil non exécutable (iter ${o.iteration}) — message de repli rendu à la place du brut.`,
    );
    finalClean = MARKUP_ONLY_REPLY;
  }
  if (finalClean && onEvent) {
    try {
      await o.live.emitRest(finalClean, { replaceOnDivergence: true });
    } catch (e) {
      if (estErreurAnnulation(e) || signal?.aborted) await rec.emitPartialSnapshot(onEvent);
      throw e;
    }
  }
  const timings = ((rec.lastRaw["timings"] || {}) as Dict) ?? {};
  const [thinkTok, thinkEst] = await mesurerRaisonnement(ctx, rec, allThinkingText);
  const metrics = calculateMetrics(
    {
      usage: {
        prompt_tokens: rec.cumulIn,
        completion_tokens: rec.cumulOut,
        cache_read_input_tokens: rec.cumulCacheRead,
        cache_creation_input_tokens: rec.cumulCacheCreation,
        tool_input_tokens: rec.cumulToolIn,
      },
      timings,
      model: modeleDe(ctx),
      thinking: allThinkingText,
      thinking_tokens: thinkTok,
      thinking_tokens_estimated: thinkEst,
    },
    Date.now() / 1000 - startTime,
  );
  Object.assign(metrics, { input_tokens: rec.cumulIn, output_tokens: rec.cumulOut });
  metrics["submitted_input_tokens"] = rec.cumulIn;
  metrics["iterations"] = o.effectiveIter;
  metrics["finish_reason"] = o.finish;
  metrics["truncated"] = Boolean(o.finish === "length" && (stripPy(finalClean || "") || truncatedInThink));
  metrics["truncated_in_think"] = truncatedInThink;
  metrics["think_resumes"] = resume.thinkCount;
  if (resume.contentCount) metrics["content_resumes"] = resume.contentCount;
  const dernier = (rec.lastRaw["usage"] || {}) as Dict;
  metrics["last_prompt_tokens"] = Object.hasOwn(dernier, "prompt_tokens") ? dernier["prompt_tokens"] : 0;
  metrics["last_completion_tokens"] = Object.hasOwn(dernier, "completion_tokens")
    ? dernier["completion_tokens"]
    : 0;
  if (allThinkingText) metrics["thinking"] = allThinkingText;

  const modeleReel = strPy(metrics["model"] || modeleDe(ctx));
  recordTurnUsage({
    model: modeleReel,
    path: "tools",
    inputTokens: rec.cumulIn,
    outputTokens: rec.cumulOut,
    submittedTokens: rec.cumulIn,
    thinkingTokens: thinkTok,
    usage: usageCumule(rec),
    durationMs: Math.trunc((Date.now() / 1000 - startTime) * 1000),
    iterations: o.effectiveIter,
    status: "ok",
  });
  rec.usageNote({ effectiveIter: o.effectiveIter, model: modeleDe(ctx), recorded: true });
  const mode = ctx.c.slot?.mode ?? "classic";
  logMetric("write_tps", Number(metrics["write_tps"] ?? 0), { model: modeleReel });
  logMetric("llm_latency", Date.now() / 1000 - startTime, { model: modeleReel });
  logMetric("llm_scheduling_mode", 1, { model: modeleReel, mode, user: username });
  logMetric("llm_tool_iterations", o.effectiveIter, { model: modeleReel, mode });
  effacerCapture(ctx);
  const historique = rec.deltaSnapshot();
  if (historique.length) {
    metrics["tool_history"] = historique;
    metrics["tool_history_delta"] = true;
  }
  await elagageFinDeTour(ctx, rec, workingMessages);
  return [finalClean, rec.events, metrics];
}

export interface CausesArret {
  effectiveIter: number;
  hardIter: number;
  wallclockStop: boolean;
  ctxSaturatedStop: boolean;
  genCapStop: boolean;
  cycleHardStopped: boolean;
  emptyChoicesStop: boolean;
}

/** Sortie sans réponse finale : cause réelle, `tool_limit`, tour de synthèse sans outils, filets de message, métriques et usage. */
export async function finishOnLimit(
  ctx: RunContext,
  rec: RunRecord,
  resume: ResumeState,
  deps: LoopDeps,
  workingMessages: Dict[],
  a: CausesArret,
): Promise<SortieRun> {
  const { onEvent, model, username, chatId, samplingOverride, toolsPayload, startTime, signal } = ctx.c;
  const budget = ctx.c.effectiveIterBudget;
  const capDur = ctx.c.hardIterCap;
  const cause = a.wallclockStop
    ? "wallclock"
    : a.ctxSaturatedStop
      ? "ctx_saturated"
      : a.genCapStop
        ? "gen_cap"
        : a.cycleHardStopped
          ? "cycle"
          : a.emptyChoicesStop
            ? "empty_choices"
            : a.effectiveIter >= budget
              ? "steps"
              : "hard";
  const genre = cause === "hard" ? "hard" : "effective";
  if (cause === "steps")
    log.warn(
      `[run_chat_multi_mcp] Limite EFFECTIVE atteinte : ${a.effectiveIter} itérations productives sur ${a.hardIter} total (budget ${budget}, hard cap ${capDur}).`,
    );
  else if (cause === "hard")
    log.warn(
      `[run_chat_multi_mcp] Limite HARD atteinte (boucle improductive) : ${a.hardIter}/${capDur} hard, seulement ${a.effectiveIter}/${budget} effectives — modèle probablement coincé sur des appels d'outil échoués en cascade.`,
    );
  else
    log.warn(
      `[run_chat_multi_mcp] Sortie forcée (${cause}) : ${a.effectiveIter}/${budget} itérations productives, ${a.hardIter}/${capDur} dures — budget d'étapes NON épuisé.`,
    );
  const appelsFaits = rec.runToolHistory.filter((m) => m["role"] === "tool").length;
  await emit(onEvent, {
    type: "tool_limit",
    iterations: a.effectiveIter,
    effective_iterations: a.effectiveIter,
    hard_iterations: a.hardIter,
    hard_iterations_max: capDur,
    max_iterations: ctx.c.maxIter,
    tool_calls_done: appelsFaits,
    reason: a.emptyChoicesStop ? "empty_choices" : "max_iter_reached",
    limit_kind: genre,
    stop_reason: cause,
  });

  let synthese = "";
  let syntheseCoupee = false;
  const consigne =
    (WRAPUP_BY_KIND[cause] ?? MAX_STEPS_WRAPUP) + (ctx.c.wrapupSuffix ? `\n${ctx.c.wrapupSuffix}` : "");
  let dernierUsage: Dict = { ...((rec.lastRaw["usage"] || {}) as Dict) };
  if (!a.cycleHardStopped && appelsFaits > 0 && !(ctx.c.isCancelled && ctx.c.isCancelled())) {
    try {
      const outilsTok = rec.toolsTokCounted ? intPy(rec.toolsTokCounted[0]) : 0;
      const msgs = await fitContext([...workingMessages, { role: "user", content: consigne }], {
        ctxSize: rec.ctxSize,
        modelId: modeleDe(ctx) || null,
        thinkingMode: false,
        toolsFixedTokens: outilsTok,
        statsOut: {},
        dropFloor: rec.budgetDropFloor,
        pruneKeys: rec.runPruneKeys,
        signal,
      });
      const brut = await ctx.appelLLM(() =>
        deps.stream(msgs, toolsPayload, {
          modelOverride: model,
          userId: username,
          onContentToken: () => undefined,
          isCancelled: ctx.c.isCancelled,
          signal,
          samplingOverride,
          thinkingMode: false,
          chatId,
          ...ctx.optionsSlot(),
          toolChoice: "none",
        }),
      );
      const usage = (brut["usage"] || {}) as Dict;
      if (intPy(usage["prompt_tokens"] || 0) > 0) dernierUsage = { ...usage };
      rec.cumulIn += Number(usage["prompt_tokens"] ?? 0);
      rec.cumulOut += Number(usage["completion_tokens"] ?? 0);
      rec.cumulCacheRead += intPy(usage["cache_read_input_tokens"] || 0);
      rec.cumulCacheCreation += intPy(usage["cache_creation_input_tokens"] || 0);
      rec.noteToolInput(msgs, toolsPayload, modeleDe(ctx), usage["prompt_tokens"] ?? 0);
      rec.usageNote({ effectiveIter: a.effectiveIter, model: modeleDe(ctx) });
      const rsn = nativeReasoningTokens(usage);
      if (rsn !== null) rec.cumulReasoning = (rec.cumulReasoning ?? 0) + rsn;
      const choix = ((Array.isArray(brut["choices"]) && brut["choices"].length ? brut["choices"] : [{}])[0] ||
        {}) as Dict;
      const msg = (choix["message"] || {}) as Dict;
      syntheseCoupee = Boolean(brut["partial"] || strPy(choix["finish_reason"] || "") === "length");
      const [pensee, texte] = extractThinking(stripPy(contentText(msg["content"])));
      if (pensee) {
        rec.allThinking.push(pensee);
        clipThinkingHistory(rec.allThinking);
      }
      synthese = stripPy(stripToolCallMarkup(texte));
      if (synthese && onEvent) await emit(onEvent, { type: "content_token", text: synthese });
    } catch (e) {
      if (estErreurAnnulation(e) || signal?.aborted) {
        await rec.emitPartialSnapshot(onEvent);
        throw e;
      }
      log.warn(
        `[run_chat_multi_mcp] tour de synthèse max-steps échoué (${String(e).slice(0, 160)}) — retour au partiel historique`,
      );
      synthese = "";
    }
  }

  let partiel = synthese;
  if (!partiel) partiel = stripPy(resume.pendingContent || "") || rec.lastAssistantText();
  if (partiel) partiel = stripToolCallMarkup(partiel);
  const vide = (): boolean => !stripPy(partiel || "");
  if (a.cycleHardStopped && vide())
    partiel =
      "Je me suis arrêté : la même action s'est répétée plusieurs fois sans que l'écran change (boucle détectée). " +
      "Vérifie l'état réel de la cible (fenêtre active, élément réellement cliquable), puis dis-moi comment procéder.";
  if (a.ctxSaturatedStop && vide())
    partiel =
      "Le contexte du modèle est saturé : mes appels d'outils ont été coupés plusieurs fois de suite, je m'arrête pour " +
      "préserver la conversation. Compactez la conversation ou ouvrez un nouveau chat pour continuer.";
  if (a.genCapStop && vide())
    partiel =
      "Mes appels d'outils ont été coupés plusieurs fois de suite par le plafond de génération — le contexte, lui, " +
      "n'est pas plein. Je m'arrête pour ne pas boucler. Relancez avec « Reprendre » en demandant des écritures plus " +
      "courtes (plusieurs appels), ou relevez max_tokens dans les réglages de génération.";
  if (a.emptyChoicesStop && vide())
    partiel =
      "Le moteur a renvoyé plusieurs réponses vides d'affilée : je m'arrête pour ne pas boucler. Le travail déjà " +
      "effectué est conservé — relancez avec « Continuer ».";
  if (vide()) {
    const outils = appelsFaits ? ` ${appelsFaits} appel(s) d'outil ont abouti.` : "";
    const constat = a.wallclockStop
      ? "J'ai atteint le budget de temps de la tâche"
      : genre === "hard"
        ? `Je me suis arrêté après trop d'appels d'outils en échec d'affilée (${a.hardIter} tentatives pour seulement ${a.effectiveIter} tour(s) utile(s))`
        : `J'ai atteint la limite d'itérations d'outils (${a.effectiveIter}/${ctx.c.maxIter} tours)`;
    const suite =
      "Le travail n'est pas terminé : utilisez « Reprendre » pour continuer là où je me suis arrêté" +
      (genre === "hard" ? "." : ", ou augmentez le budget d'itérations dans les réglages de génération.");
    partiel = `${constat} avant de pouvoir rédiger ma réponse.${outils} ${suite}`;
  }
  const metrics: Dict = {
    tool_limit_reached: true,
    tool_limit_iters: a.hardIter,
    tool_limit_effective_iters: a.effectiveIter,
    tool_limit_max: ctx.c.maxIter,
    tool_limit_calls: appelsFaits,
    tool_limit_kind: genre,
    tool_limit_stop_reason: cause,
    max_steps_wrapup: Boolean(synthese),
    last_prompt_tokens: intPy(dernierUsage["prompt_tokens"] || 0),
    last_completion_tokens: intPy(dernierUsage["completion_tokens"] || 0),
    input_tokens: rec.cumulIn,
    submitted_input_tokens: rec.cumulIn,
    output_tokens: rec.cumulOut,
    ...(rec.cumulCacheRead ? { cache_read_input_tokens: rec.cumulCacheRead } : {}),
    ...(rec.cumulCacheCreation ? { cache_creation_input_tokens: rec.cumulCacheCreation } : {}),
    ...(rec.cumulToolIn ? { tool_input_tokens: rec.cumulToolIn } : {}),
  };
  const pensees = rec.allThinking.length ? rec.allThinking.join("\n\n") : "";
  const [thinkTok, thinkEst] = await mesurerRaisonnement(ctx, rec, pensees);
  metrics["thinking_tokens"] = thinkTok;
  metrics["response_tokens"] = Math.max(0, rec.cumulOut - thinkTok);
  metrics["thinking_tokens_estimated"] = thinkEst;
  if (rec.allThinking.length) metrics["thinking"] = pensees;
  if (a.ctxSaturatedStop) metrics["context_saturated"] = true;
  if (a.genCapStop) metrics["gen_cap_stop"] = true;
  if (synthese && syntheseCoupee) {
    metrics["truncated"] = true;
    metrics["max_steps_wrapup_truncated"] = true;
  }
  if (a.emptyChoicesStop) {
    metrics["empty_choices_stop"] = true;
    metrics["truncated"] = true;
  }
  const historique = rec.deltaSnapshot();
  if (historique.length) {
    metrics["tool_history"] = historique;
    metrics["tool_history_delta"] = true;
  }
  await elagageFinDeTour(ctx, rec, workingMessages);
  effacerCapture(ctx);
  recordTurnUsage({
    model: modeleDe(ctx),
    path: "tools",
    inputTokens: rec.cumulIn,
    outputTokens: rec.cumulOut,
    submittedTokens: rec.cumulIn,
    thinkingTokens: thinkTok,
    usage: usageCumule(rec),
    durationMs: Math.trunc((Date.now() / 1000 - startTime) * 1000),
    iterations: a.effectiveIter,
    status: "tool_limit",
    errorKind: genre,
  });
  rec.usageNote({ effectiveIter: a.effectiveIter, model: modeleDe(ctx), recorded: true });
  return [partiel, rec.events, metrics];
}

function nomErreur(e: unknown): string {
  if (e instanceof Error) return e.name === "Error" ? "RuntimeError" : e.name;
  return typeof e;
}

/** Sortie d'erreur (appel LLM en échec après les récupérations) : `error` actionnable, partiel du run, métriques et usage. */
export async function finishOnError(
  ctx: RunContext,
  rec: RunRecord,
  resume: ResumeState,
  o: {
    error: unknown;
    errKind: string | null;
    live: LiveText;
    thinkingParts: string[];
    iteration: number;
    effectiveIter: number;
    hardIter: number;
  },
): Promise<SortieRun> {
  const { onEvent, startTime } = ctx.c;
  const budget = ctx.c.effectiveIterBudget;
  const e = o.error;
  const texte = e instanceof LLMFailure ? e.message : llmErrorUserMessage(e);
  const detail =
    e instanceof LLMFailure
      ? e.detail
      : `${nomErreur(e)}: ${Array.from(e instanceof Error ? e.message : strPy(e))
          .slice(0, 300)
          .join("")}`;
  await emit(onEvent, {
    type: "error",
    text: `${texte} La réponse partielle est conservée.`,
    detail,
    kind: o.errKind,
    iteration: `${Math.min(o.effectiveIter + 1, budget)}/${budget}`,
    hard_iteration: `${o.hardIter + 1}/${ctx.c.hardIterCap}`,
  });
  let partiel = stripPy((resume.pendingContent || "") + o.live.parts.join(""));
  if (!partiel) partiel = rec.lastAssistantText();
  if (partiel) partiel = stripToolCallMarkup(partiel);
  const dernier = (rec.lastRaw["usage"] || {}) as Dict;
  const metrics: Dict = {
    input_tokens: rec.cumulIn,
    submitted_input_tokens: rec.cumulIn,
    output_tokens: rec.cumulOut,
    last_prompt_tokens: intPy(dernier["prompt_tokens"] || 0),
    last_completion_tokens: intPy(dernier["completion_tokens"] || 0),
    model: modeleDe(ctx),
    iterations: o.effectiveIter,
    tool_iterations: o.iteration,
    ended_with_error: true,
    thinking: [...rec.allThinking, o.thinkingParts.join("")].filter((p) => p).join("\n\n"),
    truncated: Boolean(partiel),
  };
  const historique = rec.deltaSnapshot();
  if (historique.length) {
    metrics["tool_history"] = historique;
    metrics["tool_history_delta"] = true;
  }
  if (rec.pruneKeysNew.length) await emit(onEvent, { type: "prune_state", keys: [...rec.pruneKeysNew] });
  effacerCapture(ctx);
  let thinkTok = 0;
  try {
    [thinkTok] = await mesurerRaisonnement(ctx, rec, rec.allThinking.join("\n\n"));
  } catch (err) {
    if (estErreurAnnulation(err) || ctx.c.signal?.aborted) throw err;
    log.debug(`measure_thinking_on_error : ${String(err)}`);
  }
  recordTurnUsage({
    model: modeleDe(ctx),
    path: "tools",
    inputTokens: rec.cumulIn,
    outputTokens: rec.cumulOut,
    submittedTokens: rec.cumulIn,
    thinkingTokens: thinkTok,
    usage: usageCumule(rec),
    durationMs: Math.trunc((Date.now() / 1000 - startTime) * 1000),
    iterations: o.effectiveIter,
    status: "aborted",
    errorKind: strPy(o.errKind || nomErreur(e)),
  });
  rec.usageNote({ effectiveIter: o.effectiveIter, model: modeleDe(ctx), recorded: true });
  return [partiel, rec.events, metrics];
}
