// SPDX-License-Identifier: MIT
/** apps/core/src/identite/ancre.ts — ancre d'une identité : ce qui désigne l'annuaire d'où elle vient, comparée à chaque connexion et à la recréation d'un fournisseur. */
import type { Fournisseur } from "./reglages";

/** `ldap:<base des utilisateurs>#<attribut d'identifiant>` (minuscules, espaces autour des virgules retirés) ; `null` pour un type sans identité encore ouverte. */
export function ancreIdentite(f: Fournisseur): string | null {
  if (f.type !== "ldap") return null;
  const base = f.user_base_dn
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/gu, ",");
  return `ldap:${base}#${f.attrs.id.toLowerCase()}`;
}
