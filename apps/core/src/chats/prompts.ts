// SPDX-License-Identifier: MIT
/** apps/core/src/chats/prompts.ts — prompts enregistrés et partagés (shared_infra/chat/prompts_store.py). */
import { versFlottantPy } from "@elpis/commun";
import type { Base, Executeur, Ligne } from "@elpis/db";

import { maintenant, valeurSql } from "./stockage";

/** Colonnes REAL relues comme `float` (un horodatage entier s'écrit `100.0`). */
export function flottants(l: Ligne, ...colonnes: string[]): Ligne {
  for (const c of colonnes) if (typeof l[c] === "number") l[c] = versFlottantPy(l[c]);
  return l;
}

export async function savePrompt(x: Executeur, uid: number, title: string, content: string): Promise<number> {
  return x.insertId("INSERT INTO saved_prompts(user_id, title, content, created_at) VALUES(?,?,?,?)", [
    uid,
    title,
    content,
    maintenant(),
  ]);
}

export async function listSavedPrompts(x: Executeur, uid: number): Promise<Ligne[]> {
  return (await x.all("SELECT * FROM saved_prompts WHERE user_id=? ORDER BY created_at DESC", [uid])).map(
    (l) => flottants(l, "created_at"),
  );
}

export async function deletePrompt(x: Executeur, uid: number, promptId: number): Promise<boolean> {
  return (await x.run("DELETE FROM saved_prompts WHERE id=? AND user_id=?", [promptId, uid])).changes > 0;
}

export async function getPromptById(x: Executeur, uid: number, promptId: number): Promise<Ligne | null> {
  const l = await x.get("SELECT * FROM saved_prompts WHERE id=? AND user_id=?", [promptId, uid]);
  return l ? flottants(l, "created_at") : null;
}

/** `share_prompt_to_users` : une copie par destinataire, en une transaction. */
export async function sharePromptToUsers(
  base: Base,
  deUid: number,
  aUids: readonly number[],
  title: unknown,
  content: unknown,
): Promise<void> {
  const quand = maintenant();
  await base.transaction(async (tx) => {
    for (const a of aUids) {
      await tx.run(
        "INSERT INTO shared_prompts(from_user_id, to_user_id, title, content, created_at) VALUES(?,?,?,?,?)",
        [deUid, a, valeurSql(title), valeurSql(content), quand],
      );
    }
  });
}

export async function listSharedPrompts(x: Executeur, uid: number): Promise<Ligne[]> {
  return (
    await x.all(
      "SELECT sp.id, sp.title, sp.content, sp.created_at, u.username as from_username FROM shared_prompts sp " +
        "JOIN users u ON sp.from_user_id = u.id WHERE sp.to_user_id = ? ORDER BY sp.created_at DESC",
      [uid],
    )
  ).map((l) => flottants(l, "created_at"));
}

export async function deleteSharedPrompt(x: Executeur, uid: number, promptId: number): Promise<boolean> {
  return (await x.run("DELETE FROM shared_prompts WHERE id=? AND to_user_id=?", [promptId, uid])).changes > 0;
}

export async function clearAllSharedPrompts(x: Executeur, uid: number): Promise<boolean> {
  return (await x.run("DELETE FROM shared_prompts WHERE to_user_id=?", [uid])).changes > 0;
}
