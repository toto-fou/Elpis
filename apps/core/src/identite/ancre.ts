// SPDX-License-Identifier: MIT
/** apps/core/src/identite/ancre.ts — ancre d'une identité : ce qui désigne l'annuaire d'où elle vient, comparée à chaque connexion et à la recréation d'un fournisseur. */
import type { Fournisseur } from "./reglages";

/** `ldap:<base des utilisateurs>#<attribut d'identifiant>` (minuscules, espaces autour des virgules retirés) ou `oidc:<émetteur exact>`. */
export function ancreIdentite(f: Fournisseur): string {
  if (f.type === "oidc") return `oidc:${f.issuer}`;
  const base = f.user_base_dn
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/gu, ",");
  return `ldap:${base}#${f.attrs.id.toLowerCase()}`;
}
