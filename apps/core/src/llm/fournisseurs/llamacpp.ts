// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/llamacpp.ts — étages partagés des deux moteurs de flux : corps de requête llama.cpp et consommation du flux SSE (lu ligne à ligne). */
import { ErreurPython, intPy, pyJsonDumps, stripPy, strPy, veritePy } from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";

import { journal } from "../../journal";
import { estDict, longueurPy } from "../../python";
import type { Dict } from "../../python";
import { CancelledError } from "../client-http";
import {
  applyKvCacheParams,
  clampGenerationBudget,
  LLAMA_FORCE_IDLE_SLOT,
  LLAMA_THINKING_OUTPUT_UNCAPPED,
  resolveSlotIdAsync,
} from "../constantes";
import { getPy, isdigitPy, iterExige } from "../dict-py";
import { getModelContextSize } from "../modeles";
import { currentEngine } from "../moteurs";
import { getPreserveReasoningSupport, getReasoningEffortValues } from "../parametres";
import { executions } from "../ports";
import { texteReflexion } from "../profils";
import { providerHttpError } from "../reprises";
import type { ProviderError } from "../reprises";
import { observerUsage } from "../sonde-moteur";
import { engineCaps } from "./llama-capacites";

const log = journal("llama_payload");

export const STRICT_TEMPLATE_ANCHOR =
  "[SYSTEM] Mission in progress — the original request was summarized into the context above. Continue from there.";

function role(m: unknown): unknown {
  return estDict(m) ? getPy(m, "role") : undefined;
}

/** Au moins un `user` dès qu'il y a un échange (sinon le gabarit lève « No user query found in messages »). */
export function ensureUserQuery(msgs: unknown[]): unknown[] {
  if (msgs.some((m) => role(m) === "user")) return msgs;
  if (!msgs.some((m) => role(m) === "assistant" || role(m) === "tool")) return msgs;
  let position = 0;
  for (const m of msgs) {
    if (role(m) === "system") position += 1;
    else break;
  }
  log.warn(
    `aucun message user dans ${msgs.length} messages — ancre de tâche posée en position ${position} ` +
      "(sinon 500 « No user query found in messages »)",
  );
  const sortie = [...msgs];
  sortie.splice(position, 0, { role: "user", content: STRICT_TEMPLATE_ANCHOR });
  return sortie;
}

function texteMessage(m: Dict): string {
  const c = getPy(m, "content");
  if (Array.isArray(c))
    return c
      .filter((b) => estDict(b) && typeof getPy(b, "text") === "string")
      .map((b) => getPy(b, "text", "") as string)
      .join("\n");
  return c === null || c === undefined ? "" : strPy(c);
}

/** Assistants consécutifs en fin de liste fusionnés en un seul (clés du dernier, textes concaténés). */
export function coalesceTrailingAssistants(msgs: unknown[]): unknown[] {
  let i = msgs.length;
  while (i > 0 && role(msgs[i - 1]) === "assistant") i -= 1;
  if (msgs.length - i < 2) return msgs;
  const queue = msgs.slice(i) as Dict[];
  const fusion: Dict = { ...(queue[queue.length - 1] as Dict) };
  fusion["content"] = queue
    .map((m) => stripPy(texteMessage(m)))
    .filter((t) => t)
    .join("\n\n");
  log.warn(
    `${queue.length} messages assistant consécutifs en fin de liste — fusionnés (sinon 400 « Cannot ` +
      "have 2 or more assistant messages at the end of the list »)",
  );
  return [...msgs.slice(0, i), fusion];
}

