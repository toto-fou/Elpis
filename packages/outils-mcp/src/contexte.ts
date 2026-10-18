// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/contexte.ts — contexte d'un appel d'outil (`fastmcp.Context`) et jeton d'accès de la requête en cours (`get_access_token`). */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Dict } from "@elpis/commun";

/** Niveaux MCP de `logging/setLevel`, du moins au plus grave. */
export const NIVEAUX_JOURNAL = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;
export type NiveauJournal = (typeof NIVEAUX_JOURNAL)[number];

/** `AccessToken` de FastMCP : `claims` porte `trusted_meta`, `username`, `families`, `client_kind`, `delegated`, `user_id`. */
export interface JetonAcces {
  readonly token: string;
  readonly client_id: string;
  readonly scopes: readonly string[];
  readonly expires_at: number | null;
  readonly claims: Dict;
}

export interface OptionsJournal {
  readonly level?: NiveauJournal;
  readonly loggerName?: string | null;
  readonly extra?: Dict | null;
}

/** Ce que reçoit un outil : `_meta` de l'appel, portée, annulation, notifications de journal et de progression. */
export interface ContexteAppel {
  readonly nomOutil: string;
  readonly meta: Dict | null;
  readonly famille: string | null;
  readonly signal: AbortSignal;
  log(message: string, options?: OptionsJournal): Promise<void>;
  debug(message: string, options?: Omit<OptionsJournal, "level">): Promise<void>;
  info(message: string, options?: Omit<OptionsJournal, "level">): Promise<void>;
  warning(message: string, options?: Omit<OptionsJournal, "level">): Promise<void>;
  error(message: string, options?: Omit<OptionsJournal, "level">): Promise<void>;
  reportProgress(progress: number, total?: number | null, message?: string | null): Promise<void>;
}

const jeton = new AsyncLocalStorage<JetonAcces | null>();

/** Jeton d'accès vu par tout ce que lance `fn` (requête `tools/list` ou `tools/call`). */
export function avecJeton<T>(acces: JetonAcces | null, fn: () => T): T {
  return jeton.run(acces, fn);
}

/** `get_access_token()` : `null` hors requête authentifiée (en mémoire, stdio, tests). */
export function getAccessToken(): JetonAcces | null {
  return jeton.getStore() ?? null;
}
