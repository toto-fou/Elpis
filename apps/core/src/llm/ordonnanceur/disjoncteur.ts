// SPDX-License-Identifier: MIT
/** apps/core/src/llm/ordonnanceur/disjoncteur.ts — disjoncteur LLM par modèle (port de `_breaker.py`) et ses réglages. */
import { journal } from "../../journal";
import { entierPython, flottantPython, stripPython } from "./python";

const log = journal("llm_breaker");
const cle = (model: string | null | undefined): string => model || "__default__";

/** `_BREAKER_TRANSPORT_ERRORS` du garde Python (noms httpx), lue par l'infill : seules ces pannes de transport comptent ; le garde TS classe les siennes par `classerErreur`. */
export const BREAKER_TRANSPORT_ERRORS: ReadonlySet<string> = new Set([
  "ConnectError",
  "ConnectTimeout",
  "ReadTimeout",
  "PoolTimeout",
]);

export type ReglagesDisjoncteur = { enabled: boolean; failsToOpen: number; cooldownS: number };
export type EtatCircuit = { fails: number; openUntil: number; gen: number };
/** Horloge monotone en secondes, comme `time.monotonic()`. */
export type Horloge = () => number;
/** Famille d'une erreur LLM (`llm_error_kind`) : seules `unreachable` et `timeout` ouvrent le circuit. */
export type ClasserErreur = (err: unknown) => string;

/** `LLM_BREAKER`, `LLM_BREAKER_FAILS`, `LLM_BREAKER_COOLDOWN_S`, lus comme le module Python à son import. */
export function reglagesDisjoncteur(
  env: Record<string, string | undefined> = process.env,
): ReglagesDisjoncteur {
  const repos = flottantPython(env["LLM_BREAKER_COOLDOWN_S"] ?? "15") ?? 15;
  return {
    enabled: !["0", "false", "no", ""].includes(stripPython(env["LLM_BREAKER"] ?? "1").toLowerCase()),
    failsToOpen: Math.max(1, entierPython(env["LLM_BREAKER_FAILS"] ?? "5") ?? 5),
    cooldownS: repos > 1 ? repos : 1,
  };
}

export class LLMCircuitOpen extends Error {
  override name = "LLMCircuitOpen";
  override message =
    "Service LLM temporairement indisponible (circuit ouvert) — réessaie dans quelques secondes.";
}

export class Disjoncteur {
  /** État par modèle, en lecture seule pour les appelants (tests, console). */
  readonly etats = new Map<string, EtatCircuit>();
  readonly reglages: ReglagesDisjoncteur;
  private readonly horloge: Horloge;
  private readonly classer: ClasserErreur;
  private readonly notees = new WeakSet<object>();

  constructor(reglages: ReglagesDisjoncteur, horloge: Horloge, classer: ClasserErreur = () => "unknown") {
    [this.reglages, this.horloge, this.classer] = [reglages, horloge, classer];
  }

  /** Lève `LLMCircuitOpen` pendant le repos ; ensuite demi-ouvert : tout passe jusqu'au prochain verdict. */
  allow(model: string | null | undefined): void {
    const etat = this.etats.get(cle(model));
    if (this.reglages.enabled && etat && etat.openUntil > this.horloge()) throw new LLMCircuitOpen();
  }

  generation(model: string | null | undefined): number {
    return this.etats.get(cle(model))?.gen ?? 0;
  }

  /** Referme le circuit, sauf si un échec a été noté depuis `sinceGeneration` (panne apprise pendant le tour). */
  recordSuccess(model: string | null | undefined, sinceGeneration?: number | null): void {
    const etat = this.etats.get(cle(model));
    if (!this.reglages.enabled || !etat || !(etat.fails || etat.openUntil)) return;
    if (sinceGeneration != null && etat.gen !== sinceGeneration) return;
    this.etats.delete(cle(model));
    log.info(`circuit refermé pour ${model || "<default>"}`);
  }

  /** Juge la cause directe (`err.cause`) ; une erreur déjà notée, même enveloppée ou relevée plus bas, ne compte qu'une fois. */
  noteTransportFailure(model: string | null | undefined, err: unknown): void {
    if (!this.reglages.enabled || err == null) return;
    try {
      const chaine: object[] = [];
      for (
        let e: unknown = err;
        e instanceof Object && !chaine.includes(e);
        e = (e as { cause?: unknown }).cause
      )
        chaine.push(e);
      if (chaine.some((e) => this.notees.has(e))) return;
      for (const e of chaine) this.notees.add(e);
      const cause: unknown = (err as { cause?: unknown }).cause || err;
      if (["unreachable", "timeout"].includes(this.classer(cause))) this.recordFailure(model);
    } catch {
      return;
    }
  }

  recordFailure(model: string | null | undefined): void {
    if (!this.reglages.enabled) return;
    const etat = this.etats.get(cle(model)) ?? { fails: 0, openUntil: 0, gen: 0 };
    this.etats.set(cle(model), etat);
    etat.fails += 1;
    etat.gen += 1;
    if (etat.fails < this.reglages.failsToOpen) return;
    etat.openUntil = this.horloge() + this.reglages.cooldownS;
    const message = `circuit OUVERT pour ${model || "<default>"} (${etat.fails} échecs transport)`;
    log.warn(`${message} — fail-fast pendant ${this.reglages.cooldownS.toFixed(0)}s`);
  }

  reset(model?: string | null): void {
    if (model == null) this.etats.clear();
    else this.etats.delete(cle(model));
  }
}
