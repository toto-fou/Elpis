// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/porte-compaction.ts — les deux seuils de la compaction (plafond technique, seuil du compte) et le cap par conversation. */
import { estErreurPython, intPy, maxPy, minPy } from "@elpis/commun";
import { config } from "@elpis/config";

import { effectiveGenerationCap, LLAMA_GEN_CAP_FLOOR } from "../llm/constantes";

export const PCT_MIN = 30;
export const PCT_MAX = 100;
export const TOKENS_MIN = 2_048;
export const TOKENS_MAX = 4_000_000;
export const MAX_ROUNDS_UNLIMITED = -1;
export const MAX_ROUNDS_MAX = 200;
export const RUN_COMPACTION_UNBOUNDED = 1_000;
export const USER_KEY_PCT = "compression_threshold_pct";
export const USER_KEY_TOKENS = "compression_threshold_tokens";
export const USER_KEY_MAX_ROUNDS = "compression_max_rounds";

type Reglages = Readonly<Record<string, unknown>> | null | undefined;

/** `int(value)` Python, ou `null` sur TypeError/ValueError (les autres erreurs remontent). */
function entierOuNul(v: unknown): number | null {
  try {
    return intPy(v);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return null;
    throw e;
  }
}

function lireReglage(s: Reglages, cle: string): unknown {
  return s && Object.hasOwn(s, cle) ? s[cle] : null;
}

/** Pourcentage de seuil : 0 (auto) ou [PCT_MIN, PCT_MAX] ; illisible ou ≤ 0 → 0. */
export function clampThresholdPct(value: unknown): number {
  const pct = entierOuNul(value);
  if (pct === null || pct <= 0) return 0;
  return maxPy(PCT_MIN, minPy(PCT_MAX, pct));
}

/** Seuil en tokens : 0 (auto) ou [TOKENS_MIN, TOKENS_MAX]. */
export function clampThresholdTokens(value: unknown): number {
  const tok = entierOuNul(value);
  if (tok === null || tok <= 0) return 0;
  return maxPy(TOKENS_MIN, minPy(TOKENS_MAX, tok));
}

/** Cap de compactions par conversation : 0 (auto), négatif → `MAX_ROUNDS_UNLIMITED`, sinon [1, MAX_ROUNDS_MAX]. */
export function clampMaxRounds(value: unknown): number {
  const n = entierOuNul(value);
  if (n === null) return 0;
  if (n < 0) return MAX_ROUNDS_UNLIMITED;
  if (n === 0) return 0;
  return minPy(MAX_ROUNDS_MAX, n);
}

/** Cap du compte dans la convention du compresseur (0 = illimité) ; `null` = rien de réglé (défaut d'instance). */
export function resolveMaxRounds(userSettings: Reglages = null): number | null {
  const raw = clampMaxRounds(lireReglage(userSettings, USER_KEY_MAX_ROUNDS));
  if (raw === 0) return null;
  return raw < 0 ? 0 : raw;
}

/** Compactions autorisées dans UN run : le cap réglé par le compte compte dans le run, « illimité » vaut 1 000. */
export function runCompactionBudget(autoBudget: unknown, maxRounds: number | null = null): number {
  const base = maxPy(1, intPy(autoBudget || 1));
  if (maxRounds === null) return base;
  if (intPy(maxRounds) <= 0) return maxPy(base, RUN_COMPACTION_UNBOUNDED);
  return maxPy(base, intPy(maxRounds));
}

export type ModeSeuil = "tokens" | "pct" | "auto";

/** Seuil tel que réglé ; les tokens priment sur le pourcentage ; 0/0 = auto. */
export class CompactionThreshold {
  readonly pct: number;
  readonly tokens: number;

  constructor(pct = 0, tokens = 0) {
    this.pct = pct;
    this.tokens = tokens;
    Object.freeze(this);
  }

  get mode(): ModeSeuil {
    if (this.tokens > 0) return "tokens";
    return this.pct > 0 ? "pct" : "auto";
  }

  get isSet(): boolean {
    return this.mode !== "auto";
  }

  /** Seuil en tokens pour cette fenêtre, avant bornage par le plafond technique ; 0 = auto. */
  targetTokens(ctxSize: number): number {
    if (this.tokens > 0) return this.tokens;
    if (this.pct > 0 && ctxSize > 0) return intPy((ctxSize * this.pct) / 100);
    return 0;
  }
}

export const AUTO = new CompactionThreshold();

export function thresholdFrom(pct: unknown = 0, tokens: unknown = 0): CompactionThreshold {
  return new CompactionThreshold(clampThresholdPct(pct), clampThresholdTokens(tokens));
}

