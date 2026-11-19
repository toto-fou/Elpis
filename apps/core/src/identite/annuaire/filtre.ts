// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/filtre.ts — filtres LDAP : l'identifiant tapé entre dans le gabarit de l'administrateur, échappé par la bibliothèque (RFC 4515). */
import { echapperFiltre, verifierFiltre } from "./client";
import { ErreurAnnuaire } from "./erreur";

export const IDENTIFIANT_MAX = 256;
const MARQUE = "{username}";
const ATTRIBUT_FILTRE = /^[A-Za-z][A-Za-z0-9.;:-]{0,127}$/u;

/** Remplace l'unique `{username}` du gabarit par l'identifiant échappé ; identifiant vide, trop long ou à caractère de contrôle refusé. */
export function rendreFiltre(gabarit: string, identifiant: string): string {
  if (typeof gabarit !== "string" || gabarit.split(MARQUE).length !== 2)
    throw new ErreurAnnuaire("configuration");
  if (
    typeof identifiant !== "string" ||
    identifiant === "" ||
    identifiant.length > IDENTIFIANT_MAX ||
    !identifiant.isWellFormed() ||
    /\p{Cc}/u.test(identifiant)
  )
    throw new ErreurAnnuaire("identifiants");
  const [avant = "", apres = ""] = gabarit.split(MARQUE);
  const filtre = `${avant}${echapperFiltre(identifiant)}${apres}`;
  verifierFiltre(filtre);
  return filtre;
}

/** Filtre d'égalité `(attribut=valeur)` dont la valeur (chaîne ou octets) est échappée par la bibliothèque. */
export function filtreEgal(attribut: string, valeur: string | Buffer): string {
  if (!ATTRIBUT_FILTRE.test(attribut)) throw new ErreurAnnuaire("configuration");
  if (typeof valeur === "string" && (valeur === "" || !valeur.isWellFormed()))
    throw new ErreurAnnuaire("configuration");
  if (Buffer.isBuffer(valeur) && valeur.length === 0) throw new ErreurAnnuaire("configuration");
  return `(${attribut}=${echapperFiltre(valeur)})`;
}

/** Filtre de présence `(attribut=*)`. */
export function filtrePresence(attribut: string): string {
  if (!ATTRIBUT_FILTRE.test(attribut)) throw new ErreurAnnuaire("configuration");
  return `(${attribut}=*)`;
}
