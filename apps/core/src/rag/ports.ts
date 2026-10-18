// SPDX-License-Identifier: MIT
/** apps/core/src/rag/ports.ts — dépendance du RAG pas encore portée (métriques `log_metric` en base) : interface et pose. */

/** `shared_infra.db.log_metric(event_type, value, tags)` : best-effort, une métrique ne casse jamais une requête. */
export type JournaliserMetrique = (
  type: string,
  valeur: number,
  tags: Record<string, unknown>,
) => void | Promise<void>;

let metrique: JournaliserMetrique | null = null;

/** Posé par le lot qui porte les métriques ; absent, la métrique est simplement omise. */
export function installerMetriquesRag(f: JournaliserMetrique | null): void {
  metrique = f;
}

export function metriqueRag(): JournaliserMetrique | null {
  return metrique;
}
