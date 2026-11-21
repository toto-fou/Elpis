// SPDX-License-Identifier: MIT
/** apps/core/src/identite/nom.ts — nom Elpis dérivé de l'identifiant externe : forme stricte, noms réservés refusés, jamais de suffixe, homonymes repérés. */
import { getAllUsers, nomCanonique } from "@elpis/auth";
import type { Executeur } from "@elpis/db";

const FORME_FINALE = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const RESERVES = new Set(["admin", "root", "system", "elpis", "guest"]);
const COMPTE_NUMEROTE = /^user_\d+$/u;

/** Nom Elpis de l'identifiant (NFKC, minuscules, hors `[a-z0-9_-]` remplacé par `-`, tirets repliés et rognés), ou `null` s'il est invalide ou réservé. */
export function nomDerive(identifiantExterne: string): string | null {
  if (typeof identifiantExterne !== "string" || !identifiantExterne.isWellFormed()) return null;
  const nom = identifiantExterne
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!FORME_FINALE.test(nom) || RESERVES.has(nom) || COMPTE_NUMEROTE.test(nom)) return null;
  return nom;
}

/** Forme comparée des noms : casse ignorée, toute suite de `.`, `-`, `_` vaut un seul `-`. */
const cleHomonyme = (nom: string): string => nom.toLowerCase().replace(/[._-]+/gu, "-");

/** Comptes portant déjà ce nom, à la casse et aux séparateurs `.`, `-`, `_` près, forme canonique comprise. */
async function homonymes(x: Executeur, nom: string): Promise<number[]> {
  const cle = cleHomonyme(nom);
  return (await getAllUsers(x))
    .filter((u) => {
      const autre = String(u.username ?? "");
      return cleHomonyme(autre) === cle || cleHomonyme(nomCanonique(autre)) === cle;
    })
    .map((u) => Number(u.id));
}

/** Compte déjà portant ce nom, à la casse et aux séparateurs `.`, `-`, `_` près, forme canonique comprise. */
export async function nomPris(x: Executeur, nom: string): Promise<boolean> {
  return (await homonymes(x, nom)).length > 0;
}

/** Vrai si ce nom est pris et que tout compte qui le porte est déjà rattaché à un fournisseur : aucun ne peut être préparé. */
export async function nomPrisParRattaches(x: Executeur, nom: string): Promise<boolean> {
  const ids = await homonymes(x, nom);
  for (const id of ids)
    if ((await x.get("SELECT 1 AS un FROM user_identities WHERE user_id=?", [id])) === undefined)
      return false;
  return ids.length > 0;
}
