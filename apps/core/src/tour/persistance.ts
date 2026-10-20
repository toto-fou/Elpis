// SPDX-License-Identifier: MIT
/** apps/core/src/tour/persistance.ts — enregistrement du tour : message assistant complet ou partiel (fusion d'un « Continuer »), écriture optimiste sur `updated_at` avec reprise du conflit bénin, décisions de méta de fin de tour (chatbot_app/turn/persistence.py). */
import {
  arrondiPy,
  egalPy,
  estChiffresPy,
  estDict,
  floatPy,
  FlottantPy,
  intPy,
  stripPy,
  strPy,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { SourceCiteeRag } from "@elpis/contracts";

import { clipResumeThinking } from "../boucle/reprise-raisonnement";
import { estCleArguments, userSuffixSig } from "../contexte/elagage";
import { journal } from "../journal";
import { marquerCiteesRag, sourcesRagPropres } from "../rag/sources-message";
import {
  CANCEL_PLACEHOLDER,
  mergeContinueToolHistory,
  mergePrevSegmentLists,
  splitForContinue,
  taskRunsForPersist,
  troncPourReprise,
} from "./historique";

const log = journal("uvicorn.error");

export const CONTINUE_ADDITIVE_METRICS = [
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "response_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "submitted_input_tokens",
  "iterations",
  "duration",
] as const;

/** `isinstance(v, (int, float))` (booléens compris) → `[valeur, flottant ?]`, `null` sinon. */
function nombre(v: unknown): [number, boolean] | null {
  if (typeof v === "boolean") return [v ? 1 : 0, false];
  if (v instanceof FlottantPy) return [v.valeur, true];
  if (typeof v === "number") return [v, !Number.isInteger(v)];
  return null;
}

/** Métriques d'un message prolongé par « Continuer » : la bulle montre le total de ses segments. */
export function mergeContinueMetrics(prev: unknown, cur: Dict): Dict {
  if (!estDict(prev) || !Object.keys(prev).length) return { ...cur };
  const out: Dict = { ...cur };
  for (const k of CONTINUE_ADDITIVE_METRICS) {
    const [a, b] = [nombre(prev[k]), nombre(cur[k])];
    if (a === null && b === null) continue;
    const total = (a?.[0] ?? 0) + (b?.[0] ?? 0);
    if (k !== "duration") out[k] = Math.trunc(total);
    else out[k] = a?.[1] || b?.[1] ? versFlottantPy(arrondiPy(total, 2)) : total;
  }
  if (veritePy(prev["thinking_tokens_estimated"])) out["thinking_tokens_estimated"] = true;
  out["segments"] = intPy(veritePy(prev["segments"]) ? prev["segments"] : 1) + 1;
  return out;
}

/** Écriture d'un chat : vrai si écrit, faux sur conflit de la garde optimiste, `null` en session éphémère. */
export type Persister = (
  uid: number,
  chatId: string,
  title: string,
  messages: unknown[],
  updatedAt: number,
  expectedUpdatedAt: number | null,
) => Promise<boolean | null>;

export interface BaseOptimiste {
  readonly baselineUpdatedAt: unknown;
  readonly baselineMessages: unknown;
  readonly baselineTitle: string;
  readonly readChat: (uid: number, chatId: string) => Promise<Dict | null>;
}

const instant = (v: unknown): number | null => (v === null || v === undefined ? null : floatPy(v));

/** Écriture sous garde optimiste ; un conflit sans nouveau message (renommage) est réécrit sur la nouvelle base, titre choisi entre-temps gardé. */
export async function persistTurn(
  persist: Persister,
  uid: number,
  chatId: string,
  title: string,
  messages: unknown[],
  b: BaseOptimiste,
): Promise<[boolean | null, string]> {
  let ret = await persist(uid, chatId, title, messages, Date.now() / 1000, instant(b.baselineUpdatedAt));
  if (ret !== false || b.baselineUpdatedAt === null || b.baselineUpdatedAt === undefined) return [ret, title];
  let current: Dict | null;
  try {
    current = await b.readChat(uid, chatId);
  } catch (e) {
    log.warn(
      `[chat_stream] relecture après conflit échouée chat=${Array.from(chatId).slice(0, 12).join("")} : ${String(e)}`,
    );
    return [false, title];
  }
  if (!current) {
    log.info(
      `[chat_stream] chat supprimé pendant le tour, non recréé chat=${Array.from(chatId).slice(0, 12).join("")}`,
    );
    return [false, title];
  }
  if (!egalPy(current["messages"] ?? null, b.baselineMessages ?? null)) return [false, title];
  const stocke = stripPy(strPy(veritePy(current["title"]) ? current["title"] : ""));
  if (stocke && stocke !== stripPy(b.baselineTitle || "")) title = stocke;
  log.info(
    `[chat_stream] conflit bénin (chat modifié sans nouveau message, ex. renommage) chat=${Array.from(chatId).slice(0, 12).join("")} — réécriture sur la nouvelle base`,
  );
  ret = await persist(uid, chatId, title, messages, Date.now() / 1000, instant(current["updated_at"]));
  return [ret, title];
}

/** Mode plan ONE-SHOT : le tour abouti, persisté, hors session éphémère et non tronqué coupe le mode. */
export function planModeShouldEnd(
  planMode: boolean,
  persisted: boolean,
  ephemeral: boolean,
  metrics: Dict | null | undefined,
): boolean {
  if (!planMode || !persisted || ephemeral) return false;
  if (metrics && (veritePy(metrics["truncated"]) || veritePy(metrics["tool_limit_reached"]))) return false;
  return true;
}

export interface AccumulateursTour {
  readonly execId: string;
  readonly taskUsage: Dict;
  readonly filesChanged: ReadonlyMap<string, Dict>;
  readonly compactions: readonly Dict[];
  readonly msgs: Dict[];
  readonly isContinue: boolean;
  readonly toolImages?: readonly unknown[] | null | undefined;
  /** Passages numérotés par les outils `rag_*` pendant le tour (sources du message). */
  readonly ragSources?: readonly SourceCiteeRag[] | null | undefined;
}

function champsDuTour(msg: Dict, a: AccumulateursTour): void {
  if (veritePy(a.taskUsage["runs"])) msg["task_runs"] = taskRunsForPersist(a.taskUsage["runs"]);
  if (a.filesChanged.size) msg["files_changed"] = [...a.filesChanged.values()];
  if (a.compactions.length) msg["compactions"] = [...a.compactions];
  if (a.toolImages?.length) msg["tool_images"] = [...a.toolImages];
  if (a.ragSources?.length) msg["rag_sources"] = [...a.ragSources];
}

/** Sources du message marquées d'après sa réponse finale (renvois `[n]`). */
function marquerSources(msg: Dict): void {
  if (Array.isArray(msg["rag_sources"]))
    msg["rag_sources"] = marquerCiteesRag(sourcesRagPropres(msg["rag_sources"]), msg["content"]);
}

/** Message assistant du tour COMPLET : `[message, avant, après, contenu]`, `avant + [message] + après` étant la conversation à persister. */
export function messageAssistant(
  assistant: string,
  thinkingText: string,
  metrics: Dict | null | undefined,
  a: AccumulateursTour & { readonly ctxSnap: Dict | null; readonly pruneKeys: readonly unknown[] },
): [Dict, Dict[], Dict[], string] {
  const msg: Dict = { role: "assistant", content: assistant, run_ids: [a.execId] };
  const avecMetriques = estDict(metrics) && Object.keys(metrics).length > 0;
  if (avecMetriques) {
    const m: Dict = {};
    for (const [k, v] of Object.entries(metrics)) if (k !== "tool_history" && k !== "thinking") m[k] = v;
    if (a.ctxSnap)
      m["kv_cache"] = { used: a.ctxSnap["used"], total: a.ctxSnap["total"], pct: a.ctxSnap["pct"] };
    msg["metrics"] = m;
  }
  if (thinkingText) msg["thinking"] = thinkingText;
  if (avecMetriques && veritePy(metrics["truncated_in_think"]) && thinkingText) {
    msg["resume_thinking"] = clipResumeThinking(thinkingText);
    msg["thinkingTruncated"] = true;
  }
  if (avecMetriques && veritePy(metrics["tool_history"])) {
    msg["tool_history"] = metrics["tool_history"];
    if (veritePy(metrics["tool_history_delta"])) msg["tool_history_delta"] = true;
  }
  champsDuTour(msg, a);
  const sorties = a.pruneKeys.filter((k) => !estCleArguments(k)).length;
  if (sorties) msg["pruned"] = sorties;
  let avant = a.msgs;
  let apres: Dict[] = [];
  const [prev, debut, fin]: [Dict, Dict[], Dict[]] = a.isContinue
    ? splitForContinue(a.msgs)
    : [{}, a.msgs, []];
  if (Object.keys(prev).length) {
    [avant, apres] = [debut, fin];
    msg["content"] = troncPourReprise(prev) + assistant;
    const mth = mergeContinueToolHistory(prev, msg["tool_history"], veritePy(msg["tool_history_delta"]));
    delete msg["tool_history"];
    delete msg["tool_history_delta"];
    Object.assign(msg, mth);
    if (veritePy(msg["metrics"]))
      msg["metrics"] = mergeContinueMetrics(
        veritePy(prev["metrics"]) ? prev["metrics"] : {},
        msg["metrics"] as Dict,
      );
    mergePrevSegmentLists(prev, msg);
    const fusion = (veritePy(prev["thinking"]) ? strPy(prev["thinking"]) : "") + (thinkingText || "");
    if (fusion) msg["thinking"] = fusion;
    if (avecMetriques && veritePy(metrics["truncated_in_think"])) {
      const prevRt = veritePy(prev["resume_thinking"])
        ? prev["resume_thinking"]
        : veritePy(prev["thinking"])
          ? prev["thinking"]
          : "";
      msg["resume_thinking"] = clipResumeThinking(strPy(prevRt) + (thinkingText || ""));
      msg["thinkingTruncated"] = true;
    } else {
      delete msg["resume_thinking"];
      delete msg["thinkingTruncated"];
    }
    assistant = msg["content"] as string;
  }
  if (avecMetriques && veritePy(metrics["tool_limit_reached"])) {
    msg["isTruncated"] = true;
    msg["toolLoopTruncated"] = true;
    const get = (k: string, d: unknown): unknown => (k in metrics ? metrics[k] : d);
    msg["toolLoopStats"] = {
      iterations: get("tool_limit_effective_iters", get("tool_limit_iters", 0)),
      hard_iterations: get("tool_limit_iters", 0),
      max_iterations: get("tool_limit_max", 0),
      tool_calls_done: get("tool_limit_calls", 0),
      stop_reason: veritePy(metrics["tool_limit_stop_reason"]) ? metrics["tool_limit_stop_reason"] : "",
    };
  } else if (avecMetriques && veritePy(metrics["truncated"])) msg["isTruncated"] = true;
  marquerSources(msg);
  return [msg, avant, apres, assistant];
}

/** Partiel d'un tour interrompu, prêt à enregistrer. */
export interface MessagePartiel {
  readonly message: Dict;
  readonly avant: Dict[];
  readonly apres: Dict[];
  readonly texte: string;
  readonly raisonnement: string;
  readonly raisonnementFusionne: string;
  readonly conversation: Dict[];
}

/** Message assistant d'un tour INTERROMPU : prose et raisonnement déjà streamés, historique d'outils capturé, sous-agents, fichiers et jalons. */
export function messagePartiel(
  contentParts: readonly string[],
  thinkingParts: readonly string[],
  partialToolHistory: readonly unknown[],
  a: AccumulateursTour,
): MessagePartiel {
  let partiel = stripPy(contentParts.join(""));
  const raisonnement = stripPy(thinkingParts.join(""));
  let avant = a.msgs;
  let apres: Dict[] = [];
  let raisonnementPrec = "";
  let prev: Dict = {};
  const [pp, bp, ap]: [Dict, Dict[], Dict[]] = a.isContinue ? splitForContinue(a.msgs) : [{}, a.msgs, []];
  if (Object.keys(pp).length) {
    prev = pp;
    [avant, apres] = [bp, ap];
    partiel = troncPourReprise(prev) + partiel;
    if (veritePy(prev["thinking"])) raisonnementPrec = strPy(prev["thinking"]);
  }
  const fusion = raisonnementPrec + (raisonnement || "");
  const msg: Dict = {
    role: "assistant",
    content: partiel || CANCEL_PLACEHOLDER,
    isTruncated: true,
    run_ids: [a.execId],
  };
  if (fusion) msg["thinking"] = fusion;
  if (!partiel && fusion) {
    msg["resume_thinking"] = clipResumeThinking(fusion);
    msg["thinkingTruncated"] = true;
  }
  Object.assign(
    msg,
    mergeContinueToolHistory(prev, partialToolHistory.length ? [...partialToolHistory] : null, true),
  );
  champsDuTour(msg, a);
  if (Object.keys(prev).length) mergePrevSegmentLists(prev, msg);
  marquerSources(msg);
  return {
    message: msg,
    avant,
    apres,
    texte: partiel,
    raisonnement,
    raisonnementFusionne: fusion,
    conversation: [...avant, msg, ...apres],
  };
}

/** Entrée de `llm_user_suffixes` pour la DERNIÈRE question : `[{signature: suffixe ou null}, rang]`, ou `[null, null]` sans changement. */
export function suffixeQuestion(
  messages: readonly Dict[],
  existingChat: Dict | null,
  newUserSuffix: Dict,
): [Dict | null, number | null] {
  const questions = messages.filter((m) => (m ?? {})["role"] === "user");
  if (!questions.length) return [null, null];
  const rang = questions.length - 1;
  const prec = (existingChat ?? {})["llm_user_suffixes"];
  const perime =
    estDict(prec) &&
    Object.keys(prec).some((k) => {
      const tete = k.split(":", 1)[0] ?? "";
      return estChiffresPy(tete) && intPy(tete) >= rang;
    });
  if (veritePy(newUserSuffix["text"]) || perime)
    return [
      {
        [userSuffixSig(rang, questions.at(-1)!["content"] ?? null)]: veritePy(newUserSuffix["text"])
          ? newUserSuffix["text"]
          : null,
      },
      rang,
    ];
  return [null, null];
}
