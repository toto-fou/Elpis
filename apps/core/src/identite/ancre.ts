// SPDX-License-Identifier: MIT
/** apps/core/src/identite/ancre.ts — ancre d'une identité : ce qui désigne l'annuaire d'où elle vient, comparée à chaque connexion et à la recréation d'un fournisseur. */
import { dnNormalise } from "./annuaire/dn";
import type { Fournisseur } from "./reglages";

/** `ldap:<base des utilisateurs>#<attribut d'identifiant>` (DN normalisé selon RFC 4514) ou `oidc:<émetteur exact>`. */
export function ancreIdentite(f: Fournisseur): string {
  if (f.type === "oidc") return `oidc:${f.issuer}`;
  return `ldap:${dnNormalise(f.user_base_dn)}#${f.attrs.id.toLowerCase()}`;
}
