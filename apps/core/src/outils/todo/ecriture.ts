// SPDX-License-Identifier: MIT
/** apps/core/src/outils/todo/ecriture.ts — corps de `todowrite` : compte, liste précédente et persistance du chat par des ports, sans inscription MCP. */
import { estDict, getOu, strPy } from "@elpis/commun";
import type { Base } from "@elpis/db";

import { getChatTodos, setChatTodos } from "../../chats/stockage";
import { journal } from "../../journal";
import type { PortComptesMemoire } from "../../memoire/ports";
import { safeUsername } from "../../memoire/portee";
import { buildResult } from "./resultat";
import type { ResultatTodoWrite } from "./resultat";

/** Ce que `todowrite` lit et écrit hors de la liste : compte, liste du chat, enregistrement ; chaque fonction est best-effort côté appelant. */
export interface DependancesTodo {
  idUtilisateur(username: string): Promise<number | null>;
  lireTodos(uid: number, chatId: string): Promise<unknown[]>;
  ecrireTodos(uid: number, chatId: string, todos: unknown): Promise<boolean>;
}

/** Ports de production : compte par `PortComptesMemoire`, liste dans `chats.meta_json["todos"]`. */
export function dependancesTodo(base: Base, comptes: PortComptesMemoire): DependancesTodo {
  return {
    idUtilisateur: (username) => comptes.idUtilisateur(username),
    lireTodos: (uid, chatId) => getChatTodos(base, uid, chatId),
    ecrireTodos: (uid, chatId, todos) => setChatTodos(base, uid, chatId, todos),
  };
}

/** `TodoItem.model_dump()` d'un élément déjà validé : une chaîne devient `{content}`, un dict ne garde que `content` et `status` (défaut ""). */
export function todoItemDump(it: unknown): { content: unknown; status: unknown } {
  if (typeof it === "string") return { content: it, status: "" };
  if (!estDict(it)) return { content: it, status: "" };
  return { content: getOu(it, "content", null), status: getOu(it, "status", "") };
}

/** `_user_id` : id du compte, `null` si inconnu ou en erreur. */
async function idDuCompte(dep: DependancesTodo, username: string): Promise<number | null> {
  try {
    return await dep.idUtilisateur(username);
  } catch {
    return null;
  }
}

/** `_load_prev` : liste précédente du chat, vide sans chat résolu ou en erreur. */
export async function chargerPrecedente(
  dep: DependancesTodo,
  uid: number | null,
  chatId: string,
): Promise<unknown[]> {
  if (uid === null || !chatId || chatId === "default") return [];
  try {
    return await dep.lireTodos(uid, chatId);
  } catch {
    return [];
  }
}

/** `_persist` : écrit la liste dans le chat ; faux sans chat résolu, chat inconnu ou erreur. */
export async function persister(
  dep: DependancesTodo,
  uid: number | null,
  chatId: string,
  todos: unknown,
): Promise<boolean> {
  if (uid === null || !chatId || chatId === "default") return false;
  try {
    return await dep.ecrireTodos(uid, chatId, todos);
  } catch (e) {
    journal("todowrite").debug(
      `[todowrite] persistence skipped: ${e instanceof Error ? e.message : strPy(e)}`,
    );
    return false;
  }
}

/** `_toolkit._safe_chat_id` : `[A-Za-z0-9_-]` gardés, « default » si rien ne reste. */
function chatIdSur(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/gu, "") || "default";
}

/** Corps de `todowrite` : compte et chat viennent de l'identité de l'appel (jamais des arguments), nettoyés comme `get_username`/`get_chat_id` du toolkit ; `todos` est la liste déjà validée. */
export async function todowrite(
  dep: DependancesTodo,
  identite: { username: string; chatId: string },
  todos: readonly unknown[] | null | undefined,
): Promise<ResultatTodoWrite> {
  const items = (todos ?? []).map(todoItemDump);
  const username = safeUsername(identite.username);
  const chatId = chatIdSur(identite.chatId);
  const uid = await idDuCompte(dep, username);
  const prev = await chargerPrecedente(dep, uid, chatId);
  return buildResult(items, prev, (lst) => persister(dep, uid, chatId, lst));
}
