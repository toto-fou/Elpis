// SPDX-License-Identifier: MIT
/** packages/auth/src/ouverture.ts — l'unique écriture de l'identité d'un compte dans une session. */
import { veritePy } from "@elpis/commun";
import { tokenUrlsafe } from "@elpis/securite";

import { ECRIRE_IDENTITE } from "./session";
import type { Session } from "./session";

const FORME_METHODE = /^(password|(ldap|oidc):[a-z0-9][a-z0-9-]{0,30})$/u;

export type MethodeConnexion = "password" | `ldap:${string}` | `oidc:${string}`;

/** Vide la session, y pose l'identité du compte et la méthode de connexion, rend le `_sid` neuf. */
export function ouvrirSession(
  session: Session,
  e: { uid: number; methode: MethodeConnexion; maintenant: number },
): string {
  if (!FORME_METHODE.test(e.methode)) throw new Error("invalid login method");
  const sid = tokenUrlsafe(18);
  session.vider();
  session[ECRIRE_IDENTITE]("uid", e.uid);
  session[ECRIRE_IDENTITE]("user", e.uid);
  session[ECRIRE_IDENTITE]("user_id", e.uid);
  session[ECRIRE_IDENTITE]("_login_ts", e.maintenant);
  session[ECRIRE_IDENTITE]("_sid", sid);
  session[ECRIRE_IDENTITE]("_auth", e.methode);
  return sid;
}

/** Remet `_login_ts` d'une session déjà ouverte (changement de mot de passe par l'intéressé) ; lève sans `user_id`. */
export function renouvelerSession(session: Session, maintenant: number): void {
  if (!veritePy(session.get("user_id"))) throw new Error("no open session to renew");
  session[ECRIRE_IDENTITE]("_login_ts", maintenant);
}
