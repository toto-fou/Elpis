// SPDX-License-Identifier: MIT
/** packages/auth/src/comptes.ts — comptes (accounts/users.py, hors suppression complète) et groupes d'un compte (groups.py). */
import { ErreurLecturePy, pyJsonDumps, pyJsonLoads, stripPy } from "@elpis/commun";
import { groupConcat } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { completerCoutRefus, hachageAJour, hashPassword, tokenHex, verifyPassword } from "@elpis/securite";

import type { LigneUtilisateur } from "./session";

const NOM_CANONIQUE = /^[A-Za-z0-9_-]+$/u;

export class ErreurNomUtilisateur extends Error {
  override name = "ErreurNomUtilisateur";
}

/** Empreinte d'un compte sans mot de passe local : aucune saisie ne la produit. */
export const MARQUEUR_SANS_MOT_DE_PASSE = "!";

/** Refus de poser un mot de passe sur un compte sans mot de passe local. */
export class ErreurSansMotDePasseLocal extends Error {
  override name = "ErreurSansMotDePasseLocal";
}

/** Vrai si le compte se connecte par un mot de passe local (empreinte autre que le marqueur). */
export function aMotDePasseLocal(ligne: Record<string, unknown> | null | undefined): boolean {
  return String(ligne?.pass_hash ?? "") !== MARQUEUR_SANS_MOT_DE_PASSE;
}

/** Vrai si la méthode de connexion d'une session est encore celle du compte : mot de passe local pour `password` (ou méthode absente), identité de CE fournisseur pour `oidc:<id>`. */
export function methodeDuCompte(auth: unknown, ligne: Record<string, unknown> | null | undefined): boolean {
  if (typeof auth === "string" && /^oidc:/u.test(auth))
    return ligne?.ident_provider_id === auth.slice(auth.indexOf(":") + 1);
  if (auth === undefined || auth === null || auth === "password") return aMotDePasseLocal(ligne);
  return false;
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
  /** Identifiant externe du compte rattaché ; absent pour un compte local. */
  ext_username?: string | null;
  /** Libellé du fournisseur du compte rattaché, `null` s'il a disparu ; absent pour un compte local. */
  provider_label?: string | null;
};

