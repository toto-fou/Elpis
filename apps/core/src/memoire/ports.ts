// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/ports.ts — dépendances de la mémoire pas encore portées (comptes, index plein texte des sessions) : interfaces et pose. */
import { ErreurPortAbsent } from "../llm/ports";

/** `shared_infra.accounts.users.get_user(username)["id"]`, `null` si le compte n'existe pas. */
export interface PortComptesMemoire {
  idUtilisateur(username: string): Promise<number | null>;
}

/** Ligne de `session_index_message` (FTS de l'historique des sessions). */
export interface MessageIndexe {
  user_id: number;
  app: string;
  session_id: string;
  scope_key: string;
  role: string;
  content: string;
  ts: number;
}

/** `shared_infra.memory.store.session_index_message` (porté avec les routes mémoire, B1-22). */
export interface PortIndexSessions {
  indexerMessage(message: MessageIndexe): Promise<void>;
}

let comptes: PortComptesMemoire | null = null;
let index: PortIndexSessions | null = null;

export function installerComptesMemoire(impl: PortComptesMemoire | null): void {
  comptes = impl;
}

export function comptesMemoire(): PortComptesMemoire {
  if (comptes === null) throw new ErreurPortAbsent("comptes de la mémoire non installés");
  return comptes;
}

export function installerIndexSessions(impl: PortIndexSessions | null): void {
  index = impl;
}

export function indexSessions(): PortIndexSessions {
  if (index === null) throw new ErreurPortAbsent("index des sessions non installé");
  return index;
}
