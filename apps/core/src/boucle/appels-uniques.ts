// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/appels-uniques.ts — appels LLM uniques sans outils (E23) : résumé du compresseur, titre d'un chat neuf, enrichissement d'un prompt d'image. */
import { config } from "@elpis/config";
import {
  CancelledError,
  estErreurAnnulation,
  longueurPy,
  prefixePy,
  splitlinesPy,
  strPy,
  stripPy,
} from "@elpis/commun";
import { neutraliserMarqueursTour } from "@elpis/securite";

import type { LlamaChatFn } from "../contexte/compresseur";
import type { Priorite } from "../llm/ordonnanceur";
import { llmErrorUserMessage, LLMFailure } from "../llm/reprises";
import { journal } from "../journal";
import type { Dict } from "../python";
import { splitOrphanThinkClose } from "./chat-commun";
import { llamaChatWithToolsStream } from "./flux-llm";
import type { SurTexte } from "./flux-llm";
import { fileLlm, recordTurnUsage } from "./ports";
import { reconcileThinkingContent } from "./reconciliation-raisonnement";

const log = journal("boucle.appels-uniques");

/** Affinité de slot llama.cpp d'un run (cf. `OptionsRun`), pour qu'un appel unique le suive. */
export interface AffiniteSlot {
  slotKey?: string | null;
  slotAvoid?: (() => Iterable<number>) | null;
  slotPrefere?: (() => number | null) | null;
  surSlot?: ((slot: number) => void) | null;
}

export interface OptionsAppelUnique extends AffiniteSlot {
  userId?: unknown;
  modelOverride?: string | null;
  samplingOverride?: Dict | null;
  thinkingMode?: boolean;
  chatId?: string | null;
  slotAvoidOwn?: boolean;
  isCancelled?: (() => boolean) | null;
  signal?: AbortSignal | undefined;
  onThinkingToken?: SurTexte;
  onContentToken?: SurTexte;
  usageScope?: string;
}