export interface OptionsPayload {
  targetModel: string;
  userId: unknown;
  samplingParams: Dict;
  llamaNative: boolean;
  localLlamacpp: boolean;
  /** vLLM ou SGLang : réflexion par `chat_template_kwargs`, effort au premier niveau. */
  dialecteEtendu?: boolean;
  thinkingMode: boolean;
  chatId: string | null;
  reasoningEffort?: string | null;
  preserveReasoning?: boolean | null;
  slotAvoidOwn?: boolean;
  /** Clé hachée pour choisir le slot (llama.cpp) ; absente, le chatId. */
  slotKey?: string | null;
  /** Slots à éviter, relus au moment du choix ; `surSlot` reçoit le slot retenu. */
  slotAvoid?: (() => Iterable<number>) | null;
  surSlot?: ((slot: number) => void) | null;
}

/** Corps COMMUN aux moteurs : squelette, cache KV, plafond adapté au n_ctx, kwargs de gabarit (llama.cpp, vLLM, SGLang), épinglage de slot. */
export async function buildLlamaPayload(msgsEntree: unknown[], o: OptionsPayload): Promise<Dict> {
  const msgs = coalesceTrailingAssistants(ensureUserQuery(msgsEntree));
  const payload: Dict = {
    model: o.targetModel,
    messages: msgs,
    user: strPy(o.userId),
    stream: true,
    stream_options: { include_usage: true },
    ...o.samplingParams,
  };
  if (o.llamaNative) {
    applyKvCacheParams(payload);
    payload["timings_per_token"] = true;
    const caps = await engineCaps();
    if (config.LLAMA_RETURN_PROGRESS && caps.payloadReturnProgress) payload["return_progress"] = true;
    const ping = config.LLAMA_SSE_PING_INTERVAL_S;
    if (ping && ping > 0 && caps.payloadSsePing) payload["sse_ping_interval"] = intPy(ping);
    if (o.thinkingMode && config.LLAMA_REASONING_CONTROL && caps.payloadReasoningControl)
      payload["reasoning_control"] = true;
  }
  if (o.localLlamacpp) {
    let ctx: number;
    try {
      ctx = await getModelContextSize(o.targetModel);
    } catch {
      ctx = 0;
    }
    clampGenerationBudget(payload, o.samplingParams, o.thinkingMode, ctx || null, {
      uncapOutput: Boolean(o.thinkingMode && LLAMA_THINKING_OUTPUT_UNCAPPED),
    });
  }
  if (o.dialecteEtendu && o.reasoningEffort) payload["reasoning_effort"] = o.reasoningEffort;
  if (o.llamaNative || o.dialecteEtendu) {
    const kwargs: Dict = { enable_thinking: Boolean(o.thinkingMode) };
    payload["chat_template_kwargs"] = kwargs;
    if (o.reasoningEffort && o.localLlamacpp) {
      let efforts: string[];
      try {
        efforts = await getReasoningEffortValues(o.targetModel);
      } catch {
        efforts = [];
      }
      if (efforts.includes(o.reasoningEffort)) kwargs["reasoning_effort"] = o.reasoningEffort;
    }
    if (o.preserveReasoning !== null && o.preserveReasoning !== undefined && o.localLlamacpp) {
      let ok: boolean;
      try {
        ok = await getPreserveReasoningSupport(o.targetModel);
      } catch {
        ok = false;
      }
      if (ok) kwargs["preserve_reasoning"] = Boolean(o.preserveReasoning);
    }
  }
  if (o.llamaNative && msgs.length > 0) {
    const dernier = msgs[msgs.length - 1];
    if (
      estDict(dernier) &&
      getPy(dernier, "role") === "assistant" &&
      veritePy(getPy(dernier, "reasoning_content"))
    ) {
      const c = getPy(dernier, "content");
      const texte = veritePy(c) ? c : "";
      if (typeof texte !== "string")
        throw new ErreurPython("AttributeError", "'list' object has no attribute 'strip'");
      if (!stripPy(texte)) {
        payload["continue_final_message"] = true;
        payload["add_generation_prompt"] = false;
      }
    }
  }
  if (o.localLlamacpp) {
    const slot = await resolveSlotIdAsync(o.slotKey || o.chatId, {
      avoidOwn: o.slotAvoidOwn ?? false,
      avoid: o.slotAvoid ?? null,
      surSlot: o.surSlot ?? null,
    });
    if (slot >= 0) payload["id_slot"] = slot;
    else if (LLAMA_FORCE_IDLE_SLOT) payload["id_slot"] = -1;
  }
  return payload;
}

