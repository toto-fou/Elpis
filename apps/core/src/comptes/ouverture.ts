// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/ouverture.ts — suites communes d'une connexion réussie, quelle que soit la méthode. */
import { compteSuspendu, ligneSession, methodeDuCompte, ouvrirSession } from "@elpis/auth";
import type { MethodeConnexion, Session } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { auditLogin } from "@elpis/securite";

/** Refus d'ouvrir la session d'un compte suspendu : le même 401 qu'un mauvais mot de passe. */
export class ConnexionRefusee extends HttpError {
  constructor() {
    super(401, "invalid credentials");
  }
}

export interface EffetsConnexion {
  readonly base: Executeur;
  readonly maintenant: () => number;
  /** Durée de vie d'une session en secondes (configuration courante). */
  readonly dureeMax: () => number;
  readonly demarrerHistoriqueFichiers?: (uid: number) => Promise<void>;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
}

/** Refuse un compte suspendu ou dont la méthode de connexion n'est plus celle du compte (audit, `ConnexionRefusee`), sinon ouvre la session puis enchaîne dernière connexion, historique de fichiers, métrique et audit ; seule voie d'ouverture d'une session. */
export async function etablirConnexion(
  dep: EffetsConnexion,
  e: {
    session: Session;
    uid: number;
    username: string;
    methode: MethodeConnexion;
    ip: string;
    userAgent: string | null;
  },
): Promise<void> {
  const ligne = await ligneSession(dep.base, e.uid);
  const raison =
    ligne === undefined || compteSuspendu(ligne)
      ? "account_suspended"
      : methodeDuCompte(e.methode, ligne)
        ? null
        : "method_changed";
  if (raison !== null) {
    auditLogin({
      userId: e.uid,
      username: e.username,
      ip: e.ip,
      userAgent: e.userAgent,
      success: false,
      reason: raison,
      loginMethod: e.methode,
    });
    throw new ConnexionRefusee();
  }
  const t = dep.maintenant();
  ouvrirSession(e.session, { uid: e.uid, methode: e.methode, maintenant: t, dureeMax: dep.dureeMax() });
  try {
    await dep.base.run("UPDATE users SET last_login_at=? WHERE id=?", [t, e.uid]);
  } catch {
    // la dernière connexion ne bloque pas la connexion
  }
  try {
    await dep.demarrerHistoriqueFichiers?.(e.uid);
  } catch {
    // l'historique de fichiers ne bloque pas la connexion
  }
  dep.logMetric?.("user_login", 1, { user: e.username });
  auditLogin({
    userId: e.uid,
    username: e.username,
    ip: e.ip,
    userAgent: e.userAgent,
    success: true,
    loginMethod: e.methode,
  });
}