/** Un appel sans outils (profil `chat`) : `[raisonnement, contenu, méta]` ; une panne rend « ⚠ Erreur LLM: … » sans lever, l'annulation remonte. */
export async function llamaChatStreamTokens(
  messages: readonly unknown[],
  o: OptionsAppelUnique = {},
): Promise<[string, string, Dict]> {
  const debut = performance.now();
  const modele = o.modelOverride || config.LLAMA_MODEL;
  const pensees: string[] = [];
  let reponse: Dict;
  try {
    reponse = await llamaChatWithToolsStream(messages, [], {
      modelOverride: o.modelOverride ?? null,
      userId: o.userId ?? "guest",
      thinkingMode: o.thinkingMode ?? false,
      samplingOverride: o.samplingOverride ?? null,
      chatId: o.chatId ?? null,
      slotAvoidOwn: o.slotAvoidOwn ?? false,
      slotKey: o.slotKey ?? null,
      slotAvoid: o.slotAvoid ?? null,
      slotPrefere: o.slotPrefere ?? null,
      surSlot: o.surSlot ?? null,
      samplingTask: "chat",
      isCancelled: o.isCancelled ?? null,
      signal: o.signal,
      onThinkingToken: async (t) => {
        pensees.push(t);
        if (o.onThinkingToken) await o.onThinkingToken(t);
      },
      onContentToken: o.onContentToken ?? null,
    });
  } catch (e) {
    if (estErreurAnnulation(e) || o.signal?.aborted) throw e;
    const cause = e instanceof LLMFailure ? e.cause : e;
    recordTurnUsage({
      model: modele,
      path: "classic",
      inputTokens: 0,
      outputTokens: 0,
      submittedTokens: 0,
      thinkingTokens: 0,
      usage: {},
      durationMs: Math.trunc(performance.now() - debut),
      iterations: 0,
      status: "error",
      errorKind: cause instanceof Error ? cause.name : "unknown",
      ...(o.usageScope ? { scope: o.usageScope } : {}),
    });
    return ["", `⚠ Erreur LLM: ${llmErrorUserMessage(cause)}`, { usage: {}, timings: {}, error: true }];
  }
  const choix = ((reponse["choices"] as Dict[] | undefined) ?? [{}])[0] ?? {};
  const message = (choix["message"] || {}) as Dict;
  const usage = (reponse["usage"] || {}) as Dict;
  const finish = choix["finish_reason"] ?? "";
  const brut = pensees.join("");
  let pensee = stripPy(brut);
  let contenu = stripPy(strPy(message["content"] || ""));
  let extrait = false;
  if (!brut) {
    const orpheline = splitOrphanThinkClose(contenu);
    if (orpheline !== null) [extrait, pensee, contenu] = [true, stripPy(orpheline[0]), orpheline[1]];
  }
  const contenuVide = !contenu;
  [pensee, contenu] = reconcileThinkingContent(pensee, contenu, {
    inThink: Boolean(reponse["in_think"]),
    hadToolCalls: false,
    finish: strPy(finish || ""),
  });
  const promu = contenuVide && Boolean(contenu);
  if (promu)
    log.warn(
      `réponse piégée dans le raisonnement — promue en réponse visible (chars=${longueurPy(contenu)}).`,
    );
  const partiel = Boolean(reponse["partial"]);
  recordTurnUsage({
    model: modele,
    path: "classic",
    inputTokens: Number(usage["prompt_tokens"] ?? 0),
    outputTokens: Number(usage["completion_tokens"] ?? 0),
    submittedTokens: Number(usage["prompt_tokens"] ?? 0),
    thinkingTokens: 0,
    usage,
    durationMs: Math.trunc(performance.now() - debut),
    iterations: 1,
    status: partiel ? "aborted" : "ok",
    ...(o.usageScope ? { scope: o.usageScope } : {}),
  });
  const meta: Dict = {
    usage,
    timings: reponse["timings"] || {},
    model: modele,
    thinking: pensee,
    finish_reason: finish,
    truncated: finish === "length" || partiel,
    thinking_promoted: promu,
    thinking_extracted: extrait && !promu,
    truncated_in_think: Boolean(finish === "length" && !contenu && pensee),
  };
  if (partiel) meta["partial"] = true;
  return [pensee, contenu, meta];
}

/** `llama_chat` : `[contenu, méta]`. */
export async function llamaChat(
  messages: readonly unknown[],
  o: OptionsAppelUnique = {},
): Promise<[string, Dict]> {
  const [, contenu, meta] = await llamaChatStreamTokens(messages, o);
  return [contenu, meta];
}

/** Résumé de compaction pour B1-18 : appel unique dans le slot déjà tenu par l'appelant, sur l'affinité de slot du run s'il en a une (sous-agent : sans elle, le serveur choisit et peut prendre le slot du parent ou d'un frère). */
export function compactionAvecSlot(slot: AffiniteSlot = {}): LlamaChatFn {
  return (messages, o) =>
    llamaChat(messages, {
      userId: o.userId,
      modelOverride: o.modelOverride,
      samplingOverride: o.samplingOverride,
      signal: o.signal,
      usageScope: o.usageScope,
      ...slot,
    });
}

export const llamaChatCompaction: LlamaChatFn = compactionAvecSlot();

/** Appel unique HORS d'un tour : dans la file LLM (sa propre admission) quand elle est posée. */
export function horsTour<T>(
  model: string | null,
  priority: Priorite,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const file = fileLlm();
  return file ? file.withLLM(model, priority, signal, () => fn()) : fn();
}

/** Délai de la génération du titre (`asyncio.wait_for(…, timeout=45.0)`). */
export const TITLE_TIMEOUT_S = 45.0;

export const TITLE_PROMPT =
  "You are a title generator. Output ONLY a chat title for the conversation below. A single line, maximum 50 " +
  "characters, in the SAME language as the user message. Keep key technical terms, numbers and filenames. No " +
  "quotes, no trailing punctuation, no emoji. Never answer the question itself.";

