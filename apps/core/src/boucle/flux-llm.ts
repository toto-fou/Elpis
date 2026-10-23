// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/flux-llm.ts — UN appel LLM en flux avec `tools[]` : replis sans flux puis texte, reprise d'un flux coupé, borne du raisonnement, tentatives, disjoncteur. */
import { randomUUID } from "node:crypto";

import { CHARS_PER_TOKEN, config } from "@elpis/config";
import {
  comparePointsDeCode,
  estDict,
  estErreurAnnulation,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";

import { stripInternalKeys } from "../contexte/elagage";

import { currentTarget } from "../llm/cible";
import type { LlmTarget } from "../llm/cible";
import { delais, HTTPStatusError, streamTimeoutForCtx } from "../llm/client-http";
import type { ClientHttp, Delais, ReponseFlux } from "../llm/client-http";
import { anthropicChatWithToolsStream } from "../llm/fournisseurs/anthropic";
import { engineCaps } from "../llm/fournisseurs/llama-capacites";
import {
  cancelStream,
  conversationId,
  endReasoning,
  hasAliveSignal,
  headersWithConv,
  lookupStreams,
  noteAliveSignal,
  resumeRequest,
} from "../llm/fournisseurs/llama-flux";
import { buildLlamaPayload, consumeLlamaSse, SseStreamResult } from "../llm/fournisseurs/llamacpp";
import * as oai from "../llm/fournisseurs/openai-compat";
import { getModelContextSize } from "../llm/modeles";
import { currentEngine } from "../llm/moteurs";
import {
  continueFinalSupport,
  noteContinueFinalSupport,
  resolveSampling,
  sanitizePreserveReasoning,
  sanitizeReasoningEffort,
} from "../llm/parametres";
import { disjoncteur } from "../llm/ports";
import { aDialecteEtendu, texteReflexion } from "../llm/profils";
import {
  KIND_TIMEOUT,
  KIND_UNREACHABLE,
  llmErrorDetail,
  llmErrorIsFatal,
  llmErrorKind,
  LLMFailure,
  noteLlmSuccess,
  retryPause,
} from "../llm/reprises";
import { journal } from "../journal";
import { sanitizeSchemaForGrammar } from "../outils/mcp/clients";
import type { Dict } from "../python";
import { extractToolCalls, recoverToolCallsFromReasoning, stripToolCallMarkup } from "./analyse-appels";
import { ThinkTagSplitter } from "./balises-flux";
import { coalesceSystemMessages, extractThinking, http4xx } from "./chat-commun";
import { captureLlmExchange } from "./journal-llm";
import { controleRaisonnement } from "./ports";
import { buildContentResumeTail, buildResumeTail } from "./reprise-raisonnement";

const log = journal("boucle.flux-llm");

export type SurTexte = ((t: string) => void | Promise<void>) | null | undefined;
export type SurDelta =
  ((index: unknown, nom: string, args: string) => void | Promise<void>) | null | undefined;

export interface OptionsFlux {
  modelOverride?: string | null;
  userId?: unknown;
  onThinkingToken?: SurTexte;
  onContentToken?: SurTexte;
  onToolCallDelta?: SurDelta;
  onPromptProgress?: ((p: Dict) => void | Promise<void>) | null;
  isCancelled?: (() => boolean) | null;
  signal?: AbortSignal;
  samplingOverride?: Dict | null;
  thinkingMode?: boolean;
  chatId?: string | null;
  resumeThink?: string | null;
  resumeNativeOk?: boolean;
  resumeContent?: string | null;
  toolChoice?: string;
  /** Profil d'échantillonnage (`chat` pour les appels uniques sans outils, sinon `tools`/`thinking`). */
  samplingTask?: string;
  slotAvoidOwn?: boolean;
}

/** Tâches d'arrêt détachées, gardées jusqu'à leur fin. */
const TACHES_DETACHEES = new Set<Promise<unknown>>();

function detacher(p: Promise<unknown>): void {
  const t = p.catch(() => undefined).finally(() => TACHES_DETACHEES.delete(t));
  TACHES_DETACHEES.add(t);
}

/** Racine du serveur à partir de l'URL de complétion (suffixes les plus longs d'abord). */
export function endpointBase(url: string | null | undefined): string {
  const u = (url || "").replace(/\/+$/u, "");
  for (const suffixe of ["/v1/chat/completions", "/chat/completions", "/v1/completions", "/v1"])
    if (u.endsWith(suffixe)) return u.slice(0, -suffixe.length);
  return u;
}

function baseDe(target: LlmTarget): string {
  return endpointBase(target.baseUrl || config.LLAMA_URL);
}

/** Demande au moteur d'arrêter la session, sans attendre (le tour se déroule déjà). */
function fireCancelStream(client: ClientHttp, target: LlmTarget, convId: string, model: string): void {
  if (!convId) return;
  detacher(cancelStream(client, baseDe(target), convId, model, { headers: oai.headers(target) }));
}

/** Budget de réflexion de l'interface (E24) reporté sur la boucle : borné à 512–131 072, puis au plafond de génération. */
export function budgetReflexionInterface(
  payload: Dict,
  samplingOverride: Dict | null | undefined,
): number | null {
  const b = estDict(samplingOverride) ? samplingOverride["thinking_budget_tokens"] : undefined;
  if (typeof b !== "number" && typeof b !== "boolean") return null;
  const n = Math.trunc(Number(b));
  if (!(n > 0)) return null;
  let budget = Math.min(Math.max(n, 512), 131072);
  const plafond = payload["max_tokens"];
  if (typeof plafond === "number" && Number.isInteger(plafond) && plafond > 0)
    budget = Math.min(budget, plafond);
  return budget;
}

/** Seuil de fermeture du raisonnement en caractères (0 = jamais) : budget souple, budget de l'interface en réflexion, ou 80 % du plafond de génération. */
export function reasoningCapChars(
  payload: Dict,
  o: { thinkingMode?: boolean; samplingOverride?: Dict | null } = {},
): number {
  const caps: number[] = [];
  const souple = Math.trunc(Number(config.LLAMA_REASONING_SOFT_BUDGET_TOKENS) || 0);
  if (souple > 0) caps.push(souple);
  if (o.thinkingMode) {
    const ui = budgetReflexionInterface(payload, o.samplingOverride);
    if (ui !== null) caps.push(ui);
  }
  const mt = payload["max_tokens"];
  if (typeof mt === "number" && Number.isInteger(mt) && mt > 0) caps.push(Math.trunc(mt * 0.8));
  if (!caps.length) return 0;
  return Math.trunc(Math.min(...caps) * CHARS_PER_TOKEN);
}

function publishCompletion(
  inner: SurTexte,
  sse: SseStreamResult,
  chatId: string | null,
  model: string,
): SurTexte {
  let fait = false;
  return async (segment: string) => {
    if (inner) await inner(segment);
    if (fait || !chatId || !sse.completionId) return;
    fait = true;
    try {
      controleRaisonnement().noteCompletion(chatId, sse.completionId, model, currentEngine().key);
    } catch (e) {
      log.debug(`reasoning_control.note : ${String(e)}`);
    }
  };
}

function reasoningGuard(
  inner: SurTexte,
  capChars: number,
  sse: SseStreamResult,
  client: ClientHttp,
  target: LlmTarget,
  model: string,
  reqId: string,
): SurTexte {
  let vus = 0;
  let declenche = false;
  return async (segment: string) => {
    if (inner) await inner(segment);
    if (declenche) return;
    vus += longueurPy(segment || "");
    if (vus < capChars || !sse.completionId) return;
    declenche = true;
    log.warn(
      `[LLM_REQ ${reqId}] raisonnement au-delà du seuil (~${vus} caractères) → fermeture demandée au moteur (le modèle passe à la réponse ; rien n'est tronqué)`,
    );
    detacher(endReasoning(client, baseDe(target), sse.completionId, model, { headers: oai.headers(target) }));
  };
}

/** Rappel qui saute les `already` premiers points de code déjà reçus par le client (reprise rejouée depuis le début). */
export function skipping(cb: SurTexte, already: number): SurTexte {
  let reste = Math.max(0, Math.trunc(already));
  return async (segment: string) => {
    if (reste > 0) {
      const n = Math.min(reste, longueurPy(segment));
      reste -= n;
      segment = segment.slice(prefixePy(segment, n).length);
      if (!segment) return;
    }
    if (cb) await cb(segment);
  };
}

/** Reprise coupée à son tour : chaque canal de `previous` garde le plus long des deux textes (en place). */
export function keepResumedText(previous: SseStreamResult | null, fresh: SseStreamResult | null): void {
  if (previous === null || fresh === null) return;
  for (const canal of ["contentParts", "thinkingParts"] as const) {
    const ancien = previous[canal];
    const neuf = fresh[canal];
    if (!neuf.length) continue;
    if (longueurPy(neuf.join("")) > longueurPy(ancien.join(""))) ancien.splice(0, ancien.length, ...neuf);
  }
}

interface ContexteReprise {
  reqId: string;
  userId: unknown;
  previous: SseStreamResult;
  isCancelled: (() => boolean) | null | undefined;
  signal: AbortSignal | undefined;
  onThinkingToken: SurTexte;
  onContentToken: SurTexte;
  streamTimeout: Delais | null;
}

/** Reprend un flux coupé par le TRANSPORT depuis le tampon du moteur ; `null` si ce n'est pas possible. */
async function resumeCutStream(
  client: ClientHttp,
  target: LlmTarget,
  convId: string,
  model: string,
  err: unknown,
  c: ContexteReprise,
): Promise<SseStreamResult | null> {
  if (!convId || estErreurAnnulation(err) || err instanceof HTTPStatusError) return null;
  const base = baseDe(target);
  const entetes = oai.headers(target);
  const vivants = await lookupStreams(client, base, [convId], model, { headers: entetes });
  const ligne = vivants.get(convId);
  const nom = err instanceof Error ? err.name : typeof err;
  if (!ligne) {
    log.info(`[LLM_REQ ${c.reqId}] flux coupé (${nom}) et aucune session reprenable — repli sur le partiel`);
    return null;
  }
  log.warn(
    `[LLM_REQ ${c.reqId}] flux coupé (${nom}) → REPRISE depuis le tampon du moteur (${strPy(ligne["total_bytes"])} octets déjà produits, terminé=${strPy(ligne["is_done"])})`,
  );
  const vusContenu = longueurPy(c.previous.contentParts.join(""));
  const vusPensee = longueurPy(c.previous.thinkingParts.join(""));
  const fresh = new SseStreamResult();
  try {
    const r2 = await resumeRequest(client, base, convId, model, 0, c.streamTimeout, {
      headers: entetes,
      signal: c.signal,
    });
    try {
      if (r2.statusCode !== 200) return null;
      await consumeLlamaSse(r2, {
        tagSplitter: new ThinkTagSplitter(),
        reqId: c.reqId,
        userId: c.userId,
        isCancelled: c.isCancelled,
        signal: c.signal,
        onThinkingToken: skipping(c.onThinkingToken, vusPensee),
        onContentToken: skipping(c.onContentToken, vusContenu),
        onToolCallDelta: null,
        sink: fresh,
      });
    } finally {
      await r2.aclose();
    }
  } catch (e2) {
    if (estErreurAnnulation(e2)) throw e2;
    log.warn(
      `[LLM_REQ ${c.reqId}] reprise du flux impossible (${prefixePy(String(e2), 150)}) — repli sur le partiel`,
    );
    keepResumedText(c.previous, fresh);
    return null;
  }
  log.info(
    `[LLM_REQ ${c.reqId}] reprise réussie : ${longueurPy(fresh.content())} caractères au total (${vusContenu} déjà lus)`,
  );
  return fresh;
}

/** `d.get(k)` d'un objet qui doit être un dict (sinon `AttributeError` Python : l'étape de repli échoue). */
function champ(d: unknown, k: string): unknown {
  if (!estDict(d)) throw new TypeError(`'${typeof d}' object has no attribute 'get'`);
  return d[k];
}

function premierChoix(data: unknown): unknown {
  const choix = champ(data, "choices");
  const liste = veritePy(choix) ? choix : [{}];
  if (!Array.isArray(liste)) throw new TypeError("choices");
  return liste[0];
}

/** Repli d'un 500 sur flux + outils : sans flux avec outils, puis sans outils et appels lus dans le texte. */
async function repli500(
  client: ClientHttp,
  url: string,
  entetes: Record<string, string>,
  payload: Dict,
  o: OptionsFlux,
): Promise<Dict> {
  log.info("[tools_stream] 500 sur stream+tools → fallback non-streaming avec tools");
  const fb: Dict = { ...payload, stream: false };
  delete fb["thinking"];
  try {
    const r = await client.post(url, { json: fb, headers: entetes, signal: o.signal });
    r.raiseForStatus();
    const data = r.json();
    const msg = champ(premierChoix(data), "message") || {};
    let rc = stripPy(texteReflexion(msg));
    if (rc && estDict(msg) && !veritePy(msg["reasoning_content"])) msg["reasoning_content"] = rc;
    let ct = stripPy(strPy(champ(msg, "content") || ""));
    if (!rc) {
      [rc, ct] = extractThinking(ct);
      if (rc && estDict(msg)) {
        msg["content"] = ct;
        msg["reasoning_content"] = rc;
      }
    }
    if (rc && o.onThinkingToken) {
      const points = Array.from(rc);
      for (let i = 0; i < points.length; i += 40) await o.onThinkingToken(points.slice(i, i + 40).join(""));
    }
    return data as Dict;
  } catch (fbErr) {
    if (estErreurAnnulation(fbErr)) throw fbErr;
    log.warn(
      `[tools_stream] Fallback non-stream a aussi échoué (${prefixePy(String(fbErr), 200)}) → retry SANS tools, parsing manuel`,
    );
  }
  const sansOutils: Dict = Object.fromEntries(
    Object.entries(payload).filter(([k]) => k !== "tools" && k !== "tool_choice"),
  );
  sansOutils["stream"] = false;
  delete sansOutils["thinking"];
  try {
    const r = await client.post(url, { json: sansOutils, headers: entetes, signal: o.signal });
    r.raiseForStatus();
    const data = r.json();
    const choix = premierChoix(data) || {};
    const msg = champ(choix, "message") || {};
    const texte = strPy(champ(msg, "content") || "");
    const longueur = strPy(champ(choix, "finish_reason") || "") === "length";
    const usage = champ(data, "usage") || {};
    const timings = champ(data, "timings") || {};
    const appels = veritePy(payload["tools"]) ? extractToolCalls(texte) : null;
    if (appels) {
      const propre = stripToolCallMarkup(texte);
      return {
        choices: [
          {
            finish_reason: longueur ? "length" : "tool_calls",
            message: {
              role: "assistant",
              content: propre || null,
              tool_calls: appels.map(([nom, args], i) => ({
                id: `call_${i}`,
                type: "function",
                function: { name: nom, arguments: pyJsonDumps(args, { ensureAscii: false }) },
              })),
            },
          },
        ],
        usage,
        timings,
      };
    }
    return {
      choices: [
        { finish_reason: longueur ? "length" : "stop", message: { role: "assistant", content: texte } },
      ],
      usage,
      timings,
    };
  } catch (ntErr) {
    if (!estErreurAnnulation(ntErr))
      log.error(`[tools_stream] Fallback sans-tools a échoué aussi : ${prefixePy(String(ntErr), 200)}`);
    throw ntErr;
  }
}

/** Définitions d'outils normalisées pour la grammaire de llama.cpp, triées par nom (préfixe KV stable). */
function outilsPourEnvoi(toolsPayload: readonly unknown[]): Dict[] {
  const normalises = toolsPayload.map((t) => {
    const fn = estDict(t) ? (estDict(t["function"]) ? t["function"] : t["function"] || {}) : {};
    const params = estDict(fn) ? fn["parameters"] : undefined;
    if (estDict(t) && estDict(fn) && estDict(params))
      return { ...t, function: { ...fn, parameters: sanitizeSchemaForGrammar(params) } };
    return t as Dict;
  });
  const nom = (t: unknown): string => {
    const fn = estDict(t) ? t["function"] || {} : {};
    return strPy((estDict(fn) ? fn["name"] : null) || "");
  };
  return normalises
    .map((t, i) => [t, i] as const)
    .sort(([a, i], [b, j]) => comparePointsDeCode(nom(a), nom(b)) || i - j)
    .map(([t]) => t);
}

/** Le moteur n'a pas répondu : alimente le disjoncteur du serveur de la cible (transport seulement). */
function noterPanneTransport(model: string, err: unknown): void {
  try {
    const cause = (err instanceof LLMFailure ? err.cause : null) || err;
    if ([KIND_UNREACHABLE, KIND_TIMEOUT].includes(llmErrorKind(cause)))
      disjoncteur().signalerPanneTransport(currentEngine(), model);
  } catch (e) {
    log.debug(`disjoncteur : ${String(e)}`);
  }
}

async function auMieux(etiquette: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.debug(`${etiquette} : ${String(e)}`);
  }
}

