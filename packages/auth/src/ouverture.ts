// SPDX-License-Identifier: MIT
/** packages/auth/src/ouverture.ts — l'unique écriture de l'identité d'un compte dans une session. */
import { veritePy } from "@elpis/commun";
import { tokenUrlsafe } from "@elpis/securite";

import { ECRIRE_IDENTITE } from "./session";
import type { Session } from "./session";

const FORME_METHODE = /^(password)$/u;

export type MethodeConnexion = "password";

/** Vide la session, y pose l'identité du compte, la méthode de connexion et l'échéance figée (`maintenant + dureeMax`), rend le `_sid` neuf. */
export function ouvrirSession(
  session: Session,
  e: { uid: number; methode: MethodeConnexion; maintenant: number; dureeMax: number },
): string {
  if (!FORME_METHODE.test(e.methode)) throw new Error("invalid login method");
  if (!Number.isFinite(e.dureeMax) || e.dureeMax <= 0) throw new Error("invalid session lifetime");
  const sid = tokenUrlsafe(18);
  session.vider();
  session[ECRIRE_IDENTITE]("uid", e.uid);
  session[ECRIRE_IDENTITE]("user", e.uid);
  session[ECRIRE_IDENTITE]("user_id", e.uid);
  session[ECRIRE_IDENTITE]("_login_ts", e.maintenant);
  session[ECRIRE_IDENTITE]("_sid", sid);
  session[ECRIRE_IDENTITE]("_auth", e.methode);
  session[ECRIRE_IDENTITE]("_exp", e.maintenant + e.dureeMax);
  return sid;
}

/** Remet `_login_ts` d'une session déjà ouverte (changement de mot de passe par l'intéressé) ; lève sans `user_id`. */
export function renouvelerSession(session: Session, maintenant: number): void {
  if (!veritePy(session.get("user_id"))) throw new Error("no open session to renew");
  session[ECRIRE_IDENTITE]("_login_ts", maintenant);
}
