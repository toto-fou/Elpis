// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/openai-compat.ts — transport OpenAI-compatible : endpoint, en-têtes, sampling distant validé, payload assaini hors llama.cpp (dialecte étendu de vLLM et SGLang gardé). */
import { ErreurPython, intPy, stripPy, strPy, urlsplit, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { estDict } from "../../python";
import type { Dict } from "../../python";
import type { LlmTarget } from "../cible";
import { getLlmClient, sansBarresFinales } from "../client-http";
import type { ClientHttp } from "../client-http";
import { sanitizeOverride } from "../parametres";
import { aDialecteEtendu, profilDuType } from "../profils";

/** Ce qu'un adaptateur lit d'une cible. */
export type CibleTransport = Pick<LlmTarget, "isDefault" | "baseUrl" | "apiKey" | "providerType" | "model">;

/** Champs standard de l'API chat/completions : seuls gardés hors llama.cpp, vLLM et SGLang. */
export const OPENAI_STD_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "tools",
  "tool_choice",
  "user",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "n",
  "response_format",
  "logprobs",
  "top_logprobs",
  "logit_bias",
]);

/** Dialecte llama.cpp = type du fournisseur seul (un moteur local vLLM est assaini). */
export function isLlamaNative(target: Pick<LlmTarget, "providerType">): boolean {
  return profilDuType(target.providerType).dialecte.natif;
}

function joindre(base: string, suffixe: string): string {
  const b = sansBarresFinales(stripPy(base || ""));
  return b.endsWith(suffixe) ? b : b + suffixe;
}

export function chatCompletionsUrl(target: CibleTransport): string {
  if (target.isDefault || !target.baseUrl) return config.LLAMA_URL;
  return joindre(target.baseUrl, "/chat/completions");
}

/** URL `GET /models` (découverte) de la cible. */
export function modelsUrl(target: CibleTransport): string {
  if (target.isDefault || !target.baseUrl) {
    const p = urlsplit(config.LLAMA_URL);
    return `${p.scheme}://${p.netloc}/v1/models`;
  }
  let base = sansBarresFinales(stripPy(target.baseUrl || ""));
  if (base.endsWith("/chat/completions")) base = base.slice(0, -"/chat/completions".length);
  return sansBarresFinales(base) + "/models";
}

/** En-tête Bearer : clé du connecteur, ou `llama.api_key` du moteur intégré s'il en déclare une. */
export function headers(target: Pick<CibleTransport, "isDefault" | "apiKey">): Record<string, string> {
  const h: Record<string, string> = {};
  const cle = target.isDefault ? stripPy(config.LLAMA_API_KEY || "") : target.apiKey;
  if (cle) h["Authorization"] = `Bearer ${cle}`;
  return h;
}

/** `[client, url chat/completions, en-têtes]` de la cible (client dédié pour un fournisseur distant). */
export function endpoint(target: CibleTransport): [ClientHttp, string, Record<string, string>] {
  const base = target.isDefault ? "" : target.baseUrl;
  return [getLlmClient(base || null), chatCompletionsUrl(target), headers(target)];
}

const REMOTE_SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
];

/** Sous-ensemble OpenAI-standard de la surcharge UI, VALIDÉ, pour une cible distante (« 0 = illimité » retiré) ; vLLM et SGLang reçoivent aussi l'échantillonnage étendu. */
export function remoteSampling(
  samplingOverride: unknown,
  target: Pick<CibleTransport, "providerType"> | null = null,
): Dict {
  const sortie: Dict = {};
  if (!estDict(samplingOverride)) return sortie;
  let propre: Dict;
  try {
    propre = sanitizeOverride(samplingOverride);
  } catch {
    propre = {};
  }
  for (const k of REMOTE_SAMPLING_KEYS) {
    let v: unknown;
    if (Object.hasOwn(propre, k)) v = propre[k];
    else
      v =
        k === "stop" || k === "max_completion_tokens"
          ? Object.hasOwn(samplingOverride, k)
            ? samplingOverride[k]
            : null
          : null;
    if (v === null || v === undefined) continue;
    if (k === "max_tokens" || k === "max_completion_tokens") {
      try {
        if (intPy(v) <= 0) continue;
      } catch (e) {
        if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) continue;
        throw e;
      }
    }
    sortie[k] = v;
  }
  if (target !== null && aDialecteEtendu(target.providerType)) Object.assign(sortie, samplingEtendu(propre));
  return sortie;
}

/** `top_k` (0 = désactivé chez llama.cpp, refusé par SGLang : -1), `min_p`, `repeat_penalty` → `repetition_penalty`. */
function samplingEtendu(propre: Dict): Dict {
  const sortie: Dict = {};
  const topK = propre["top_k"];
  if (typeof topK === "number") sortie["top_k"] = topK > 0 ? topK : -1;
  if (typeof propre["min_p"] === "number") sortie["min_p"] = propre["min_p"];
  if (typeof propre["repeat_penalty"] === "number") sortie["repetition_penalty"] = propre["repeat_penalty"];
  return sortie;
}

const REASONING_REJECTED_SAMPLING = [
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "logit_bias",
];

const OPENAI_REASONING_RE = /^(?:[\p{L}\p{N}_.-]+\/)?(?:o\p{Nd}+(?:$|-)|gpt-5(?!-chat))/iu;

/** o1/o3/o4-mini/gpt-5… (préfixe `openai/` des routeurs toléré) ; `gpt-5-chat-*` n'en est pas un. */
export function isOpenaiReasoningModel(model: unknown): boolean {
  return veritePy(model) && OPENAI_REASONING_RE.test(stripPy(strPy(model)));
}

/** Retire en place les champs hors standard pour un fournisseur non llama.cpp (vLLM et SGLang gardent leur dialecte étendu) ; `max_completion_tokens` pour les modèles de raisonnement OpenAI. */
export function sanitizePayload(payload: Dict, target: Pick<CibleTransport, "providerType" | "model">): Dict {
  if (isLlamaNative(target)) return payload;
  const etendus = profilDuType(target.providerType).dialecte.champsEtendus;
  for (const k of Object.keys(payload))
    if (!OPENAI_STD_FIELDS.has(k) && !etendus.has(k)) Reflect.deleteProperty(payload, k);
  const modele = veritePy(payload["model"]) ? payload["model"] : target.model;
  if (isOpenaiReasoningModel(modele)) {
    if (Object.hasOwn(payload, "max_tokens")) {
      const mt = payload["max_tokens"];
      Reflect.deleteProperty(payload, "max_tokens");
      if (!Object.hasOwn(payload, "max_completion_tokens")) payload["max_completion_tokens"] = mt;
    }
    for (const k of REASONING_REJECTED_SAMPLING) Reflect.deleteProperty(payload, k);
  }
  return payload;
}
