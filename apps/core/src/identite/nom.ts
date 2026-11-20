// SPDX-License-Identifier: MIT
/** apps/core/src/identite/nom.ts — nom Elpis dérivé de l'identifiant externe : forme stricte, noms réservés refusés, jamais de suffixe. */

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