/** Type d'erreur SSE → code HTTP équivalent quand l'événement n'en porte pas. */
export const SSE_ERROR_STATUS: Readonly<Record<string, number>> = {
  exceed_context_size_error: 400,
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  overloaded_error: 529,
  unavailable_error: 503,
};

function statutSse(cle: string): number {
  return Object.hasOwn(SSE_ERROR_STATUS, cle) ? (SSE_ERROR_STATUS[cle] ?? 0) : 0;
}

/** Événement d'erreur SSE → `ProviderError` au corps `{"error": …}` lisible par la taxonomie. */
export function sseError(errEntree: unknown): ProviderError {
  const err: Dict = estDict(errEntree)
    ? errEntree
    : { message: strPy(veritePy(errEntree) ? errEntree : "erreur de flux") };
  let statut = 0;
  const code = getPy(err, "code");
  if (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599) statut = code;
  else if (typeof code === "string" && isdigitPy(code)) {
    const n = intPy(code);
    if (n >= 400 && n <= 599) statut = n;
  }
  if (!statut) {
    const type = getPy(err, "type");
    statut =
      statutSse(strPy(veritePy(type) ? type : "")) || statutSse(strPy(veritePy(code) ? code : "")) || 500;
  }
  const corps = pyJsonDumps({ error: err }, { ensureAscii: false });
  const m = veritePy(getPy(err, "message")) ? getPy(err, "message") : getPy(err, "type");
  const message = strPy(veritePy(m) ? m : "erreur de flux");
  return providerHttpError(statut, corps, {
    message: `erreur du fournisseur en cours de flux (${statut}) : ${[...message].slice(0, 300).join("")}`,
  });
}

/** Accumulateur d'un appel d'outil en cours de flux ; `idMoteur` : id annoncé par le moteur (`null` s'il n'en a pas donné). */
interface AppelEnCours {
  id: unknown;
  idMoteur: unknown;
  type: "function";
  function: { name: string; arguments_parts: string[] };
}

/** Sortie brute de `consumeLlamaSse`, remplie en place (l'appelant voit le partiel même si le flux lève). */
export class SseStreamResult {
  contentParts: string[] = [];
  thinkingParts: string[] = [];
  /** Appels par numéro d'Elpis (ordre d'ouverture) ; `slotParIndex` : appel en cours pour chaque `index` du moteur. */
  toolCallsAcc = new Map<number, AppelEnCours>();
  slotParIndex = new Map<unknown, number>();
  indexReutilise = false;
  usage: Dict = {};
  timings: Dict = {};
  finishReason: unknown = null;
  inThink = false;
  streamPreEmittedThinking = false;
  reroutedThinkChars = 0;
  reroutedThinkWarned = false;
  completionId: string | null = null;
  promptProgress: Dict = {};
  /** Instants (`performance.now()`) : envoi de la requête (posé par l'appelant), premier delta utile, fin du flux. */
  debutMs: number | null = null;
  premierMs: number | null = null;
  finMs: number | null = null;

  content(): string {
    return this.contentParts.join("");
  }

  thinking(): string {
    return this.thinkingParts.join("");
  }

  /** `tool_calls` assemblés (deltas → structure OpenAI), dans l'ordre d'ouverture des appels. */
  builtToolCalls(): Dict[] {
    return [...this.toolCallsAcc.entries()].map(([i, acc]) => ({
      id: veritePy(acc.id) ? acc.id : `call_${strPy(i)}`,
      type: "function",
      function: { name: acc.function.name, arguments: acc.function.arguments_parts.join("") },
    }));
  }

