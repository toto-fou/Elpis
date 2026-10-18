// SPDX-License-Identifier: MIT
/** apps/core/src/llm/jetons-raisonnement.ts — tokens brûlés à RÉFLÉCHIR : déclarés par le backend, sinon tokenisés, sinon estimés (bornés par la sortie). */
import { ErreurPython, intPy, stripPy } from "@elpis/commun";

import { countTokensExact, measuredCharsPerToken } from "../contexte/tokens";
import { journal } from "../journal";
import { estDict, longueurPy } from "../python";
import { currentTarget } from "./cible";
import { getPy } from "./dict-py";

const log = journal("think_tokens");

/** Au-delà, pas de `/tokenize` : l'estimation suffit à un chiffre d'affichage. */
export const TOKENIZE_MAX_CHARS = 400_000;

const DETAIL_KEYS = ["completion_tokens_details", "output_tokens_details"];
const FLAT_KEYS = ["reasoning_tokens", "thinking_tokens"];

/** `v` en entier ≥ 0, ou `null` si ce n'est pas un nombre exploitable (un booléen n'en est pas un). */
export function posInt(v: unknown): number | null {
  if (typeof v !== "number") return null;
  let n: number;
  try {
    n = intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return null;
    throw e;
  }
  return n >= 0 ? n : null;
}

/** Tokens de raisonnement DÉCLARÉS par le backend (détail niché, puis clés plates) ; un 0 explicite est une réponse. */
export function nativeReasoningTokens(usage: unknown): number | null {
  if (!estDict(usage)) return null;
  for (const dk of DETAIL_KEYS) {
    const det = getPy(usage, dk);
    if (estDict(det)) {
      for (const fk of FLAT_KEYS) {
        const n = posInt(getPy(det, fk));
        if (n !== null) return n;
      }
    }
  }
  for (const fk of FLAT_KEYS) {
    const n = posInt(getPy(usage, fk));
    if (n !== null) return n;
  }
  return null;
}

/** Estimation au ratio chars/token MESURÉ du modèle, plancher 1 pour un texte non vide. */
export function estimateThinkingTokens(
  thinking: string | null | undefined,
  modelId: string | null = null,
): number {
  const texte = thinking || "";
  if (!texte) return 0;
  let ratio: number;
  try {
    ratio = measuredCharsPerToken(modelId);
  } catch {
    ratio = 3.3;
  }
  return Math.max(1, intPy(longueurPy(texte) / Math.max(1.0, ratio)));
}

/** `[tokens de raisonnement, estimé]` pour UN tour, bornés par `outputTokens` quand il est connu ; ne lève jamais. */
export async function measureThinkingTokens(
  thinking: string | null | undefined,
  options: { modelId?: string | null; usage?: unknown; outputTokens?: unknown } = {},
): Promise<[number, boolean]> {
  const texte = thinking || "";
  const plafond = posInt(options.outputTokens ?? 0) || 0;
  const borne = (n: number): number => (plafond > 0 ? Math.min(n, plafond) : n);
  const natif = nativeReasoningTokens(options.usage);
  if (natif !== null) return [borne(natif), false];
  if (!stripPy(texte)) return [0, false];
  let local: boolean;
  try {
    local = currentTarget().isLlamacpp;
  } catch {
    local = false;
  }
  const longueur = longueurPy(texte);
  if (local && longueur <= TOKENIZE_MAX_CHARS) {
    try {
      const n = await countTokensExact(texte, options.modelId || null);
      if (typeof n === "number" && n >= 0) return [borne(n), false];
    } catch {
      log.debug("/tokenize indisponible — repli estimé");
    }
  } else if (local) {
    log.debug(
      `raisonnement de ${longueur} chars > ${TOKENIZE_MAX_CHARS} — estimation directe (pas de /tokenize)`,
    );
  }
  return [borne(estimateThinkingTokens(texte, options.modelId ?? null)), true];
}
