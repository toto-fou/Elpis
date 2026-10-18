// SPDX-License-Identifier: MIT
/** packages/auth/src/comptes.ts — comptes (accounts/users.py, hors suppression complète) et groupes d'un compte (groups.py). */
import { ErreurLecturePy, pyJsonDumps, pyJsonLoads, stripPy } from "@elpis/commun";
import { groupConcat } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { hashPassword, tokenHex, verifyPassword } from "@elpis/securite";

import type { LigneUtilisateur } from "./session";

const NOM_CANONIQUE = /^[A-Za-z0-9_-]+$/u;

export class ErreurNomUtilisateur extends Error {
  override name = "ErreurNomUtilisateur";
}

export type CompteResume = {
  id: number;
  username: string;
  is_admin: number | null;
  created_at: number;
  avatar: string | null;
};

export type CompteLite = {
  id: number;
  username: string;
  groups: string;
};

export type Groupe = {
  id: number;
  name: string;
  description: string | null;
};

export async function getUser(x: Executeur, username: string): Promise<LigneUtilisateur | undefined> {
  return x.get<LigneUtilisateur>("SELECT * FROM users WHERE username=?", [username]);
}

export async function getAllUsers(x: Executeur): Promise<CompteResume[]> {
  return x.all<CompteResume>(
    "SELECT id, username, is_admin, created_at, avatar FROM users ORDER BY username ASC",
  );
}

export async function getUsernameById(x: Executeur, uid: number): Promise<string | null> {
  const r = await x.get<{ username: string }>("SELECT username FROM users WHERE id=?", [uid]);
  return r ? r.username : null;
}

/** `_canon_username` : le nom tel que le gardent les dossiers sandbox et mémoire. */
export function nomCanonique(username: string | null | undefined): string {
  return (username || "").replace(/[^A-Za-z0-9_-]/gu, "");
}

/** `validate_username` : charset canonique, et aucun compte existant de même forme canonique (dossier partagé). */
export async function validerNomUtilisateur(x: Executeur, username: string): Promise<void> {
  if (!username || !stripPy(username)) throw new ErreurNomUtilisateur("username vide");
  if (!NOM_CANONIQUE.test(username)) {
    throw new ErreurNomUtilisateur(
      "username invalide : seuls les caractères A-Z a-z 0-9 _ - sont autorisés (pas d'espace ni d'accent — ils créeraient une collision de dossier avec un autre compte).",
    );
  }
  for (const u of await getAllUsers(x)) {
    const autre = u.username || "";
    if (autre !== username && nomCanonique(autre) === username) {
      throw new ErreurNomUtilisateur(
        `username en collision de dossier avec le compte existant « ${autre} » (même forme canonique).`,
      );
    }
  }
}

/** `create_user` : empreinte calculée hors transaction, validation et insertion sous le même verrou d'écriture. */
export async function createUser(
  base: Base,
  username: string,
  password: string,
  options: { isAdmin?: number; mustChangePwd?: number; maintenant?: number } = {},
): Promise<number> {
  const sel = tokenHex(16);
  const empreinte = await hashPassword(password, sel);
  return base.ecriture(async (x) => {
    await validerNomUtilisateur(x, username);
    return x.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, settings_json, must_change_pwd) VALUES(?,?,?,?,?,?,?)",
      [
        username,
        sel,
        empreinte,
        options.maintenant ?? Date.now() / 1000,
        options.isAdmin ?? 0,
        "{}",
        options.mustChangePwd ?? 0,
      ],
    );
  });
}

export async function verifyUser(x: Executeur, username: string, password: string): Promise<number | null> {
  const ligne = await getUser(x, username);
  if (!ligne) return null;
  return (await verifyPassword(password, String(ligne.pass_salt), String(ligne.pass_hash)))
    ? Number(ligne.id)
    : null;
}

export async function resetUserPassword(x: Executeur, uid: number, motDePasse: string): Promise<boolean> {
  const sel = tokenHex(16);
  const empreinte = await hashPassword(motDePasse, sel);
  return (
    (await x.run("UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?", [sel, empreinte, uid])).changes > 0
  );
}

export async function updateUserAvatar(x: Executeur, uid: number, fichier: string | null): Promise<void> {
  await x.run("UPDATE users SET avatar=? WHERE id=?", [fichier, uid]);
}