  /** Appel visé par un delta : un nouvel id du moteur portant un nom, sur un index dont l'appel est déjà nommé, ouvre un appel distinct. */
  appelPour(index: unknown, idMoteur: unknown, nomDelta: string): [number, AppelEnCours] {
    const slot = this.slotParIndex.get(index);
    const acc = slot === undefined ? undefined : this.toolCallsAcc.get(slot);
    if (slot !== undefined && acc !== undefined) {
      const autreAppel =
        veritePy(idMoteur) &&
        nomDelta !== "" &&
        acc.function.name !== "" &&
        veritePy(acc.idMoteur) &&
        idMoteur !== acc.idMoteur;
      if (!autreAppel) return [slot, acc];
      this.indexReutilise = true;
    }
    const neuf = this.toolCallsAcc.size;
    const appel: AppelEnCours = {
      id: veritePy(idMoteur) ? idMoteur : `call_${neuf}`,
      idMoteur: veritePy(idMoteur) ? idMoteur : null,
      type: "function",
      function: { name: "", arguments_parts: [] },
    };
    this.toolCallsAcc.set(neuf, appel);
    this.slotParIndex.set(index, neuf);
    return [neuf, appel];
  }
}

/** Découpeur `<think>` fourni par l'appelant (son état survit d'un morceau à l'autre). */
export interface DecoupeurPensee {
  feed(morceau: string): [string, string][];
  flush(): [string, string][];
  readonly inThink: boolean;
}

/** Ce que la consommation lit d'une réponse en flux. */
export interface FluxSse {
  aiterLines(): AsyncIterable<string>;
  aclose(): Promise<void>;
}

export interface OptionsConsommation {
  tagSplitter: DecoupeurPensee;
  reqId: string;
  userId: unknown;
  isCancelled?: (() => boolean) | null;
  signal?: AbortSignal;
  onThinkingToken?: ((t: string) => Promise<void> | void) | null;
  onContentToken?: ((t: string) => Promise<void> | void) | null;
  onToolCallDelta?: ((i: unknown, nom: string, args: string) => Promise<void> | void) | null;
  onPromptProgress?: ((p: Dict) => Promise<void> | void) | null;
  sink?: SseStreamResult | null;
}

/** Premier élément de `choices` (`(chunk.get("choices") or [{}])[0]`), levant comme Python sur une forme cassée. */
function premierChoix(choix: unknown): unknown {
  if (Array.isArray(choix)) return choix[0];
  if (typeof choix === "string") return choix.charAt(0);
  throw Object.assign(new Error("0"), { name: "KeyError" });
}

/** Rappel d'affichage ou fermeture : une erreur n'interrompt jamais le flux. */
async function auMieux(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
}

