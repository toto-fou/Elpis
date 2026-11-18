// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/ouverture.ts — suites communes d'une connexion réussie, quelle que soit la méthode. */
import { ouvrirSession } from "@elpis/auth";
import type { MethodeConnexion, Session } from "@elpis/auth";
import { auditLogin } from "@elpis/securite";

export interface EffetsConnexion {
  readonly maintenant: () => number;
  readonly demarrerHistoriqueFichiers?: (uid: number) => Promise<void>;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
}

/** Ouvre la session puis enchaîne historique de fichiers, métrique et audit ; seule voie d'ouverture d'une session. */
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
  ouvrirSession(e.session, { uid: e.uid, methode: e.methode, maintenant: dep.maintenant() });
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
    method: e.methode,
  });
}
