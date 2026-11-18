// SPDX-License-Identifier: MIT
/** packages/auth/src/ouverture.ts — l'unique écriture de l'identité d'un compte dans une session. */
import { tokenUrlsafe } from "@elpis/securite";

import type { Session } from "./session";

export type MethodeConnexion = "password" | `ldap:${string}` | `oidc:${string}`;

/** Vide la session, y pose l'identité du compte et la méthode de connexion, rend le `_sid` neuf. */
export function ouvrirSession(
  session: Session,
  e: { uid: number; methode: MethodeConnexion; maintenant: number },
): string {
  const sid = tokenUrlsafe(18);
  session.vider();
  session.set("uid", e.uid);
  session.set("user", e.uid);
  session.set("user_id", e.uid);
  session.set("_login_ts", e.maintenant);
  session.set("_sid", sid);
  session.set("_auth", e.methode);
  return sid;
}