function nettoyerBords(s: string, caracteres: string, gauche: boolean): string {
  const ensemble = new Set(Array.from(caracteres));
  const points = Array.from(s);
  let debut = 0;
  let fin = points.length;
  if (gauche) while (debut < fin && ensemble.has(points[debut]!)) debut++;
  while (fin > debut && ensemble.has(points[fin - 1]!)) fin--;
  return points.slice(debut, fin).join("");
}

/** Titre d'un chat neuf (réflexion coupée, température 0,2, 24 jetons, slot du chat évité, 45 s, priorité basse) ; `null` si douteux. */
export async function generateChatTitle(
  selectedModel: string | null,
  firstUserText: string | null,
  assistantText: string | null,
  o: { chatId?: string | null; signal?: AbortSignal | undefined } = {},
): Promise<string | null> {
  const t0 = performance.now();
  try {
    const question = prefixePy(stripPy(firstUserText || ""), 600);
    if (!question) return null;
    const reponse = prefixePy(stripPy(assistantText || ""), 240);
    const msgs = [
      { role: "system", content: TITLE_PROMPT },
      {
        role: "user",
        content: neutraliserMarqueursTour(
          question + (reponse ? `\n\n[the assistant's reply was about: ${reponse}]` : ""),
        ),
      },
    ];
    const arret = new AbortController();
    const relais = (): void => arret.abort(o.signal?.reason);
    o.signal?.addEventListener("abort", relais, { once: true });
    let echu = false;
    const minuterie = setTimeout(() => {
      echu = true;
      arret.abort(new CancelledError("chat_title timeout"));
    }, TITLE_TIMEOUT_S * 1000);
    minuterie.unref();
    let r: [string, string, Dict];
    try {
      if (o.signal?.aborted) relais();
      r = await horsTour(selectedModel, "low", arret.signal, () =>
        llamaChatStreamTokens(msgs, {
          userId: "title",
          modelOverride: selectedModel,
          thinkingMode: false,
          samplingOverride: { temperature: 0.2, max_tokens: 24 },
          chatId: o.chatId ?? null,
          slotAvoidOwn: true,
          signal: arret.signal,
          usageScope: "title",
        }),
      );
    } catch (e) {
      if (!echu || o.signal?.aborted) throw e;
      log.info("[chat_title] échec (TimeoutError) — fallback tronqué");
      return null;
    } finally {
      clearTimeout(minuterie);
      o.signal?.removeEventListener("abort", relais);
    }
    const lignes = splitlinesPy(stripPy(r[1] || ""));
    if (!lignes.length) return null;
    let t = stripPy(lignes[0]!);
    t = stripPy(nettoyerBords(nettoyerBords(t, "\"'`«»", true), ".…:;,", false));
    if (!t || longueurPy(t) < 3 || t.includes("<think") || longueurPy(t) > 80) {
      log.info(`[chat_title] sortie inutilisable (${prefixePy(r[1] || "", 60)}) — fallback tronqué`);
      return null;
    }
    log.info(`[chat_title] titre généré en ${Math.trunc(performance.now() - t0)} ms`);
    return prefixePy(t, 60);
  } catch (e) {
    if (estErreurAnnulation(e) || o.signal?.aborted) throw e;
    log.info(`[chat_title] échec (${e instanceof Error ? e.name : typeof e}) — fallback tronqué`);
    return null;
  }
}

/** Appel d'enrichissement d'un prompt d'image (B1-19c, B1-26), dans la file LLM (priorité haute) : contenu seul, température 0,5, 400 jetons. */
export function appelPromptImage(
  model: string | null,
  chatId = "",
  signal?: AbortSignal,
): (msgs: readonly unknown[]) => Promise<string> {
  return async (msgs) => {
    const [, contenu] = await horsTour(model, "high", signal, () =>
      llamaChatStreamTokens(msgs, {
        userId: "image_prompt",
        modelOverride: model,
        thinkingMode: false,
        samplingOverride: { temperature: 0.5, max_tokens: 400 },
        chatId,
        signal,
        usageScope: "image_prompt",
      }),
    );
    return contenu;
  };
}