/** `json.loads(texte)` réduit aux dict (NaN, flottants et grands entiers gardés) ; ValueError de Python → `{}` signalé à `corrompu`, RecursionError propagée. */
export function reglagesDepuis(texte: unknown, corrompu?: () => void): Record<string, unknown> {
  if (typeof texte !== "string" || !texte) return {};
  let v: unknown;
  try {
    v = pyJsonLoads(texte);
  } catch (e) {
    if (!(e instanceof SyntaxError || (e instanceof ErreurLecturePy && e.nature !== "RecursionError")))
      throw e;
    corrompu?.();
    return {};
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** `get_user_settings` ; un settings_json corrompu est signalé (la prochaine sauvegarde l'écrasera). */
export async function getUserSettings(
  x: Executeur,
  uid: number,
  avertir?: (message: string) => void,
): Promise<Record<string, unknown>> {
  const r = await x.get<{ settings_json: unknown }>("SELECT settings_json FROM users WHERE id=?", [uid]);
  return reglagesDepuis(r?.settings_json, () =>
    avertir?.(
      `[users] settings_json corrompu pour uid=${uid} — retour aux défauts ; la prochaine sauvegarde écrasera la ligne`,
    ),
  );
}

export function reglagesEnJson(reglages: Record<string, unknown>): string {
  return pyJsonDumps(reglages, { ensureAscii: false });
}

/** `merge_user_settings` : lecture, `muter` en place et réécriture sous un même verrou d'écriture ; `{}` si le compte n'existe pas. */
export async function mergeUserSettings(
  base: Base,
  uid: number,
  muter: (reglages: Record<string, unknown>) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  return base.ecriture(async (x) => {
    const r = await x.get<{ settings_json: unknown }>("SELECT settings_json FROM users WHERE id=?", [uid]);
    if (!r) return {};
    const reglages = reglagesDepuis(r.settings_json || "{}");
    await muter(reglages);
    await x.run("UPDATE users SET settings_json=? WHERE id=?", [reglagesEnJson(reglages), uid]);
    return reglages;
  });
}

/** `get_users_lite` : sans groupes ou hors restriction, tous les autres comptes ; sinon ceux d'au moins un groupe commun. */
export async function getUsersLite(
  x: Executeur,
  exclu: number,
  respecterGroupes = true,
): Promise<CompteLite[]> {
  const tous = async (): Promise<CompteLite[]> =>
    (
      await x.all<CompteLite>(
        `SELECT u.id, u.username, ${groupConcat("g.name", x.dialecte, ", ")} as "groups" FROM users u ` +
          `LEFT JOIN user_groups ug ON u.id = ug.user_id LEFT JOIN "groups" g ON ug.group_id = g.id ` +
          `WHERE u.id != ? GROUP BY u.id ORDER BY u.username ASC`,
        [exclu],
      )
    ).map((r) => ({ id: Number(r.id), username: r.username, groups: r.groups || "" }));
  if (!respecterGroupes) return tous();
  const miens = (await x.valeurs<[number]>("SELECT group_id FROM user_groups WHERE user_id=?", [exclu])).map(
    ([g]) => g,
  );
  if (!miens.length) return tous();
  const lignes = await x.all<CompteLite>(
    `SELECT u.id, u.username, ${groupConcat("g2.name", x.dialecte, ",", true)} as "groups" FROM users u ` +
      `JOIN user_groups ug ON u.id = ug.user_id AND ug.group_id IN (${miens.map(() => "?").join(",")}) ` +
      `LEFT JOIN user_groups ug2 ON u.id = ug2.user_id LEFT JOIN "groups" g2 ON ug2.group_id = g2.id ` +
      `WHERE u.id != ? GROUP BY u.id ORDER BY u.username ASC`,
    [...miens, exclu],
  );
  return lignes.map((r) => ({ id: Number(r.id), username: r.username, groups: r.groups || "" }));
}

export async function getUserGroups(x: Executeur, uid: number): Promise<Groupe[]> {
  return x.all<Groupe>(
    `SELECT g.id, g.name, g.description FROM "groups" g JOIN user_groups ug ON g.id = ug.group_id WHERE ug.user_id=? ORDER BY g.name ASC`,
    [uid],
  );
}
