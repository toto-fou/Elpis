// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/shell/budget.ts — plancher de débord du shell (`tokens_to_chars_stable(BUDGET.emit_cap_min_tokens)`) lu une fois dans `context_config.json › budgets`. */
import { estErreurPython, intPy } from "@elpis/commun";
import { CHARS_PER_TOKEN, cheminContextConfig, deepGet, readJsonFile } from "@elpis/config";

export const EMIT_CAP_MIN_TOKENS = 2400;

/** `budgets.emit_cap_min_tokens` converti par `int()` ; absent ou illisible : 2400. */
export function emitCapMinTokens(contexte: unknown): number {
  const brut = deepGet(contexte, "budgets.emit_cap_min_tokens", null);
  if (brut === null || brut === undefined) return EMIT_CAP_MIN_TOKENS;
  try {
    return intPy(brut);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return EMIT_CAP_MIN_TOKENS;
    throw e;
  }
}

let plancher: number | null = null;

/** Seuil de débord en caractères, figé au premier appel (ratio stable 3,3 : la même sortie déborde toujours pareil). */
export function plancherDebord(): number {
  plancher ??= Math.max(
    0,
    Math.trunc(emitCapMinTokens(readJsonFile(cheminContextConfig())) * CHARS_PER_TOKEN),
  );
  return plancher;
}

/** Oublie le seuil retenu (tests). */
export function oublierPlancherDebord(): void {
  plancher = null;
}
