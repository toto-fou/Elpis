// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/anthropic.ts — adaptateur natif de l'API Messages d'Anthropic : traduction OpenAI → Anthropic, flux SSE normalisé vers les mêmes rappels. */
import { ErreurPython, intPy, pyJsonDumps, stripPy, strPy, veritePy } from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";

import { journal } from "../../journal";
import { estDict } from "../../python";
import type { Dict } from "../../python";
import { avecFlux, CancelledError, estAnnulation, getLlmClient, sansBarresFinales } from "../client-http";
import type { ReponseFlux } from "../client-http";
import { getPy, iterExige, mettreAJourPy } from "../dict-py";
import { measureThinkingTokens } from "../jetons-raisonnement";
import { executions } from "../ports";
import {
  KIND_UNKNOWN,
  llmErrorIsFatal,
  llmErrorKind,
  llmErrorUserMessage,
  noteLlmSuccess,
  providerHttpError,
  retryPause,
} from "../reprises";
import type { CibleTransport } from "./openai-compat";

const log = journal("anthropic");

export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS_CHAT = 8192;
const DEFAULT_MAX_TOKENS_THINKING = 16000;
const MAX_TOKENS_CEILING = 64000;
const DEFAULT_THINKING_BUDGET = 10000;

/** Type d'un événement `error` du flux → code HTTP que l'API aurait rendu. */
export const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/** Cible d'Anthropic : base, clé, modèle. */
export type CibleAnthropic = Pick<CibleTransport, "baseUrl" | "apiKey" | "model">;

/** Racine de l'API (sans `/v1` ni `/v1/messages`). */
export function apiRoot(target: CibleAnthropic): string {
  const base = sansBarresFinales(stripPy(target.baseUrl || "https://api.anthropic.com"));
  for (const suffixe of ["/v1/messages", "/v1"])
    if (base.endsWith(suffixe)) return base.slice(0, -suffixe.length);
  return base;
}

export function messagesUrl(target: CibleAnthropic): string {
  return apiRoot(target) + "/v1/messages";
}

