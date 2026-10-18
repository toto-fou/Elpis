// SPDX-License-Identifier: MIT
/** apps/core/src/routines/ports.ts — dépendances des routines pas encore portées : portée d'exécution et contexte d'usage de l'observabilité (B1-32). */

/** `run_scope("routine", …)` + `set_usage_context(source, user_id, origin_id)` d'un run de routine. */
export interface PorteeRoutine {
  /** `webhook` pour un run déclenché par webhook, `routine` sinon (registre d'usage « hors heures »). */
  readonly source: "routine" | "webhook";
  readonly userId: number;
  readonly routineId: number;
  /** Clé synthétique du run (`origin_id` et `chat_id` de l'exécution). */
  readonly chatId: string;
  readonly model: string;
}

/** Fin d'une portée sans erreur : statut du run relu en base (`null` s'il n'est pas terminal) et moteur réellement visé. */
export interface IssueRoutine {
  readonly statut: string | null;
  readonly moteur: string;
}

/** `fn` dans la portée ; `issue` (qui ne lève jamais) n'est lue qu'après une fin sans erreur. */
export type PortPorteeRoutine = (
  p: PorteeRoutine,
  fn: () => Promise<void>,
  issue: () => Promise<IssueRoutine>,
) => Promise<void>;

let porteeRoutine: PortPorteeRoutine | null = null;

export function installerPorteeRoutine(f: PortPorteeRoutine | null): void {
  porteeRoutine = f;
}

/** Sans port (observabilité non branchée), `fn` seule. */
export function dansPorteeRoutine(
  p: PorteeRoutine,
  fn: () => Promise<void>,
  issue: () => Promise<IssueRoutine>,
): Promise<void> {
  return porteeRoutine ? porteeRoutine(p, fn, issue) : fn();
}
