// SPDX-License-Identifier: MIT
/** apps/core/src/coffre/stockage.ts — coffre d'identifiants du compte : entrées (origine exacte, identifiant, mot de passe Fernet), jamais relues en clair par l'API. */
import { nomDepuisSite } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { decrypt, encrypt, origineExacte } from "@elpis/securite";

export class ErreurCoffre extends Error {
  readonly statut: number;
  constructor(statut: number, message: string) {
    super(message);
    this.name = "ErreurCoffre";
    this.statut = statut;
  }
}

export interface EntreeCoffre {
  id: number;
  nom: string;
  origin: string | null;
  origin_confirmed: boolean;
  username: string;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LigneEntree extends EntreeCoffre {
  password_enc: string;
}

export const ENTREES_MAX = 200;
const NOM = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const IDENTIFIANT_MAX = 256;
const MOT_DE_PASSE_MAX = 1024;

function maintenant(): number {
  return Date.now() / 1000;
}

function entree(l: Record<string, unknown>): EntreeCoffre {
  return {
    id: Number(l["id"]),
    nom: String(l["nom"]),
    origin: typeof l["origin"] === "string" ? l["origin"] : null,
    origin_confirmed: Number(l["origin_confirmed"]) === 1,
    username: String(l["username"]),
    use_count: Number(l["use_count"] ?? 0),
    last_used_at:
      l["last_used_at"] === null || l["last_used_at"] === undefined ? null : Number(l["last_used_at"]),
    created_at: Number(l["created_at"]),
    updated_at: Number(l["updated_at"]),
  };
}

const COLONNES =
  "id, nom, origin, origin_confirmed, username, created_at, updated_at, last_used_at, use_count";

export function validerNom(brut: unknown): string {
  const nom = typeof brut === "string" ? brut.trim().toLowerCase() : "";
  if (!NOM.test(nom))
    throw new ErreurCoffre(422, "Nom invalide : 1 à 40 caractères parmi a-z, 0-9 et tirets.");
  return nom;
}

export function validerOrigine(brut: unknown): string {
  const origine = typeof brut === "string" ? origineExacte(brut) : null;
  if (origine === null) throw new ErreurCoffre(422, "Origine invalide : adresse http(s) attendue.");
  return origine;
}

function validerIdentifiant(brut: unknown): string {
  const v = typeof brut === "string" ? brut.trim() : "";
  if (!v || v.length > IDENTIFIANT_MAX) throw new ErreurCoffre(422, "Identifiant invalide.");
  return v;
}

function validerMotDePasse(brut: unknown): string {
  if (typeof brut !== "string" || !brut || brut.length > MOT_DE_PASSE_MAX)
    throw new ErreurCoffre(422, "Mot de passe invalide.");
  return brut;
}

export async function listerEntrees(x: Executeur, uid: number): Promise<EntreeCoffre[]> {
  const lignes = await x.all(`SELECT ${COLONNES} FROM coffre_identifiants WHERE user_id=? ORDER BY nom`, [
    uid,
  ]);
  return lignes.map(entree);
}

export async function lireEntree(x: Executeur, uid: number, id: number): Promise<EntreeCoffre | null> {
  const l = await x.get(`SELECT ${COLONNES} FROM coffre_identifiants WHERE id=? AND user_id=?`, [id, uid]);
  return l ? entree(l) : null;
}

export interface DonneesEntree {
  nom: unknown;
  origin: unknown;
  username: unknown;
  password: unknown;
}

export async function creerEntree(base: Base, uid: number, d: DonneesEntree): Promise<EntreeCoffre> {
  const nom = validerNom(d.nom);
  const origine = validerOrigine(d.origin);
  const username = validerIdentifiant(d.username);
  const chiffre = encrypt(validerMotDePasse(d.password));
  const t = maintenant();
  return base.ecriture(async (x) => {
    const n = await x.get("SELECT COUNT(*) AS n FROM coffre_identifiants WHERE user_id=?", [uid]);
    if (Number(n?.["n"] ?? 0) >= ENTREES_MAX) throw new ErreurCoffre(409, "Coffre plein.");
    if (await x.get("SELECT 1 AS un FROM coffre_identifiants WHERE user_id=? AND nom=?", [uid, nom]))
      throw new ErreurCoffre(409, "Ce nom existe déjà.");
    const id = await x.insertId(
      "INSERT INTO coffre_identifiants (user_id, nom, origin, origin_confirmed, username, password_enc, created_at, updated_at, use_count) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0)",
      [uid, nom, origine, username, chiffre, t, t],
    );
    return (await lireEntree(x, uid, id)) as EntreeCoffre;
  });
}

/** Nom libre dérivé de l'hôte de l'origine, pour une entrée créée depuis la fenêtre `/creds`. */
export async function nomLibrePourOrigine(x: Executeur, uid: number, origine: string): Promise<string> {
  const base = nomDepuisSite(new URL(origine).host);
  const pris = new Set(
    (await x.all("SELECT nom FROM coffre_identifiants WHERE user_id=?", [uid])).map((r) => String(r["nom"])),
  );
  let nom = base;
  for (let i = 2; pris.has(nom); i++) nom = `${base.slice(0, 36)}-${i}`;
  return nom;
}

export interface ModifEntree {
  nom?: unknown;
  origin?: unknown;
  username?: unknown;
  password?: unknown;
}

/** Modifie une entrée (mot de passe absent : inchangé) ; une origine fournie la confirme ; tout changement de source révoque les jetons issus de l'entrée. */
export async function modifierEntree(
  base: Base,
  uid: number,
  id: number,
  m: ModifEntree,
): Promise<EntreeCoffre | null> {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  let revoque = false;
  const nom = m.nom === undefined ? null : validerNom(m.nom);
  if (nom !== null) {
    sets.push("nom=?");
    params.push(nom);
  }
  if (m.origin !== undefined) {
    sets.push("origin=?", "origin_confirmed=1");
    params.push(validerOrigine(m.origin));
    revoque = true;
  }
  if (m.username !== undefined) {
    sets.push("username=?");
    params.push(validerIdentifiant(m.username));
    revoque = true;
  }
  if (m.password !== undefined && m.password !== "") {
    sets.push("password_enc=?");
    params.push(encrypt(validerMotDePasse(m.password)));
    revoque = true;
  }
  return base.ecriture(async (x) => {
    if (!(await lireEntree(x, uid, id))) return null;
    if (nom !== null) {
      const pris = await x.get(
        "SELECT 1 AS un FROM coffre_identifiants WHERE user_id=? AND nom=? AND id<>?",
        [uid, nom, id],
      );
      if (pris) throw new ErreurCoffre(409, "Ce nom existe déjà.");
    }
    if (sets.length > 0) {
      await x.run(
        `UPDATE coffre_identifiants SET ${sets.join(", ")}, updated_at=? WHERE id=? AND user_id=?`,
        [...params, maintenant(), id, uid],
      );
    }
    if (revoque) await x.run("DELETE FROM coffre_jetons WHERE user_id=? AND entry_id=?", [uid, id]);
    return lireEntree(x, uid, id);
  });
}

export async function confirmerOrigine(
  base: Base,
  uid: number,
  id: number,
  origine: unknown,
): Promise<EntreeCoffre | null> {
  return modifierEntree(base, uid, id, { origin: origine });
}

export async function supprimerEntree(base: Base, uid: number, id: number): Promise<boolean> {
  return base.ecriture(async (x) => {
    await x.run("DELETE FROM coffre_jetons WHERE user_id=? AND entry_id=?", [uid, id]);
    return (await x.run("DELETE FROM coffre_identifiants WHERE id=? AND user_id=?", [id, uid])).changes > 0;
  });
}

/** Entrée avec son mot de passe en clair : réservée à la résolution d'un jeton, jamais rendue par l'API. */
export async function lireSecretEntree(
  x: Executeur,
  uid: number,
  id: number,
): Promise<{ username: string; password: string; origin: string | null; confirmee: boolean } | null> {
  const l = await x.get(
    "SELECT username, password_enc, origin, origin_confirmed FROM coffre_identifiants WHERE id=? AND user_id=?",
    [id, uid],
  );
  if (!l) return null;
  return {
    username: String(l["username"]),
    password: decrypt(String(l["password_enc"])),
    origin: typeof l["origin"] === "string" ? l["origin"] : null,
    confirmee: Number(l["origin_confirmed"]) === 1,
  };
}

/** Suppression d'un compte : entrées et jetons du coffre. */
export async function purgerCoffreCompte(x: Executeur, uid: number): Promise<void> {
  await x.run("DELETE FROM coffre_jetons WHERE user_id=?", [uid]);
  await x.run("DELETE FROM coffre_identifiants WHERE user_id=?", [uid]);
}