/** `POST /v1/chat/completions` en flux avec `tools[]` ; réponse au format OpenAI non streamé (`choices[0].message`, `usage`, `timings`). */
export async function llamaChatWithToolsStream(
  messages: readonly unknown[],
  toolsPayload: readonly unknown[] | null,
  o: OptionsFlux = {},
): Promise<Dict> {
  const userId = o.userId ?? "guest";
  const toolChoice = o.toolChoice ?? "auto";
  const resumeNativeOk = o.resumeNativeOk ?? true;
  const thinkingMode = o.thinkingMode ?? false;
  const chatId = o.chatId ?? null;
  const target = currentTarget();
  const llamaNative = target.providerType === "llamacpp";
  const llamacppSrv = target.isLlamacpp;
  const targetModel = o.modelOverride || target.model || config.LLAMA_MODEL;
  const msgs = coalesceSystemMessages(stripInternalKeys([...messages]));

  if (target.wire === "anthropic") {
    return anthropicChatWithToolsStream(coalesceSystemMessages([...messages]), toolsPayload ?? [], {
      target,
      model: targetModel,
      onThinkingToken: o.onThinkingToken ?? null,
      onContentToken: o.onContentToken ?? null,
      onToolCallDelta: o.onToolCallDelta ?? null,
      isCancelled: o.isCancelled ?? null,
      samplingOverride: o.samplingOverride,
      thinkingMode,
      chatId,
      signal: o.signal,
    } as Parameters<typeof anthropicChatWithToolsStream>[2]);
  }

  const reqId = randomUUID().replace(/-/gu, "").slice(0, 8);
  const promptChars = msgs.reduce<number>((n, m) => {
    const c = estDict(m) ? m["content"] : null;
    return n + (typeof c === "string" ? longueurPy(c) : 0);
  }, 0);
  log.info(
    `[LLM_REQ ${reqId}] START_TOOLS user=${strPy(userId)} model=${targetModel} ${toolsPayload?.length ? `n_tools=${toolsPayload.length}` : "(pas d'outils)"} msgs=${msgs.length} prompt_chars=${promptChars}`,
  );

  const samplingParams = llamacppSrv
    ? await resolveSampling(
        targetModel,
        thinkingMode ? "thinking" : (o.samplingTask ?? "tools"),
        o.samplingOverride ?? null,
      )
    : oai.remoteSampling(o.samplingOverride, target);

  const [client, reqUrl, entetesCible] = oai.endpoint(target);
  let reqHeaders = entetesCible;
  let convId = "";
  if (llamaNative && config.LLAMA_RESUMABLE_STREAM && chatId) {
    if ((await engineCaps("", { engine: currentEngine() })).resumableStream) {
      convId = conversationId(userId, chatId);
      reqHeaders = headersWithConv(reqHeaders, convId);
    }
  }

  let resumeNative = false;
  if (o.resumeThink !== null && o.resumeThink !== undefined && llamacppSrv)
    resumeNative = Boolean(resumeNativeOk && continueFinalSupport(targetModel) !== false);

  const construire = async (nativeResume: boolean): Promise<Dict> => {
    let m: unknown[] = msgs;
    let tm = thinkingMode;
    let drapeaux: Dict = {};
    if (o.resumeContent !== null && o.resumeContent !== undefined) {
      const [queue, d] = buildContentResumeTail(o.resumeContent);
      m = [...msgs, ...queue];
      drapeaux = d;
    } else if (o.resumeThink !== null && o.resumeThink !== undefined) {
      const [queue, d] = buildResumeTail(o.resumeThink, { native: nativeResume });
      m = [...msgs, ...queue];
      drapeaux = d;
      if (!nativeResume) tm = false;
    }
    const p = await buildLlamaPayload(m, {
      targetModel,
      userId,
      samplingParams,
      llamaNative,
      localLlamacpp: llamacppSrv,
      dialecteEtendu: aDialecteEtendu(target.providerType),
      thinkingMode: tm,
      chatId,
      reasoningEffort: sanitizeReasoningEffort(o.samplingOverride),
      preserveReasoning: sanitizePreserveReasoning(o.samplingOverride),
      slotAvoidOwn: o.slotAvoidOwn ?? false,
    });
    Object.assign(p, drapeaux);
    if (toolsPayload && toolsPayload.length) {
      p["tools"] = outilsPourEnvoi(toolsPayload);
      p["tool_choice"] = toolChoice === "auto" || toolChoice === "none" ? toolChoice : "auto";
    }
    oai.sanitizePayload(p, target);
    return p;
  };

  let payload = await construire(resumeNative);

  let streamTo: Delais | null = null;
  if (llamacppSrv) {
    try {
      if (hasAliveSignal(targetModel)) {
        const readS = Math.max(60.0, 4.0 * Number(config.LLAMA_SSE_PING_INTERVAL_S || 15));
        streamTo = delais(config.LLAMA_TIMEOUT_SEC, { connect: 15.0, read: readS });
      } else {
        const cand = streamTimeoutForCtx(await getModelContextSize(targetModel));
        if ((cand.read ?? 0) > Number(config.LLAMA_TIMEOUT_SEC)) streamTo = cand;
      }
    } catch {
      streamTo = null;
    }
  }

  const retries = Number(config.LLAMA_RETRIES);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries + 1; attempt++) {
    let contentParts: string[] = [];
    let thinkingParts: string[] = [];
    let toolCallsAcc: SseStreamResult["toolCallsAcc"] = new Map();
    let usage: Dict = {};
    let timings: Dict = {};
    try {
      o.signal?.throwIfAborted();
      const resp: ReponseFlux = await client.stream("POST", reqUrl, {
        json: payload,
        headers: reqHeaders,
        ...(streamTo !== null ? { timeout: streamTo } : {}),
        signal: o.signal,
      });
      let sse = new SseStreamResult();
      try {
        if (resp.statusCode >= 400) await auMieux("lecture du corps d'erreur", () => resp.aread());
        if (resp.statusCode === 500) return await repli500(client, reqUrl, reqHeaders, payload, o);
        if (resp.statusCode >= 400) resp.raiseForStatus();
        sse.contentParts = contentParts;
        sse.thinkingParts = thinkingParts;
        sse.toolCallsAcc = toolCallsAcc;
        let thinkCb: SurTexte = o.onThinkingToken;
        if (llamaNative && veritePy(payload["reasoning_control"]))
          thinkCb = publishCompletion(thinkCb, sse, chatId, targetModel);
        const cap = reasoningCapChars(payload, {
          thinkingMode,
          samplingOverride: o.samplingOverride ?? null,
        });
        if (cap > 0 && llamacppSrv)
          thinkCb = reasoningGuard(thinkCb, cap, sse, client, target, targetModel, reqId);
        try {
          sse = await consumeLlamaSse(resp, {
            tagSplitter: new ThinkTagSplitter(),
            reqId,
            userId,
            isCancelled: o.isCancelled ?? null,
            signal: o.signal,
            onThinkingToken: thinkCb ?? null,
            onContentToken: o.onContentToken ?? null,
            onToolCallDelta: o.onToolCallDelta ?? null,
            onPromptProgress: o.onPromptProgress ?? null,
            sink: sse,
          });
        } catch (coupure) {
          if (estErreurAnnulation(coupure)) throw coupure;
          const reprise = await resumeCutStream(client, target, convId, targetModel, coupure, {
            reqId,
            userId,
            previous: sse,
            isCancelled: o.isCancelled,
            signal: o.signal,
            onThinkingToken: o.onThinkingToken,
            onContentToken: o.onContentToken,
            streamTimeout: streamTo,
          });
          if (reprise === null) throw coupure;
          sse = reprise;
          contentParts = sse.contentParts;
          thinkingParts = sse.thinkingParts;
          toolCallsAcc = sse.toolCallsAcc;
        } finally {
          if (chatId && veritePy(payload["reasoning_control"]))
            await auMieux("reasoning_control.clear", () => controleRaisonnement().clearCompletion(chatId));
        }
      } finally {
        await resp.aclose();
      }

      if (Object.keys(sse.promptProgress).length) noteAliveSignal(targetModel);
      contentParts = sse.contentParts;
      thinkingParts = sse.thinkingParts;
      toolCallsAcc = sse.toolCallsAcc;
      usage = sse.usage;
      timings = sse.timings;
      let finishReason: unknown = veritePy(sse.finishReason) ? sse.finishReason : "";
      const preEmis = sse.streamPreEmittedThinking;

      let builtTcs: Dict[] = sse.builtToolCalls();
      const finalContent = contentParts.join("");
      const silentCut = !veritePy(finishReason);
      const tronque = strPy(finishReason || "") === "length" || silentCut;
      if (toolsPayload?.length && !builtTcs.length && !stripPy(finalContent) && !tronque) {
        const connus = new Set<string>();
        for (const t of toolsPayload ?? []) {
          const fn = estDict(t) ? t["function"] || {} : {};
          const nom = estDict(fn) ? fn["name"] : null;
          if (typeof nom === "string" && nom) connus.add(nom);
        }
        const recuperes = recoverToolCallsFromReasoning(thinkingParts.join(""), connus.size ? connus : null);
        if (recuperes.length) {
          builtTcs = recuperes;
          finishReason = "tool_calls";
          log.warn(
            `[LLM_REQ ${reqId}] ${builtTcs.length} tool-call(s) récupéré(s) depuis le reasoning (canal tool_calls natif manqué — modèle thinking)`,
          );
        }
      }
      log.info(
        `[LLM_REQ ${reqId}] END_TOOLS user=${strPy(userId)} n_tool_calls=${builtTcs.length} content_chars=${longueurPy(finalContent)} finish=${strPy(finishReason || "stop")}`,
      );
      if (silentCut && !builtTcs.length && !stripPy(finalContent) && !stripPy(thinkingParts.join("")))
        throw new Error("flux SSE terminé sans finish_reason (0 token)");
      if (silentCut && builtTcs.length) {
        log.warn(
          `[LLM_REQ ${reqId}] flux coupé pendant l'émission de ${builtTcs.length} tool_call(s) — arguments incomplets, abandonnés ; le tour repart en partiel.`,
        );
        builtTcs = [];
      }
      const fr = veritePy(finishReason)
        ? finishReason
        : builtTcs.length
          ? "tool_calls"
          : silentCut
            ? "length"
            : "stop";
      await captureLlmExchange({
        reqId,
        userId,
        chatId,
        model: targetModel,
        path: "tools",
        requestPayload: payload,
        content: finalContent,
        toolCalls: builtTcs,
        usage,
        timings,
        finishReason: strPy(fr),
        status: "ok",
      });
      if (
        (o.resumeContent !== null && o.resumeContent !== undefined) ||
        (o.resumeThink !== null && o.resumeThink !== undefined && resumeNative)
      )
        noteContinueFinalSupport(targetModel, true);
      await auMieux("note_llm_success", () => noteLlmSuccess());
      return {
        choices: [
          {
            finish_reason: fr,
            message: {
              role: "assistant",
              content: finalContent || null,
              tool_calls: builtTcs.length ? builtTcs : null,
            },
          },
        ],
        usage,
        timings,
        reasoning_channel_native: Boolean(preEmis),
        ...(sse.inThink ? { in_think: true } : {}),
        ...(silentCut ? { partial: true } : {}),
      };
    } catch (e) {
      if (estErreurAnnulation(e) || o.signal?.aborted) {
        fireCancelStream(client, target, convId, targetModel);
        throw e;
      }
      lastErr = e;
      log.warn(`[LLM_REQ ${reqId}] tools_stream attempt ${attempt + 1} failed: ${prefixePy(String(e), 200)}`);
      if (contentParts.length || thinkingParts.length || toolCallsAcc.size) {
        log.warn(
          `[LLM_REQ ${reqId}] tools_stream interrompu après émission partielle — pas de retry, retour du partiel.`,
        );
        if (!(e instanceof HTTPStatusError)) fireCancelStream(client, target, convId, targetModel);
        await captureLlmExchange({
          reqId,
          userId,
          chatId,
          model: targetModel,
          path: "tools",
          requestPayload: payload,
          content: contentParts.join(""),
          usage,
          timings,
          finishReason: "partial",
          status: "partial",
          error: prefixePy(String(e instanceof Error ? e.message : e), 500),
        });
        return {
          choices: [
            {
              finish_reason: "length",
              message: { role: "assistant", content: contentParts.join("") || null, tool_calls: null },
            },
          ],
          usage,
          timings,
          partial: true,
        };
      }
      if (llmErrorIsFatal(e)) {
        if (o.resumeContent !== null && o.resumeContent !== undefined && http4xx(e)) {
          noteContinueFinalSupport(targetModel, false);
          log.warn(`[LLM_REQ ${reqId}] continue_final_message refusé — reprise de prose abandonnée`);
          break;
        }
        if (o.resumeThink !== null && o.resumeThink !== undefined && resumeNative && http4xx(e)) {
          noteContinueFinalSupport(targetModel, false);
          log.warn(`[LLM_REQ ${reqId}] continue_final_message refusé → repli prefill <think>`);
          resumeNative = false;
          payload = await construire(false);
          continue;
        }
        log.warn(`[LLM_REQ ${reqId}] erreur non-retryable (${prefixePy(String(e), 150)}) — abandon immédiat`);
        break;
      }
      if (attempt < retries)
        await retryPause(e, attempt, {
          isCancelled: o.isCancelled ?? null,
          label: "tools_stream",
          signal: o.signal,
        });
    }
  }
  await captureLlmExchange({
    reqId,
    userId,
    chatId,
    model: targetModel,
    path: "tools",
    requestPayload: payload,
    content: "",
    status: "error",
    error: prefixePy(llmErrorDetail(lastErr), 1000),
  });
  noterPanneTransport(targetModel, lastErr);
  throw new LLMFailure(lastErr, { attempts: llmErrorIsFatal(lastErr) ? 1 : retries + 1 });
}
