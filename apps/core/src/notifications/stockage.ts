// SPDX-License-Identifier: MIT
/** apps/core/src/notifications/stockage.ts — centre de notifications par compte, chaque accès filtré par propriétaire (shared_infra/notifications/store.py). */
import { entierOuNulPy, estChiffresPy, intPy, prefixePy, versFlottantPy } from "@elpis/commun";
import type { Base, Executeur, Ligne, Valeur } from "@elpis/db";

import { maintenant } from "../chats/stockage";

/** Rétention par compte : la purge a lieu à chaque création. */
export const MAX_PER_USER = 200;

const COLONNES = "SELECT id, kind, title, body, ref_type, ref_id, read_at, created_at FROM notifications";

/** `_as_sqlite_row` : `ref_id` texte numérique rendu entier comme SQLite le range ; horodatages en flottants Python. */
function commeSqlite(l: Ligne): Ligne {
  const v = l["ref_id"];
  if (typeof v === "string" && estChiffresPy(v.replace(/^-+/u, ""))) l["ref_id"] = intPy(v);
  for (const c of ["read_at", "created_at"])
    if (typeof l[c] === "number") l[c] = versFlottantPy(l[c] as number);
  return l;
}

/** Insère la notification puis ne garde que les `MAX_PER_USER` plus récentes du compte ; rend l'id créé. */
export async function createNotification(
  base: Base,
  ownerUserId: number,
  kind: string,
  title: string,
  body = "",
  refType = "",
  refId: number | string | null = null,
): Promise<number> {
  return base.transaction(async (tx) => {
    const nid = await tx.insertId(
      "INSERT INTO notifications(owner_user_id, kind, title, body, ref_type, ref_id, read_at, created_at) " +
        "VALUES(?,?,?,?,?,?,NULL,?)",
      [
        ownerUserId,
        kind,
        prefixePy(title || "", 300),
        prefixePy(body || "", 4000),
        refType || "",
        refId,
        maintenant(),
      ],
    );
    await tx.run(
      "DELETE FROM notifications WHERE owner_user_id=? AND id NOT IN (" +
        "  SELECT id FROM (SELECT id FROM notifications WHERE owner_user_id=? " +
        "  ORDER BY created_at DESC, id DESC LIMIT ?) AS garde)",
      [ownerUserId, ownerUserId, MAX_PER_USER],
    );
    return nid;
  });
}

/** Plus récentes d'abord ; `beforeId` : curseur `(created_at, id)` de la ligne citée, repli sur `id<?` si elle a disparu. */
export async function listNotifications(
  x: Executeur,
  ownerUserId: number,
  limit = 50,
  beforeId: number | null = null,
): Promise<Ligne[]> {
  let lignes: Ligne[];
  if (beforeId !== null) {
    const curseur = intPy(beforeId);
    const ref = await x.get<{ created_at: Valeur }>(
      "SELECT created_at FROM notifications WHERE owner_user_id=? AND id=?",
      [ownerUserId, curseur],
    );
    lignes =
      ref !== undefined
        ? await x.all(
            `${COLONNES} WHERE owner_user_id=? AND (created_at<? OR (created_at=? AND id<?)) ` +
              "ORDER BY created_at DESC, id DESC LIMIT ?",
            [ownerUserId, ref.created_at, ref.created_at, curseur, intPy(limit)],
          )
        : await x.all(
            `${COLONNES} WHERE owner_user_id=? AND id<? ORDER BY created_at DESC, id DESC LIMIT ?`,
            [ownerUserId, curseur, intPy(limit)],
          );
  } else {
    lignes = await x.all(`${COLONNES} WHERE owner_user_id=? ORDER BY created_at DESC, id DESC LIMIT ?`, [
      ownerUserId,
      intPy(limit),
    ]);
  }
  return lignes.map(commeSqlite);
}

/** Ne garde que les `keep` plus récentes d'une source (`refType`/`refId`) du compte ; `keep` illisible ou ≤ 0 : rien. */
export async function pruneRefNotifications(
  x: Executeur,
  ownerUserId: number,
  refType: string,
  refId: number | string,
  keep: unknown,
): Promise<number> {
  const garder = entierOuNulPy(keep);
  if (garder === null || garder <= 0) return 0;
  const r = await x.run(
    "DELETE FROM notifications WHERE owner_user_id=? AND ref_type=? AND ref_id=? " +
      "AND id NOT IN (SELECT id FROM (SELECT id FROM notifications WHERE owner_user_id=? " +
      "AND ref_type=? AND ref_id=? ORDER BY created_at DESC, id DESC LIMIT ?) AS garde)",
    [ownerUserId, refType || "", refId, ownerUserId, refType || "", refId, garder],
  );
  return r.changes;
}

export async function countUnread(x: Executeur, ownerUserId: number): Promise<number> {
  const r = await x.get<{ n: unknown }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE owner_user_id=? AND read_at IS NULL",
    [ownerUserId],
  );
  return intPy(r?.n ?? 0);
}

export async function markRead(x: Executeur, ownerUserId: number, notifId: number): Promise<boolean> {
  const r = await x.run(
    "UPDATE notifications SET read_at=? WHERE id=? AND owner_user_id=? AND read_at IS NULL",
    [maintenant(), notifId, ownerUserId],
  );
  return r.changes > 0;
}

/** Repasse une notification lue en non lue ; sans effet sur celle d'un autre compte. */
export async function markUnread(x: Executeur, ownerUserId: number, notifId: number): Promise<boolean> {
  const r = await x.run(
    "UPDATE notifications SET read_at=NULL WHERE id=? AND owner_user_id=? AND read_at IS NOT NULL",
    [notifId, ownerUserId],
  );
  return r.changes > 0;
}

export async function markAllRead(x: Executeur, ownerUserId: number): Promise<number> {
  const r = await x.run("UPDATE notifications SET read_at=? WHERE owner_user_id=? AND read_at IS NULL", [
    maintenant(),
    ownerUserId,
  ]);
  return r.changes;
}

export async function deleteNotification(
  x: Executeur,
  ownerUserId: number,
  notifId: number,
): Promise<boolean> {
  const r = await x.run("DELETE FROM notifications WHERE id=? AND owner_user_id=?", [notifId, ownerUserId]);
  return r.changes > 0;
}

export async function clearAll(x: Executeur, ownerUserId: number): Promise<number> {
  return (await x.run("DELETE FROM notifications WHERE owner_user_id=?", [ownerUserId])).changes;
}
