// SPDX-License-Identifier: MIT
/** packages/auth/src/groupes.ts — groupes de comptes : création, liste, appartenance et vue d'administration (accounts/groups.py). */
import { versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { groupConcat } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";

import { reglagesDepuis } from "./comptes";

/** `ValueError` de `set_user_groups` : message rendu tel quel en 400. */
export class ErreurGroupe extends Error {
  override name = "ValueError";
}

function entierOuNul(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function createGroup(
  base: Base,
  name: string,
  description = "",
  maintenant = Date.now() / 1000,
): Promise<number> {
  return base.ecriture((x) =>
    x.insertId('INSERT INTO "groups"(name, description, created_at) VALUES(?,?,?)', [
      name,
      description,
      maintenant,
    ]),
  );
}

export async function listGroups(x: Executeur): Promise<Dict[]> {
  const lignes = await x.all(
    'SELECT g.id, g.name, g.description, g.created_at, COUNT(ug.user_id) as member_count FROM "groups" g ' +
      "LEFT JOIN user_groups ug ON g.id = ug.group_id GROUP BY g.id ORDER BY g.name ASC",
  );
  return lignes.map((r) => ({
    id: Number(r["id"]),
    name: r["name"],
    description: r["description"],
    created_at: versFlottantPy(Number(r["created_at"])),
    member_count: Number(r["member_count"]),
  }));
}

/** `get_group` : la ligne entière (`SELECT *`), ou null. */
export async function getGroup(x: Executeur, groupId: number): Promise<Dict | null> {
  const r = await x.get('SELECT id, name, description, created_at FROM "groups" WHERE id=?', [groupId]);
  if (!r) return null;
  return {
    id: Number(r["id"]),
    name: r["name"],
    description: r["description"],
    created_at: versFlottantPy(Number(r["created_at"])),
  };
}

export async function updateGroup(
  base: Base,
  groupId: number,
  name: string,
  description: string,
): Promise<boolean> {
  return base.ecriture(
    async (x) =>
      (await x.run('UPDATE "groups" SET name=?, description=? WHERE id=?', [name, description, groupId]))
        .changes > 0,
  );
}

/** `delete_group` : appartenances, puis `purger` (politiques d'accès du groupe) et le groupe, dans la même transaction. */
export async function deleteGroup(
  base: Base,
  groupId: number,
  purger?: (x: Executeur) => Promise<void>,
): Promise<boolean> {
  return base.ecriture(async (x) => {
    await x.run("DELETE FROM user_groups WHERE group_id=?", [groupId]);
    await purger?.(x);
    return (await x.run('DELETE FROM "groups" WHERE id=?', [groupId])).changes > 0;
  });
}

/** `set_user_groups` : tout ou rien ; un groupe inconnu lève ErreurGroupe sans toucher à l'appartenance existante. */
export async function setUserGroups(base: Base, userId: number, groupIds: readonly number[]): Promise<void> {
  await base.ecriture(async (x) => {
    if (groupIds.length) {
      const marques = groupIds.map(() => "?").join(",");
      const connus = new Set(
        (await x.valeurs<[unknown]>(`SELECT id FROM "groups" WHERE id IN (${marques})`, groupIds)).map(
          ([g]) => Number(g),
        ),
      );
      const inconnus = groupIds.filter((g) => !connus.has(g));
      if (inconnus.length) throw new ErreurGroupe(`Groupe introuvable : ${inconnus.join(", ")}`);
    }
    await x.run("DELETE FROM user_groups WHERE user_id=?", [userId]);
    for (const gid of new Set(groupIds))
      await x.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [userId, gid]);
  });
}

/** `get_all_users_with_groups` : vue de la console, réglages lus en clé privée `_settings` (le JSON brut n'est jamais exposé). */
export async function getAllUsersWithGroups(x: Executeur): Promise<Dict[]> {
  const lignes = await x.all(
    `SELECT u.id, u.username, u.is_admin, u.created_at, u.avatar, u.settings_json, ` +
      `${groupConcat("g.name", x.dialecte, ", ")} as group_names, ${groupConcat("g.id", x.dialecte, ",")} as group_ids ` +
      `FROM users u LEFT JOIN user_groups ug ON u.id = ug.user_id LEFT JOIN "groups" g ON ug.group_id = g.id ` +
      `GROUP BY u.id ORDER BY u.username ASC`,
  );
  return lignes.map((r) => {
    const ids = typeof r["group_ids"] === "string" && r["group_ids"] ? r["group_ids"] : "";
    return {
      id: Number(r["id"]),
      username: r["username"],
      is_admin: entierOuNul(r["is_admin"]),
      created_at: versFlottantPy(Number(r["created_at"])),
      avatar: r["avatar"],
      group_names: r["group_names"] || "",
      group_ids: ids
        .split(",")
        .filter((g) => g)
        .map((g) => Number(g)),
      _settings: reglagesDepuis(r["settings_json"]),
    };
  });
}