/** Consomme le flux SSE de llama-server ou d'un OpenAI-compatible : annulation, usage, raisonnement (`reasoning_content` ou `reasoning`), appels d'outils, contenu. */
export async function consumeLlamaSse(resp: FluxSse, o: OptionsConsommation): Promise<SseStreamResult> {
  const r = o.sink ?? new SseStreamResult();
  let slotJournalise = false;
  const decoupeur = o.tagSplitter;
  for await (const brute of resp.aiterLines()) {
    if ((o.isCancelled && o.isCancelled()) || o.signal?.aborted) {
      log.info(`[LLM_REQ ${o.reqId}] CANCEL mid-stream → fermeture stream`);
      await auMieux(() => resp.aclose());
      throw new CancelledError("User cancelled mid-stream");
    }
    let ligne = stripPy(brute);
    if (!ligne || ligne === "data: [DONE]") continue;
    const ligneErreur = ligne.startsWith("error:");
    if (ligneErreur) ligne = stripPy(ligne.slice(6));
    else if (ligne.startsWith("data:")) ligne = stripPy(ligne.slice(5));
    let morceau: unknown;
    try {
      morceau = parseJsonPy(ligne);
    } catch {
      if (ligneErreur) throw sseError(ligne);
      continue;
    }
    if (ligneErreur) throw sseError(estDict(morceau) ? getPy(morceau, "error", morceau) : morceau);
    if (!estDict(morceau)) continue;
    const chunk = morceau;
    if (veritePy(getPy(chunk, "error")) && !veritePy(getPy(chunk, "choices"))) throw sseError(chunk["error"]);
    if (veritePy(getPy(chunk, "usage"))) r.usage = chunk["usage"] as Dict;
    if (veritePy(getPy(chunk, "timings"))) r.timings = chunk["timings"] as Dict;
    if (!r.completionId && veritePy(getPy(chunk, "id"))) r.completionId = strPy(chunk["id"]);
    const pp = getPy(chunk, "prompt_progress");
    if (estDict(pp) && Object.keys(pp).length > 0) {
      r.promptProgress = pp;
      if (o.onPromptProgress) {
        const surProgression = o.onPromptProgress;
        await auMieux(() => surProgression(pp));
      }
      continue;
    }
    if (!slotJournalise) {
      let slot = getPy(chunk, "id_slot");
      if (slot === null || slot === undefined) {
        const c = getPy(chunk, "choices");
        slot = getPy(premierChoix(veritePy(c) ? c : [{}]), "id_slot");
      }
      if (slot !== null && slot !== undefined) {
        log.info(`[LLM_REQ ${o.reqId}] SLOT=${strPy(slot)} assigné (user=${strPy(o.userId)})`);
        slotJournalise = true;
      }
    }
    const c = getPy(chunk, "choices");
    const choix = veritePy(c) ? c : [];
    if (!veritePy(choix)) continue;
    const choice = premierChoix(choix);
    if (veritePy(getPy(choice, "finish_reason"))) r.finishReason = getPy(choice, "finish_reason");
    const d = getPy(choice, "delta");
    const delta = veritePy(d) ? d : {};
    const rc = texteReflexion(delta);
    const utile = rc || veritePy(getPy(delta, "tool_calls")) || veritePy(getPy(delta, "content"));
    if (r.premierMs === null && utile) r.premierMs = performance.now();
    if (rc) {
      r.streamPreEmittedThinking = true;
      r.thinkingParts.push(rc);
      if (o.onThinkingToken) await o.onThinkingToken(rc);
    }
    const tcDeltas = getPy(delta, "tool_calls");
    if (veritePy(tcDeltas)) {
      for (const tcd of iterExige(tcDeltas)) {
        const fb = getPy(tcd, "function");
        const fn = veritePy(fb) ? fb : {};
        const n = getPy(fn, "name");
        const nomDelta = (veritePy(n) ? n : "") as string;
        const idMoteur = getPy(tcd, "id");
        const dejaReutilise = r.indexReutilise;
        const [i, acc] = r.appelPour(getPy(tcd, "index", 0), idMoteur, nomDelta);
        if (r.indexReutilise && !dejaReutilise)
          log.warn(
            `[LLM_REQ ${o.reqId}] le moteur réutilise l'index d'un appel d'outil déjà nommé — appel distinct ouvert ` +
              "(sinon deux appels fusionnés en un nom collé)",
          );
        if (veritePy(idMoteur) && !veritePy(acc.idMoteur)) acc.idMoteur = idMoteur;
        if (veritePy(idMoteur)) acc.id = idMoteur;
        const a = getPy(fn, "arguments");
        let argsDelta: unknown = veritePy(a) ? a : "";
        if (typeof argsDelta !== "string") argsDelta = pyJsonDumps(argsDelta, { ensureAscii: false });
        if (nomDelta) acc.function.name += nomDelta;
        if (argsDelta) acc.function.arguments_parts.push(argsDelta as string);
        if (o.onToolCallDelta && (nomDelta || argsDelta)) {
          const surAppel = o.onToolCallDelta;
          await auMieux(() => surAppel(i, nomDelta, argsDelta as string));
        }
      }
    }
    const ct = getPy(delta, "content");
    if (!veritePy(ct)) continue;
    for (const [genre, segment] of decoupeur.feed(ct as string)) {
      if (genre === "thinking" && r.streamPreEmittedThinking) {
        r.reroutedThinkChars += longueurPy(segment);
        if (r.reroutedThinkChars >= 200 && !r.reroutedThinkWarned) {
          r.reroutedThinkWarned = true;
          log.warn(
            `[LLM_REQ ${o.reqId}] garde anti-écho : bloc <think> tardif rerouté en content (≥200 chars cumulés) — ` +
              "possible raisonnement résiduel affiché en réponse.",
          );
        }
        r.contentParts.push(segment);
        if (o.onContentToken) await o.onContentToken(segment);
      } else if (genre === "thinking") {
        r.thinkingParts.push(segment);
        if (o.onThinkingToken) await o.onThinkingToken(segment);
      } else {
        r.contentParts.push(segment);
        if (o.onContentToken) await o.onContentToken(segment);
      }
    }
    r.inThink = decoupeur.inThink;
  }
  for (const [genre, segment] of decoupeur.flush()) {
    if (genre === "thinking") {
      r.thinkingParts.push(segment);
      if (o.onThinkingToken) await o.onThinkingToken(segment);
    } else {
      r.contentParts.push(segment);
      if (o.onContentToken) await o.onContentToken(segment);
    }
  }
  r.inThink = decoupeur.inThink;
  finDeFlux(r);
  return r;
}

