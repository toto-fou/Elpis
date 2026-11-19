// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/publique.ts — ce que la page de connexion apprend des fournisseurs SSO actifs : identifiant et libellé, et l'origine où se faire connaître. */
import type { Executeur } from "@elpis/db";

import { fournisseursActifs } from "../fournisseurs";
import { lireReglagesAuth } from "../reglages";

export type MethodesPubliques = {
  readonly login_methods?: { id: string; label: string }[];
  readonly auth_origin?: string;
};

/** Fournisseurs OIDC actifs, `{ id, label }` et rien d'autre ; rien sans fournisseur, l'origine de `auth.public_url` seulement s'il y en a. */
export async function methodesPubliques(
  x: Executeur,
  cookieSecure: () => boolean,
): Promise<MethodesPubliques> {
  const actifs = (await fournisseursActifs(x, cookieSecure)).filter((f) => f.type === "oidc");
  if (actifs.length === 0) return {};
  return {
    login_methods: actifs.map((f) => ({ id: f.id, label: f.label })),
    auth_origin: new URL(lireReglagesAuth().public_url).origin,
  };
}
