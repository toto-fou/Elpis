// SPDX-License-Identifier: MIT
/** apps/core/test/llm/faux-vllm-sglang.ts — réponses scriptées au format exact de vLLM 0.31.0 et SGLang 0.5.21 (flux SSE et réponse entière), avec ou sans parseur de réflexion. */

type Dict = Record<string, unknown>;

export type Dialecte = "vllm" | "sglang";

export interface Scenario {
  raisonnement?: string;
  contenu?: string;
  appels?: readonly { nom: string; args: unknown }[];
  fin?: string;
  /** `--reasoning-parser` lancé (défaut) ; sans lui, la réflexion arrive en balises dans le contenu. */
  parseur?: boolean;
  /** Sans parseur : le gabarit ouvre `<think>` dans le prompt (Qwen3.5 et suivants), seule la fermante sort. */
  ouvertureParGabarit?: boolean;
  modele?: string;
}

const ID = "chatcmpl-9f2c4e7a1b3d4c5e8f6a7b8c9d0e1f2a";
const CREE = 1760880000;
/** `<|im_end|>` de Qwen3 : arrêt rapporté par SGLang (`matched_stop`). */
const IM_END = 151645;

/** Jetons courts (mots et espaces), comme un détokeniseur réel ; `</think>` reste un jeton entier. */
export function jetons(texte: string): string[] {
  return texte.match(/<\/think>|\s+|[^\s<]{1,6}|</gu) ?? [];
}

/** Texte brut du modèle quand le serveur n'a pas de parseur de réflexion. */
export function texteBrut(s: Scenario): string {
  const r = s.raisonnement ?? "";
  if (!r) return s.contenu ?? "";
  const ouverture = s.ouvertureParGabarit ? "" : "<think>\n";
  return `${ouverture}${r}\n</think>\n\n${s.contenu ?? ""}`;
}

function fin(s: Scenario): string {
  return s.fin ?? (s.appels?.length ? "tool_calls" : "stop");
}

function usage(dialecte: Dialecte, s: Scenario): Dict {
  const parseur = s.parseur ?? true;
  const raisonnement = parseur ? jetons(s.raisonnement ?? "").length : 0;
  const sortie = jetons(texteBrut(s)).length + (s.appels?.length ?? 0) * 8;
  if (dialecte === "vllm")
    return {
      prompt_tokens: 42,
      total_tokens: 42 + sortie,
      completion_tokens: sortie,
      ...(parseur ? { completion_tokens_details: { reasoning_tokens: raisonnement } } : {}),
    };
  return {
    prompt_tokens: 42,
    total_tokens: 42 + sortie,
    completion_tokens: sortie,
    prompt_tokens_details: null,
    reasoning_tokens: raisonnement,
  };
}