/** Jetons repris du cache KV sous `cache_read_input_tokens` (inclus dans `prompt_tokens`) ; appel versé à l'exécution courante. */
export function finDeFlux(r: SseStreamResult): void {
  const u = r.usage;
  observerUsage(u);
  if (estDict(u) && Object.keys(u).length > 0 && !Object.hasOwn(u, "cache_read_input_tokens")) {
    const det = getPy(u, "prompt_tokens_details");
    let cache: unknown = estDict(det) ? getPy(det, "cached_tokens") : null;
    if ((cache === null || cache === undefined) && estDict(r.timings)) cache = getPy(r.timings, "cache_n");
    let n: number;
    try {
      n = intPy(veritePy(cache) ? cache : 0);
    } catch (e) {
      if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
      n = 0;
    }
    if (n > 0) u["cache_read_input_tokens"] = n;
  }
  r.finMs ??= performance.now();
  if (Object.keys(r.timings).length === 0 && moteurSansTimings()) {
    const t = timingsMesures(r);
    if (t !== null) r.timings = t;
  }
  try {
    executions().ajouterAppelLlm(r.timings);
  } catch {
    log.debug("[runs] appel LLM non compté");
  }
}

function moteurSansTimings(): boolean {
  try {
    return currentEngine().profil.capacites.timingsMesures;
  } catch {
    return false;
  }
}

function entierUsage(u: Dict, cle: string): number {
  const v = getPy(u, cle);
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** `timings` à la forme de llama.cpp mesurés par Elpis ; prefill (délai du premier delta) seulement si l'usage rapporte le cache. */
export function timingsMesures(r: SseStreamResult): Dict | null {
  if (r.debutMs === null || r.premierMs === null || !estDict(r.usage)) return null;
  const entree = entierUsage(r.usage, "prompt_tokens");
  const sortie = entierUsage(r.usage, "completion_tokens");
  const cacheRapporte = estDict(getPy(r.usage, "prompt_tokens_details"));
  if (sortie <= 0 && (entree <= 0 || !cacheRapporte)) return null;
  const fin = r.finMs ?? performance.now();
  const generation: Dict = {
    predicted_n: sortie,
    predicted_ms: Math.round(Math.max(0, fin - r.premierMs) * 10) / 10,
  };
  if (!cacheRapporte) return { ...generation, source: "elpis" };
  const cache = Math.min(entree, entierUsage(r.usage, "cache_read_input_tokens"));
  return {
    prompt_n: entree - cache,
    prompt_ms: Math.round(Math.max(0, r.premierMs - r.debutMs) * 10) / 10,
    ...generation,
    cache_n: cache,
    source: "elpis",
  };
}
