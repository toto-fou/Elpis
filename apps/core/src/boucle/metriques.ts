// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/metriques.ts — métriques d'un appel LLM pour la bulle et le message : débits, tokens d'entrée et de sortie, part de réflexion, troncature. */
import { arrondiPy, ErreurPython, FlottantPy, maxPy, minPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { getPy, inPy, itemPy, nomTypePy } from "../llm/dict-py";
import { nativeReasoningTokens } from "../llm/jetons-raisonnement";
import { entierPy, estDict } from "../python";
import type { Dict } from "../python";

/** `ZeroDivisionError` de Python (une durée en millisecondes qui s'annule une fois divisée par 1 000). */
export class ZeroDivisionError extends Error {
  override name = "ZeroDivisionError";
}

/** Nombre au sens de Python (`bool` compris), `null` sinon. */
function nombre(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof FlottantPy) return v.valeur;
  return null;
}

/** `a > b` de Python : TypeError hors des nombres. */
function superieur(a: unknown, b: number): boolean {
  const x = nombre(a);
  if (x === null)
    throw new ErreurPython("TypeError", `'>' not supported between instances of '${nomTypePy(a)}' and 'int'`);
  return x > b;
}

/** `a / b` de Python (division réelle) : TypeError hors des nombres, ZeroDivisionError sur un diviseur nul. */
function diviser(a: unknown, b: unknown): number {
  const [x, y] = [nombre(a), nombre(b)];
  if (x === null || y === null)
    throw new ErreurPython(
      "TypeError",
      `unsupported operand type(s) for /: '${nomTypePy(a)}' and '${nomTypePy(b)}'`,
    );
  if (y === 0) throw new ZeroDivisionError("float division by zero");
  return x / y;
}

/** Une clé à `undefined` est une clé absente (un dict Python n'en a pas). */
function sansIndefinis(d: unknown): unknown {
  return estDict(d) ? Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) : d;
}

/** Débit d'un côté du flux : `*_per_token_ms`, sinon `*_n` sur `*_ms`. */
function debit(timings: unknown, prefixe: "prompt" | "predicted"): number {
  if (inPy(`${prefixe}_per_token_ms`, timings) && superieur(itemPy(timings, `${prefixe}_per_token_ms`), 0))
    return diviser(1000, itemPy(timings, `${prefixe}_per_token_ms`));
  if (
    inPy(`${prefixe}_ms`, timings) &&
    inPy(`${prefixe}_n`, timings) &&
    superieur(itemPy(timings, `${prefixe}_ms`), 0)
  )
    return diviser(itemPy(timings, `${prefixe}_n`), diviser(itemPy(timings, `${prefixe}_ms`), 1000.0));
  return 0.0;
}

/** `calculate_metrics(meta, total_duration)` : débits, sortie décomposée en réflexion et réponse (réflexion ⊆ sortie), troncature, cache et part outils de l'entrée. */
export function calculateMetrics(metaEntree: Dict, totalDuration: number): Dict {
  const meta = sansIndefinis(metaEntree);
  const timings = sansIndefinis(getPy(meta, "timings", {}));
  const usage = sansIndefinis(getPy(meta, "usage", {}));
  const promptTokens = getPy(usage, "prompt_tokens", 0);
  const completionTokens = getPy(usage, "completion_tokens", 0);
  const readSpeed = debit(timings, "prompt");
  let writeSpeed = debit(timings, "predicted");
  if (writeSpeed === 0 && totalDuration > 0 && superieur(completionTokens, 0))
    writeSpeed = diviser(completionTokens, totalDuration);
  const declare = getPy(meta, "thinking_tokens");
  let thinkTokens =
    declare === null ? (nativeReasoningTokens(usage) ?? 0) : entierPy(veritePy(declare) ? declare : 0);
  if (thinkTokens < 0) thinkTokens = 0;
  if (veritePy(completionTokens)) thinkTokens = minPy(thinkTokens, entierPy(completionTokens));
  const out: Dict = {
    duration: arrondiPy(totalDuration, 2),
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    thinking_tokens: thinkTokens,
    response_tokens: maxPy(0, entierPy(completionTokens) - thinkTokens),
    thinking_tokens_estimated: veritePy(getPy(meta, "thinking_tokens_estimated")),
    read_tps: arrondiPy(readSpeed, 1),
    write_tps: arrondiPy(writeSpeed, 1),
    model: getPy(meta, "model", config.LLAMA_MODEL),
    thinking: getPy(meta, "thinking", ""),
    finish_reason: getPy(meta, "finish_reason", ""),
    truncated: veritePy(getPy(meta, "truncated", false)),
    truncated_in_think: veritePy(getPy(meta, "truncated_in_think", false)),
  };
  if (veritePy(getPy(meta, "think_resumes"))) out["think_resumes"] = entierPy(itemPy(meta, "think_resumes"));
  if (getPy(meta, "thinking_budget_effective") !== null)
    out["thinking_budget_effective"] = entierPy(itemPy(meta, "thinking_budget_effective"));
  for (const k of ["cache_read_input_tokens", "cache_creation_input_tokens", "tool_input_tokens"]) {
    const v = getPy(usage, k);
    if (nombre(v) !== null && superieur(v, 0)) out[k] = entierPy(v);
  }
  return out;
}
