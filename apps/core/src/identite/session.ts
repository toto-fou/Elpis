// SPDX-License-Identifier: MIT
/** apps/core/src/identite/session.ts — une session n'est valable que si sa méthode de connexion l'est encore, d'après la configuration relue à chaud. */
import type { LigneUtilisateur } from "@elpis/auth";

import { lireReglagesAuth } from "./reglages";

/** Méthode `ldap:<id>` / `oidc:<id>` : fournisseur présent et actif ; `password` ou absente : admise sauf mode « administrateurs seulement » pour un non-administrateur. */
export function sessionAdmise(auth: unknown, ligne: LigneUtilisateur): boolean {
  const reglages = lireReglagesAuth();
  if (typeof auth === "string" && /^(ldap|oidc):/u.test(auth)) {
    const id = auth.slice(auth.indexOf(":") + 1);
    return reglages.providers.some(
      (p) => p.id === id && p.type === auth.slice(0, auth.indexOf(":")) && p.enabled,
    );
  }
  if (auth !== undefined && auth !== null && auth !== "password") return false;
  return reglages.local.mode !== "admins" || Number(ligne.is_admin) === 1;
}
