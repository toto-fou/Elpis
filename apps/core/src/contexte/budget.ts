// SPDX-License-Identifier: MIT
/** apps/core/src/contexte/budget.ts — ratios et planchers de la fenêtre de contexte (`context_config.json › budgets`). */
import { estErreurPython, floatPy, intPy, maxPy, minPy } from "@elpis/commun";

import { effectiveGenerationCap } from "../llm/constantes";
import { CTX } from "./config-contexte";

export interface ValeursBudget {
  readonly outputReserveRatio: number;
  readonly outputReserveMin: number;
  readonly reserveCeilingRatio: number;
  readonly keepRecentMsgs: number;
  readonly emitCapMinTokens: number;
  readonly emitCapRatio: number;
  readonly emitCapMaxTokens: number;
  readonly sanitizeToolMaxTokens: number;
  readonly headSplit: number;
}

export const BUDGET_DEFAUTS: ValeursBudget = Object.freeze({
  outputReserveRatio: 0.18,
  outputReserveMin: 3072,
  reserveCeilingRatio: 0.75,
  keepRecentMsgs: 16,
  emitCapMinTokens: 2400,
  emitCapRatio: 0.06,
  emitCapMaxTokens: 25_000,
  sanitizeToolMaxTokens: 50_000,
  headSplit: 0.7,
});

/** Champs dans l'ordre Python : (nom TS, clé de `budgets`, type du défaut). */
const CHAMPS: readonly (readonly [keyof ValeursBudget, string, "int" | "float"])[] = [
  ["outputReserveRatio", "output_reserve_ratio", "float"],
  ["outputReserveMin", "output_reserve_min", "int"],
  ["reserveCeilingRatio", "reserve_ceiling_ratio", "float"],
  ["keepRecentMsgs", "keep_recent_msgs", "int"],
  ["emitCapMinTokens", "emit_cap_min_tokens", "int"],
  ["emitCapRatio", "emit_cap_ratio", "float"],
  ["emitCapMaxTokens", "emit_cap_max_tokens", "int"],
  ["sanitizeToolMaxTokens", "sanitize_tool_max_tokens", "int"],
  ["headSplit", "head_split", "float"],
];

/** `ContextBudget` Python : objet gelé, chargé une fois au démarrage. */
export class ContextBudget implements ValeursBudget {
  readonly outputReserveRatio: number;
  readonly outputReserveMin: number;
  readonly reserveCeilingRatio: number;
  readonly keepRecentMsgs: number;
  readonly emitCapMinTokens: number;
  readonly emitCapRatio: number;
  readonly emitCapMaxTokens: number;
  readonly sanitizeToolMaxTokens: number;
  readonly headSplit: number;

  constructor(valeurs: Partial<ValeursBudget> = {}) {
    const v = (cle: keyof ValeursBudget): number => valeurs[cle] ?? BUDGET_DEFAUTS[cle];
    this.outputReserveRatio = v("outputReserveRatio");
    this.outputReserveMin = v("outputReserveMin");
    this.reserveCeilingRatio = v("reserveCeilingRatio");
    this.keepRecentMsgs = v("keepRecentMsgs");
    this.emitCapMinTokens = v("emitCapMinTokens");
    this.emitCapRatio = v("emitCapRatio");
    this.emitCapMaxTokens = v("emitCapMaxTokens");
    this.sanitizeToolMaxTokens = v("sanitizeToolMaxTokens");
    this.headSplit = v("headSplit");
    Object.freeze(this);
  }

  /** Défauts surchargés champ par champ par `budgets.<nom>` (converti au type du défaut ; illisible → défaut). */
  static depuis(brut: (cle: string) => unknown): ContextBudget {
    const valeurs: Partial<Record<keyof ValeursBudget, number>> = {};
    for (const [nom, cle, type] of CHAMPS) {
      const raw = brut(cle);
      if (raw === null || raw === undefined) continue;
      try {
        valeurs[nom] = type === "int" ? intPy(raw) : floatPy(raw);
      } catch (e) {
        if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
      }
    }
    return new ContextBudget(valeurs);
  }

  static load(): ContextBudget {
    return ContextBudget.depuis((cle) => CTX.budgetRaw(cle));
  }

  /** Réserve de sortie : max(plancher, ratio·n_ctx, cap de génération), plafonnée à `reserveCeilingRatio`·n_ctx. */
  reserveTokens(ctxSize: number, genCapTokens: number | null | undefined): number {
    const reserve = maxPy(
      this.outputReserveMin,
      intPy(ctxSize * this.outputReserveRatio),
      intPy(genCapTokens || 0),
    );
    return minPy(reserve, intPy(ctxSize * this.reserveCeilingRatio));
  }

  /** Tokens disponibles pour les messages : n_ctx − réserve − surcoût fixe (peut être ≤ 0). */
  promptBudget(ctxSize: number, genCapTokens: number | null | undefined, fixedOverheadTokens = 0): number {
    return ctxSize - this.reserveTokens(ctxSize, genCapTokens) - maxPy(0, intPy(fixedOverheadTokens || 0));
  }

  generationCap(thinkingMode: boolean, ctxSize: number | null | undefined): number {
    return effectiveGenerationCap(thinkingMode, ctxSize ?? null);
  }
}

export const BUDGET = ContextBudget.load();
