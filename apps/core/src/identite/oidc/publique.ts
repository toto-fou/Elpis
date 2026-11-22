// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/publique.ts — ce que la page de connexion apprend des fournisseurs SSO actifs : identifiant et libellé, et l'origine où se faire connaître. */
import type { ReponseConfigPublique } from "@elpis/contracts";

import { lireReglagesAuth } from "../reglages";
import type { Fournisseur } from "../reglages";

type MethodesPubliques = Pick<ReponseConfigPublique, "login_methods" | "auth_origin">;

/** Fournisseurs OIDC actifs, `{ id, label }` et rien d'autre ; rien sans fournisseur, l'origine de `auth.public_url` seulement s'il y en a. */
export function methodesPubliques(actifs: readonly Fournisseur[]): MethodesPubliques {
  if (actifs.length === 0) return {};
  return {
    login_methods: actifs.map((f) => ({ id: f.id, label: f.label })),
    auth_origin: new URL(lireReglagesAuth().public_url).origin,
  };
}