/** Choix du compte (pris en bloc), sinon défaut d'instance lu à chaud, sinon auto. */
export function resolveThreshold(userSettings: Reglages = null): CompactionThreshold {
  const own = thresholdFrom(
    lireReglage(userSettings, USER_KEY_PCT),
    lireReglage(userSettings, USER_KEY_TOKENS),
  );
  if (own.isSet) return own;
  try {
    return thresholdFrom(config.COMPACTION_THRESHOLD_PCT, config.COMPACTION_THRESHOLD_TOKENS);
  } catch {
    return AUTO;
  }
}

/** Les deux seuils résolus pour une fenêtre ; `ctxSize <= 0` → tout à 0 (pas de compaction auto). */
export class CompactionGate {
  readonly ctxSize: number;
  readonly usableTokens: number;
  readonly triggerTokens: number;
  readonly threshold: CompactionThreshold;

  constructor(ctxSize = 0, usableTokens = 0, triggerTokens = 0, threshold: CompactionThreshold = AUTO) {
    this.ctxSize = ctxSize;
    this.usableTokens = usableTokens;
    this.triggerTokens = triggerTokens;
    this.threshold = threshold;
    Object.freeze(this);
  }

  /** Vrai si le compte a choisi un seuil strictement plus tôt que le plafond technique. */
  get isUserThreshold(): boolean {
    return this.triggerTokens > 0 && this.triggerTokens < this.usableTokens;
  }

  describe(): string {
    const m = this.threshold.mode;
    if (m === "tokens") return `${this.threshold.tokens} tk`;
    if (m === "pct") return `${this.threshold.pct} %`;
    return "auto";
  }
}

/** Marge sous le plafond : `llm.compaction.buffer_tokens`, 0 = auto `min(20k, 10 % du n_ctx)`. */
export function bufferTokens(ctxSize: number): number {
  let buf: number;
  try {
    buf = intPy(config.COMPACTION_BUFFER_TOKENS || 0);
  } catch {
    buf = 0;
  }
  if (buf <= 0) buf = minPy(20_000, intPy(ctxSize * 0.1));
  return buf;
}

/** Plafond technique : n_ctx − cap de génération − marge ; 0 si la fenêtre est inconnue. */
export function usableWindow(ctxSize: number | null | undefined, thinkingMode = false): number {
  const ctx = intPy(ctxSize || 0);
  if (ctx <= 0) return 0;
  return ctx - effectiveGenerationCap(thinkingMode, ctx) - bufferTokens(ctx);
}

/** Résout les deux seuils ; le plafond technique gagne toujours, plancher = plancher de génération. */
export function compactionGate(
  ctxSize: number | null | undefined,
  options: { thinkingMode?: boolean; threshold?: CompactionThreshold | null } = {},
): CompactionGate {
  const thr = options.threshold ?? AUTO;
  const ctx = intPy(ctxSize || 0);
  const usable = usableWindow(ctx, options.thinkingMode ?? false);
  if (ctx <= 0 || usable <= 0) return new CompactionGate(maxPy(0, ctx), 0, 0, thr);
  const want = thr.targetTokens(ctx);
  let trigger = want <= 0 ? usable : minPy(usable, want);
  trigger = maxPy(trigger, minPy(usable, LLAMA_GEN_CAP_FLOOR));
  return new CompactionGate(ctx, usable, trigger, thr);
}

/** Seuil à opposer à l'occupation, à n'importe quelle itération (passage obligé de la boucle). */
export function gateTokens(gate: CompactionGate): number {
  return gate.triggerTokens;
}

export interface ResumeFenetre {
  ctx_size: number;
  buffer_tokens: number;
  output_reserve: { chat: number; thinking: number };
  /** Point de compaction automatique par mode ; `null` si elle est coupée pour le compte. */
  compaction_at: { chat: number; thinking: number } | null;
}

/** Fenêtre vue par le panneau Génération : réserve de sortie, marge et point de compaction, avec et sans réflexion. */
export function resumeFenetre(
  ctxSize: number,
  threshold: CompactionThreshold,
  compactionOn: boolean,
): ResumeFenetre {
  const ctx = maxPy(0, intPy(ctxSize || 0));
  const point = (thinkingMode: boolean): number =>
    compactionGate(ctx, { thinkingMode, threshold }).triggerTokens;
  return {
    ctx_size: ctx,
    buffer_tokens: ctx > 0 ? bufferTokens(ctx) : 0,
    output_reserve: {
      chat: ctx > 0 ? effectiveGenerationCap(false, ctx) : 0,
      thinking: ctx > 0 ? effectiveGenerationCap(true, ctx) : 0,
    },
    compaction_at: compactionOn && ctx > 0 ? { chat: point(false), thinking: point(true) } : null,
  };
}