export function buildHeaders(target: Pick<CibleAnthropic, "apiKey">): Record<string, string> {
  return {
    "x-api-key": target.apiKey || "",
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

/** `data:image/png;base64,XXXX` → `[media, b64]`, sinon `null`. */
export function parseDataUrl(url: unknown): [string, string] | null {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const virgule = url.indexOf(",");
  if (virgule < 0) return null;
  const tete = url.slice(0, virgule);
  const media = tete.slice(5).split(";", 1)[0] || "image/png";
  return [media, url.slice(virgule + 1)];
}

function vrai(v: unknown): boolean {
  return veritePy(v);
}

function exigerTexte(v: unknown): string {
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${typeof v}' object has no attribute 'strip'`);
  return v;
}

/** `content` OpenAI (texte ou liste multimodale) → blocs Anthropic ; jamais de bloc texte vide ou blanc. */
export function contentToAnthropicBlocks(content: unknown): Dict[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return stripPy(content) ? [{ type: "text", text: content }] : [];
  const blocs: Dict[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!estDict(part)) {
        if (typeof part === "string" && stripPy(part)) blocs.push({ type: "text", text: part });
        continue;
      }
      const type = getPy(part, "type");
      if (type === "text") {
        const brut = getPy(part, "text");
        const texte = exigerTexte(vrai(brut) ? brut : "");
        if (stripPy(texte)) blocs.push({ type: "text", text: texte });
      } else if (type === "image_url") {
        const iu = getPy(part, "image_url");
        const u = getPy(vrai(iu) ? iu : {}, "url");
        const url = vrai(u) ? u : "";
        const lu = parseDataUrl(url);
        if (lu) blocs.push({ type: "image", source: { type: "base64", media_type: lu[0], data: lu[1] } });
        else if (vrai(url)) blocs.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocs;
}

/** `json.dumps(v, ensure_ascii=False)` ; `undefined` s'écrit `null`. */
function ecrireJsonPy(v: unknown): string {
  return pyJsonDumps(v === undefined ? null : v, { ensureAscii: false });
}

/** `[system, messages]` Anthropic depuis l'historique OpenAI (pure) ; sans outils, appels et résultats rendus en texte. */
export function toAnthropicMessages(
  messages: readonly unknown[] | null | undefined,
  options: { withTools?: boolean } = {},
): [string, Dict[]] {
  const avecOutils = options.withTools ?? true;
  const systeme: string[] = [];
  const sortie: Dict[] = [];
  for (const m of messages ?? []) {
    const role = getPy(m, "role");
    if (role === "system") {
      const c = getPy(m, "content");
      if (typeof c === "string" && c) systeme.push(c);
      else if (Array.isArray(c))
        for (const b of contentToAnthropicBlocks(c))
          if (b["type"] === "text") systeme.push(b["text"] as string);
      continue;
    }
    if (role === "tool" && !avecOutils) {
      let res = getPy(m, "content");
      if (typeof res !== "string") res = ecrireJsonPy(res);
      if (stripPy((res as string) || "")) {
        const nom = getPy(m, "name");
        sortie.push({
          role: "user",
          content: [
            {
              type: "text",
              text: stripPy(`[résultat d'outil ${strPy(vrai(nom) ? nom : "")}]\n${res as string}`),
            },
          ],
        });
      }
      continue;
    }
    if (role === "tool") {
      const c = getPy(m, "content");
      const id = vrai(getPy(m, "tool_call_id")) ? getPy(m, "tool_call_id") : getPy(m, "id");
      sortie.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: vrai(id) ? id : "",
            content: typeof c === "string" ? c : ecrireJsonPy(c),
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      let blocs = contentToAnthropicBlocks(getPy(m, "content"));
      const pense = avecOutils ? getPy(m, "_anthropic_thinking") : null;
      if (Array.isArray(pense) && vrai(getPy(m, "tool_calls")))
        blocs = [...pense.filter((b) => estDict(b)).map((b) => ({ ...(b as Dict) })), ...blocs];
      for (const tc of iterExige(vrai(getPy(m, "tool_calls")) ? getPy(m, "tool_calls") : [])) {
        const fnBrut = getPy(tc, "function");
        const fn = vrai(fnBrut) ? fnBrut : {};
        let args = getPy(fn, "arguments");
        if (typeof args === "string") {
          try {
            args = stripPy(args) ? parseJsonPy(args) : {};
          } catch {
            args = { _raw: args };
          }
        }
        const nom = getPy(fn, "name");
        if (!avecOutils) {
          blocs.push({
            type: "text",
            text: `[appel d'outil ${strPy(vrai(nom) ? nom : "")}] ${ecrireJsonPy(args)}`,
          });
          continue;
        }
        const id = getPy(tc, "id");
        blocs.push({
          type: "tool_use",
          id: vrai(id) ? id : "",
          name: vrai(nom) ? nom : "",
          input: estDict(args) ? args : {},
        });
      }
      if (blocs.length > 0) sortie.push({ role: "assistant", content: blocs });
      continue;
    }
    const blocs = contentToAnthropicBlocks(getPy(m, "content"));
    if (blocs.length > 0) sortie.push({ role: "user", content: blocs });
  }
  return [stripPy(systeme.filter((s) => s).join("\n\n")), mergeSameRoles(sortie)];
}

/** Rôles consécutifs identiques fusionnés (alternance stricte), `tool_result` en tête d'un user. */
export function mergeSameRoles(msgs: Dict[]): Dict[] {
  const sortie: Dict[] = [];
  for (const m of msgs) {
    const dernier = sortie[sortie.length - 1];
    if (dernier !== undefined && dernier["role"] === m["role"])
      sortie[sortie.length - 1] = {
        role: m["role"],
        content: [...(dernier["content"] as unknown[]), ...(m["content"] as unknown[])],
      };
    else sortie.push(m);
  }
  for (const m of sortie) {
    if (m["role"] !== "user") continue;
    const blocs = m["content"] as Dict[];
    const resultats = blocs.filter((b) => getPy(b, "type") === "tool_result");
    if (resultats.length > 0)
      m["content"] = [...resultats, ...blocs.filter((b) => getPy(b, "type") !== "tool_result")];
  }
  return sortie;
}

/** `tools[]` OpenAI → schéma d'outils Anthropic (pure). */
export function toAnthropicTools(toolsPayload: readonly unknown[] | null | undefined): Dict[] {
  const sortie: Dict[] = [];
  for (const t of toolsPayload ?? []) {
    const f = getPy(t, "function");
    const fn = vrai(f) ? f : t;
    const nom = getPy(fn, "name");
    if (!vrai(nom)) continue;
    const description = getPy(fn, "description");
    const parametres = getPy(fn, "parameters");
    sortie.push({
      name: nom,
      description: vrai(description) ? description : "",
      input_schema: vrai(parametres) ? parametres : { type: "object", properties: {} },
    });
  }
  return sortie;
}

function resolveMaxTokens(samplingOverride: unknown, thinkingMode: boolean): number {
  if (estDict(samplingOverride)) {
    for (const k of ["max_tokens", "max_completion_tokens"]) {
      const v = getPy(samplingOverride, k);
      if ((typeof v === "number" || typeof v === "boolean") && Number(v) > 0)
        return Math.min(intPy(v), MAX_TOKENS_CEILING);
    }
  }
  return Math.min(thinkingMode ? DEFAULT_MAX_TOKENS_THINKING : DEFAULT_MAX_TOKENS_CHAT, MAX_TOKENS_CEILING);
}

const CLAUDE_VERSION_RE = /claude-(?:opus|sonnet|haiku)-(\p{Nd}+)(?:-(\p{Nd}{1,2}))?(?!\p{Nd})/u;
const CLAUDE_LEGACY_RE = /claude-(\p{Nd}+)(?:-(\p{Nd}))?-(?:opus|sonnet|haiku)/u;

/** `[majeur, mineur]` d'un identifiant Claude, `null` si inconnu (alias maison). */
export function claudeVersion(model: string | null | undefined): [number, number] | null {
  const m = CLAUDE_VERSION_RE.exec(model || "") ?? CLAUDE_LEGACY_RE.exec(model || "");
  if (m === null) return null;
  return [intPy(m[1]), intPy(m[2] || 0)];
}

/** Paramètre `thinking` adapté au modèle (pure) : `adaptive` dès 4.6 ou inconnu, budget avant, rien avant 3.7. */
export function thinkingConfig(model: string, maxTokens: number): Dict | null {
  const v = claudeVersion(model);
  if (v === null || v[0] > 4 || (v[0] === 4 && v[1] >= 6)) return { type: "adaptive", display: "summarized" };
  if (v[0] < 3 || (v[0] === 3 && v[1] < 7)) return null;
  const budget = Math.min(DEFAULT_THINKING_BUDGET, intPy(maxTokens) - 1024);
  if (budget < 1024) return null;
  return { type: "enabled", budget_tokens: budget };
}

/** Corps `/v1/messages` (pure) : pas de sampling, `thinking` seulement sans outils. */
export function buildBody(
  target: CibleAnthropic,
  messages: readonly unknown[],
  options: {
    toolsPayload?: readonly unknown[] | null;
    samplingOverride?: unknown;
    thinkingMode?: boolean;
    model?: string | null;
    stream?: boolean;
  } = {},
): Dict {
  const outils = toAnthropicTools(options.toolsPayload ?? null);
  const [systeme, msgs] = toAnthropicMessages(messages, { withTools: outils.length > 0 });
  const corps: Dict = {
    model: options.model || target.model || DEFAULT_ANTHROPIC_MODEL,
    messages: msgs,
    max_tokens: resolveMaxTokens(options.samplingOverride, options.thinkingMode ?? false),
    stream: options.stream ?? true,
  };
  if (systeme) corps["system"] = systeme;
  if (outils.length > 0) corps["tools"] = outils;
  if ((options.thinkingMode ?? false) && outils.length === 0) {
    const cfg = thinkingConfig(corps["model"] as string, corps["max_tokens"] as number);
    if (cfg) corps["thinking"] = cfg;
  }
  return corps;
}

/** Objets `data:` JSON d'un flux SSE Anthropic. */
export async function* iterSse(resp: Pick<ReponseFlux, "aiterLines">): AsyncGenerator<unknown> {
  for await (const brut of resp.aiterLines()) {
    let ligne = stripPy(brut || "");
    if (!ligne || ligne.startsWith("event:") || ligne.startsWith(":")) continue;
    if (ligne.startsWith("data:")) ligne = stripPy(ligne.slice(5));
    if (!ligne || ligne === "[DONE]") continue;
    try {
      yield parseJsonPy(ligne);
    } catch {
      continue;
    }
  }
}

export type SurJeton = ((jeton: string) => Promise<void> | void) | null | undefined;
export type SurAppel =
  ((index: number, nom: string, args: string) => Promise<void> | void) | null | undefined;

interface Rappels {
  onContentToken?: SurJeton;
  onThinkingToken?: SurJeton;
  onToolCallDelta?: SurAppel;
  isCancelled?: (() => boolean) | null;
  signal?: AbortSignal;
}

async function sansErreur(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch {
    // pré-affichage au mieux
  }
}

/** Ouvre `/v1/messages` et consomme le flux : `{content, thinking, tool_calls, thinking_blocks, usage, stop_reason, model}`. */
export async function consumeStream(target: CibleAnthropic, body: Dict, rappels: Rappels): Promise<Dict> {
  const client = getLlmClient(target.baseUrl || "https://api.anthropic.com");
  const url = messagesUrl(target);
  const contenu: string[] = [];
  const pensees: string[] = [];
  const blocsPensee: Dict[] = [];
  const blocs = new Map<unknown, Dict>();
  const appels: Dict[] = [];
  let argsTronques = false;
  const usage: Dict = {};
  let stopReason = "";
  let modele = (body["model"] as string | undefined) ?? "";
  let prochainIndex = 0;
  await avecFlux(
    client,
    "POST",
    url,
    { json: body, headers: buildHeaders(target), signal: rappels.signal },
    async (resp) => {
      if (resp.statusCode >= 400) {
        const texte = new TextDecoder("utf-8").decode(await resp.aread());
        throw providerHttpError(resp.statusCode, texte, {
          url,
          headers: resp.headers,
          message: `Anthropic ${resp.statusCode}: ${[...texte].slice(0, 500).join("")}`,
        });
      }
      for await (const ev of iterSse(resp)) {
        if ((rappels.isCancelled && rappels.isCancelled()) || rappels.signal?.aborted) {
          await resp.aclose();
          throw new CancelledError("User cancelled mid-stream");
        }
        const type = getPy(ev, "type");
        if (type === "message_start") {
          const mb = getPy(ev, "message");
          const msg = vrai(mb) ? mb : {};
          const m = getPy(msg, "model");
          if (vrai(m)) modele = m as string;
          const ub = getPy(msg, "usage");
          if (vrai(ub)) mettreAJourPy(usage, ub);
        } else if (type === "content_block_start") {
          const idx = getPy(ev, "index", 0);
          const cbb = getPy(ev, "content_block");
          const cb = vrai(cbb) ? cbb : {};
          const btype = getPy(cb, "type");
          if (btype === "tool_use") {
            const oai = prochainIndex++;
            const nom = getPy(cb, "name");
            blocs.set(idx, {
              type: "tool_use",
              tool: {
                id: vrai(getPy(cb, "id")) ? getPy(cb, "id") : `call_${oai}`,
                name: vrai(nom) ? nom : "",
                buf: "",
                oai_index: oai,
              },
            });
            if (rappels.onToolCallDelta) {
              const f = rappels.onToolCallDelta;
              await sansErreur(() => f(oai, (vrai(nom) ? nom : "") as string, ""));
            }
          } else if (btype === "thinking") {
            const t = getPy(cb, "thinking");
            const sig = getPy(cb, "signature");
            blocs.set(idx, {
              type: "thinking",
              block: { type: "thinking", thinking: vrai(t) ? t : "", signature: vrai(sig) ? sig : "" },
            });
          } else if (btype === "redacted_thinking")
            blocs.set(idx, { type: "redacted_thinking", block: { ...(cb as Dict) } });
          else blocs.set(idx, { type: btype });
        } else if (type === "content_block_delta") {
          const idx = getPy(ev, "index", 0);
          const db = getPy(ev, "delta");
          const delta = vrai(db) ? db : {};
          const dtype = getPy(delta, "type");
          if (dtype === "text_delta") {
            const t = getPy(delta, "text");
            const texte = (vrai(t) ? t : "") as string;
            if (texte) {
              contenu.push(texte);
              if (rappels.onContentToken) await rappels.onContentToken(texte);
            }
          } else if (dtype === "thinking_delta") {
            const t = getPy(delta, "thinking");
            const th = (vrai(t) ? t : "") as string;
            const bloc = blocs.get(idx);
            if (th && bloc && bloc["type"] === "thinking") (bloc["block"] as Dict)["thinking"] += th;
            if (th) {
              pensees.push(th);
              if (rappels.onThinkingToken) await rappels.onThinkingToken(th);
            }
          } else if (dtype === "signature_delta") {
            const bloc = blocs.get(idx);
            const s = getPy(delta, "signature");
            if (bloc && bloc["type"] === "thinking")
              (bloc["block"] as Dict)["signature"] += (vrai(s) ? s : "") as string;
          } else if (dtype === "input_json_delta") {
            const f = getPy(delta, "partial_json");
            const frag = (vrai(f) ? f : "") as string;
            const bloc = blocs.get(idx);
            if (bloc && bloc["type"] === "tool_use") {
              const outil = bloc["tool"] as Dict;
              outil["buf"] += frag;
              if (rappels.onToolCallDelta && frag) {
                const rappel = rappels.onToolCallDelta;
                await sansErreur(() => rappel(outil["oai_index"] as number, "", frag));
              }
            }
          }
        } else if (type === "content_block_stop") {
          const bloc = blocs.get(getPy(ev, "index", 0));
          if (bloc && (bloc["type"] === "thinking" || bloc["type"] === "redacted_thinking"))
            blocsPensee.push(bloc["block"] as Dict);
          if (bloc && bloc["type"] === "tool_use") {
            const outil = bloc["tool"] as Dict;
            let args = stripPy(outil["buf"] as string) || "{}";
            try {
              parseJsonPy(args);
            } catch {
              argsTronques = true;
              args = "{}";
            }
            appels.push({
              id: outil["id"],
              type: "function",
              function: { name: outil["name"], arguments: args },
            });
          }
        } else if (type === "message_delta") {
          const db = getPy(ev, "delta");
          const d = vrai(db) ? db : {};
          if (vrai(getPy(d, "stop_reason"))) stopReason = getPy(d, "stop_reason") as string;
          const ub = getPy(ev, "usage");
          if (vrai(ub)) mettreAJourPy(usage, ub);
        } else if (type === "error") {
          const eb = getPy(ev, "error");
          let err: unknown = vrai(eb) ? eb : {};
          if (!estDict(err)) err = { message: strPy(err) };
          const e = err as Dict;
          const typeErr = vrai(e["type"]) ? strPy(e["type"]) : "";
          const code = Object.hasOwn(STREAM_ERROR_STATUS, typeErr)
            ? (STREAM_ERROR_STATUS[typeErr] ?? 500)
            : 500;
          throw providerHttpError(code, ecrireJsonPy(ev), {
            url,
            message: `Anthropic stream error (${vrai(e["type"]) ? strPy(e["type"]) : code}): ${strPy(vrai(e["message"]) ? e["message"] : e)}`,
          });
        } else if (type === "message_stop") break;
      }
    },
  );
  try {
    executions().ajouterAppelLlm(null);
  } catch {
    log.debug("[runs] appel LLM non compté");
  }
  return {
    content: stripPy(contenu.join("")),
    thinking: stripPy(pensees.join("")),
    tool_calls: appels,
    thinking_blocks: blocsPensee,
    usage: normalizeUsage(usage),
    stop_reason: argsTronques && appels.length > 0 ? "max_tokens" : stopReason,
    model: modele,
  };
}

/** Usage Anthropic → forme OpenAI ; l'entrée INCLUT le cache lu et écrit, comme partout ailleurs. */
export function normalizeUsage(u: Dict): Dict {
  const lu = intPy(vrai(u["cache_read_input_tokens"]) ? u["cache_read_input_tokens"] : 0);
  const ecrit = intPy(vrai(u["cache_creation_input_tokens"]) ? u["cache_creation_input_tokens"] : 0);
  const entree = intPy(vrai(u["input_tokens"]) ? u["input_tokens"] : 0) + lu + ecrit;
  const sortie = intPy(vrai(u["output_tokens"]) ? u["output_tokens"] : 0);
  return {
    prompt_tokens: entree,
    completion_tokens: sortie,
    total_tokens: entree + sortie,
    cache_read_input_tokens: lu,
    cache_creation_input_tokens: ecrit,
  };
}

/** `stop_reason` Anthropic → `finish_reason` OpenAI (« length » avant « tool_calls »). */
export function finishFromStopReason(stopReason: unknown, options: { hasToolCalls: boolean }): string {
  if (stopReason === "max_tokens") return "length";
  if (options.hasToolCalls) return "tool_calls";
  return vrai(stopReason) ? "stop" : "";
}

export interface OptionsChat {
  target: CibleAnthropic;
  model?: string | null;
  onThinkingToken?: SurJeton;
  onContentToken?: SurJeton;
  thinkingMode?: boolean;
  isCancelled?: (() => boolean) | null;
  samplingOverride?: unknown;
  chatId?: string | null;
  signal?: AbortSignal;
}

/** Chemin classique : `[thinking, content, meta]`, relancé tant que rien n'a été streamé et que la panne est transitoire. */
export async function anthropicChatStream(
  messages: readonly unknown[],
  options: OptionsChat,
): Promise<[string, string, Dict]> {
  const body = buildBody(options.target, messages, {
    toolsPayload: null,
    samplingOverride: options.samplingOverride,
    thinkingMode: options.thinkingMode ?? false,
    model: options.model ?? null,
    stream: true,
  });
  let streame = false;
  const marquer = (cb: SurJeton): SurJeton =>
    cb
      ? async (jeton: string): Promise<void> => {
          streame = true;
          await cb(jeton);
        }
      : null;
  const surContenu = marquer(options.onContentToken);
  const surPensee = marquer(options.onThinkingToken);
  let tentative = 0;
  let res: Dict;
  for (;;) {
    try {
      res = await consumeStream(options.target, body, {
        onContentToken: surContenu,
        onThinkingToken: surPensee,
        isCancelled: options.isCancelled,
        signal: options.signal,
      });
      noteLlmSuccess();
      break;
    } catch (e) {
      if (estAnnulation(e)) throw e;
      log.warn(
        `échec stream (essai ${tentative + 1}) : ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
      );
      if (
        tentative < intPy(config.LLAMA_RETRIES) &&
        !streame &&
        !llmErrorIsFatal(e) &&
        llmErrorKind(e) !== KIND_UNKNOWN &&
        !(options.isCancelled && options.isCancelled())
      ) {
        await retryPause(e, tentative, {
          isCancelled: options.isCancelled,
          label: "anthropic_classic",
          signal: options.signal,
        });
        tentative += 1;
        continue;
      }
      return ["", `⚠ Erreur LLM : ${llmErrorUserMessage(e)}`, { usage: {}, timings: {}, error: true }];
    }
  }
  const fin = finishFromStopReason(res["stop_reason"], { hasToolCalls: false });
  const meta: Dict = {
    usage: res["usage"],
    timings: {},
    model: res["model"],
    thinking: res["thinking"],
    finish_reason: fin,
    truncated: fin === "length",
    truncated_in_think: Boolean(fin === "length" && !res["content"] && res["thinking"]),
  };
  try {
    const [tt, estime] = await measureThinkingTokens((res["thinking"] as string) || "", {
      modelId: options.model || null,
      usage: res["usage"],
      outputTokens: getPy(res["usage"] ?? {}, "completion_tokens", 0),
    });
    meta["thinking_tokens"] = tt;
    meta["thinking_tokens_estimated"] = estime;
  } catch (e) {
    log.debug(`tokens de réflexion non mesurés : ${String(e)}`);
  }
  return [res["thinking"] as string, res["content"] as string, meta];
}

/** Chemin outils : dict OpenAI non streamé (`choices`, `usage`, `model`), blocs de réflexion signés gardés pour le rejeu. */
export async function anthropicChatWithToolsStream(
  messages: readonly unknown[],
  toolsPayload: readonly unknown[],
  options: OptionsChat & { onToolCallDelta?: SurAppel },
): Promise<Dict> {
  const body = buildBody(options.target, messages, {
    toolsPayload,
    samplingOverride: options.samplingOverride,
    thinkingMode: options.thinkingMode ?? false,
    model: options.model ?? null,
    stream: true,
  });
  const res = await consumeStream(options.target, body, {
    onContentToken: options.onContentToken,
    onThinkingToken: options.onThinkingToken,
    onToolCallDelta: options.onToolCallDelta,
    isCancelled: options.isCancelled,
    signal: options.signal,
  });
  const message: Dict = { role: "assistant", content: res["content"] || null };
  if (res["thinking"]) message["reasoning_content"] = res["thinking"];
  const appels = res["tool_calls"] as Dict[];
  if (appels.length > 0) {
    message["tool_calls"] = appels;
    if ((res["thinking_blocks"] as Dict[]).length > 0)
      message["_anthropic_thinking"] = res["thinking_blocks"];
  }
  const fin = finishFromStopReason(res["stop_reason"], { hasToolCalls: appels.length > 0 });
  return { choices: [{ index: 0, message, finish_reason: fin }], usage: res["usage"], model: res["model"] };
}