/** Ligne brute de la requête : le fournisseur n'est rendu que par son libellé. */
type LigneLite = {
  id: number;
  username: string;
  groups: string | null;
  ext_username: string | null;
  provider_id: string | null;
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
  options: { isAdmin?: number; mustChangePwd?: number; maintenant?: number; sansMotDePasse?: boolean } = {},
): Promise<number> {
  const sel = tokenHex(16);
  const empreinte =
    options.sansMotDePasse === true ? MARQUEUR_SANS_MOT_DE_PASSE : await hashPassword(password, sel);
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

/** Compte sans mot de passe local (marqueur `!`, sel hexadécimal aléatoire, rôle utilisateur), créé comme `createUser` ; dans une écriture en cours, il en devient un point de sauvegarde. */
export function createExternalUser(
  base: Base,
  username: string,
  options: { maintenant?: number } = {},
): Promise<number> {
  return createUser(base, username, "", { ...options, sansMotDePasse: true });
}

/** Tout refus coûte un hachage courant, que le nom existe ou non ; un texte non encodable n'est comparé à rien. */
export async function verifyUser(x: Executeur, username: string, password: string): Promise<number | null> {
  if (!password.isWellFormed()) return null;
  const ligne = await getUser(x, username);
  if (!ligne) {
    await completerCoutRefus(password, null);
    return null;
  }
  if (!aMotDePasseLocal(ligne)) {
    await completerCoutRefus(password, null);
    return null;
  }
  const stocke = String(ligne.pass_hash);
  if (await verifyPassword(password, String(ligne.pass_salt), stocke)) return Number(ligne.id);
  await completerCoutRefus(password, stocke);
  return null;
}

/** Rehache au format courant un mot de passe vérifié ; sans effet si la ligne a changé entre-temps. */
export async function rehacherSiAncien(x: Executeur, uid: number, motDePasse: string): Promise<void> {
  const ligne = await x.get<LigneUtilisateur>("SELECT * FROM users WHERE id=?", [uid]);
  if (!ligne || !aMotDePasseLocal(ligne) || hachageAJour(String(ligne.pass_hash))) return;
  const sel = String(ligne.pass_salt);
  const empreinte = await hashPassword(motDePasse, sel);
  await x.run("UPDATE users SET pass_hash=? WHERE id=? AND pass_hash=? AND pass_salt=?", [
    empreinte,
    uid,
    String(ligne.pass_hash),
    sel,
  ]);
}

/** Pose un mot de passe ; un compte sans mot de passe local le refuse (`ErreurSansMotDePasseLocal`) sauf `detacher`. */
export async function resetUserPassword(
  x: Executeur,
  uid: number,
  motDePasse: string,
  options: { detacher?: boolean } = {},
): Promise<boolean> {
  const sel = tokenHex(16);
  const empreinte = await hashPassword(motDePasse, sel);
  const garde = options.detacher === true ? "" : " AND pass_hash <> ?";
  const params = [sel, empreinte, uid, ...(options.detacher === true ? [] : [MARQUEUR_SANS_MOT_DE_PASSE])];
  if ((await x.run(`UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?${garde}`, params)).changes > 0)
    return true;
  const ligne = await x.get<{ pass_hash: unknown }>("SELECT pass_hash FROM users WHERE id=?", [uid]);
  if (ligne && !aMotDePasseLocal(ligne)) throw new ErreurSansMotDePasseLocal();
  return false;
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

/** `get_users_lite` : sans groupes ou hors restriction, tous les autres comptes ; sinon ceux d'au moins un groupe commun ; `libelle` donne le libellé d'un fournisseur (absent : `null`). */
export async function getUsersLite(
  x: Executeur,
  exclu: number,
  respecterGroupes = true,
  libelle: (fournisseurId: string) => string | null = () => null,
): Promise<CompteLite[]> {
  const IDENT = `MAX(ui.ext_username) as ext_username, MAX(ui.provider_id) as provider_id`;
  const lite = (r: LigneLite): CompteLite => ({
    id: Number(r.id),
    username: r.username,
    groups: r.groups || "",
    // Identité externe présente seulement pour un compte rattaché : la ligne d'un compte local ne change pas.
    ...(r.provider_id == null
      ? {}
      : { ext_username: r.ext_username ?? null, provider_label: libelle(String(r.provider_id)) }),
  });
  const tous = async (): Promise<CompteLite[]> =>
    (
      await x.all<LigneLite>(
        `SELECT u.id, u.username, ${groupConcat("g.name", x.dialecte, ", ")} as "groups", ${IDENT} FROM users u ` +
          `LEFT JOIN user_groups ug ON u.id = ug.user_id LEFT JOIN "groups" g ON ug.group_id = g.id ` +
          `LEFT JOIN user_identities ui ON ui.user_id = u.id ` +
          `WHERE u.id != ? GROUP BY u.id ORDER BY u.username ASC`,
        [exclu],
      )
    ).map(lite);
  if (!respecterGroupes) return tous();
  const miens = (await x.valeurs<[number]>("SELECT group_id FROM user_groups WHERE user_id=?", [exclu])).map(
    ([g]) => g,
  );
  if (!miens.length) return tous();
  const lignes = await x.all<LigneLite>(
    `SELECT u.id, u.username, ${groupConcat("g2.name", x.dialecte, ",", true)} as "groups", ${IDENT} FROM users u ` +
      `JOIN user_groups ug ON u.id = ug.user_id AND ug.group_id IN (${miens.map(() => "?").join(",")}) ` +
      `LEFT JOIN user_groups ug2 ON u.id = ug2.user_id LEFT JOIN "groups" g2 ON ug2.group_id = g2.id ` +
      `LEFT JOIN user_identities ui ON ui.user_id = u.id ` +
      `WHERE u.id != ? GROUP BY u.id ORDER BY u.username ASC`,
    [...miens, exclu],
  );
  return lignes.map(lite);
}

export async function getUserGroups(x: Executeur, uid: number): Promise<Groupe[]> {
  return x.all<Groupe>(
    `SELECT g.id, g.name, g.description FROM "groups" g JOIN user_groups ug ON g.id = ug.group_id WHERE ug.user_id=? ORDER BY g.name ASC`,
    [uid],
  );
}