/** Morceaux du flux : `ChatCompletionStreamResponse` de vLLM (`exclude_unset`), `build_sse_content` (msgspec) de SGLang. */
export function morceaux(dialecte: Dialecte, s: Scenario): Dict[] {
  const modele = s.modele ?? "Qwen/Qwen3.6-27B";
  const tete = { id: ID, object: "chat.completion.chunk", created: CREE, model: modele };
  const parseur = s.parseur ?? true;
  const sortie: Dict[] = [];
  const choix = (delta: Dict, finale: string | null = null): Dict => {
    if (dialecte === "vllm")
      return finale === null
        ? { index: 0, delta, logprobs: null, finish_reason: null, token_ids: null }
        : { index: 0, delta, logprobs: null, finish_reason: finale, stop_reason: null, token_ids: null };
    return {
      index: 0,
      delta,
      logprobs: null,
      finish_reason: finale,
      matched_stop: finale === "stop" ? IM_END : null,
    };
  };
  const pousser = (delta: Dict): void => void sortie.push({ ...tete, choices: [choix(delta)] });
  if (dialecte === "vllm")
    sortie.push({
      ...tete,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
    });
  else pousser({ reasoning_content: null, role: "assistant", content: "" });
  if (parseur) {
    for (const t of jetons(s.raisonnement ?? ""))
      pousser(dialecte === "vllm" ? { reasoning: t } : { reasoning_content: t });
    for (const t of jetons(s.contenu ?? ""))
      pousser(dialecte === "vllm" ? { content: t } : { reasoning_content: null, content: t });
  } else
    for (const t of jetons(texteBrut(s)))
      pousser(dialecte === "vllm" ? { content: t } : { reasoning_content: null, content: t });
  (s.appels ?? []).forEach((a, index) => {
    const args = typeof a.args === "string" ? a.args : JSON.stringify(a.args ?? {});
    const appel = (fonction: Dict, debut: boolean): Dict =>
      dialecte === "vllm"
        ? debut
          ? { id: `chatcmpl-tool-${index}a7c`, type: "function", index, function: fonction }
          : { index, function: fonction }
        : { id: debut ? `call_${index}e41` : null, index, type: "function", function: fonction };
    const delta = (fonction: Dict, debut: boolean): Dict =>
      dialecte === "vllm"
        ? { tool_calls: [appel(fonction, debut)] }
        : { role: null, content: null, reasoning_content: null, tool_calls: [appel(fonction, debut)] };
    const brut = (d: Dict): void =>
      void sortie.push({
        ...tete,
        choices: [choix(d)],
        ...(dialecte === "sglang" ? { usage: null } : {}),
      });
    brut(delta({ name: a.nom, arguments: "" }, true));
    for (const p of args.match(/[\s\S]{1,12}/gu) ?? [])
      brut(delta(dialecte === "vllm" ? { arguments: p } : { name: null, arguments: p }, false));
  });
  const vide = dialecte === "vllm" ? { content: "" } : { reasoning_content: null };
  sortie.push({ ...tete, choices: [choix(vide, fin(s))] });
  sortie.push({ ...tete, choices: [], usage: usage(dialecte, s) });
  return sortie;
}

/** Lignes SSE du flux, `data: [DONE]` compris. */
export function lignesSse(dialecte: Dialecte, s: Scenario): string[] {
  return [...morceaux(dialecte, s).map((m) => `data: ${JSON.stringify(m)}`), "data: [DONE]"];
}

/** Réponse entière (`stream: false`) : `ChatMessage.reasoning` chez vLLM, `reasoning_content` chez SGLang. */
export function reponseEntiere(dialecte: Dialecte, s: Scenario): Dict {
  const parseur = s.parseur ?? true;
  const contenu = parseur ? (s.contenu ?? "") : texteBrut(s);
  const raisonnement = parseur && s.raisonnement ? s.raisonnement : null;
  const appels = (s.appels ?? []).map((a, i) => ({
    id: dialecte === "vllm" ? `chatcmpl-tool-${i}a7c` : `call_${i}e41`,
    ...(dialecte === "sglang" ? { index: i } : {}),
    type: "function",
    function: { name: a.nom, arguments: typeof a.args === "string" ? a.args : JSON.stringify(a.args ?? {}) },
  }));
  const message: Dict =
    dialecte === "vllm"
      ? {
          role: "assistant",
          content: contenu,
          refusal: null,
          annotations: null,
          audio: null,
          function_call: null,
          ...(appels.length ? { tool_calls: appels } : {}),
          reasoning: raisonnement,
        }
      : {
          role: "assistant",
          content: contenu,
          reasoning_content: raisonnement,
          tool_calls: appels.length ? appels : null,
        };
  return {
    id: ID,
    object: "chat.completion",
    created: CREE,
    model: s.modele ?? "Qwen/Qwen3.6-27B",
    choices: [
      dialecte === "vllm"
        ? { index: 0, message, logprobs: null, finish_reason: fin(s), stop_reason: null, token_ids: null }
        : { index: 0, message, logprobs: null, finish_reason: fin(s), matched_stop: IM_END },
    ],
    usage: usage(dialecte, s),
  };
}
