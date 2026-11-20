// SPDX-License-Identifier: MIT
/** apps/core/src/identite/ancre.ts — ancre d'une identité : ce qui désigne le fournisseur d'où elle vient, comparée à chaque connexion et à la recréation d'un fournisseur. */
import type { Fournisseur } from "./reglages";

/** `oidc:<émetteur exact>`. */
export function ancreIdentite(f: Fournisseur): string {
  return `oidc:${f.issuer}`;
}
