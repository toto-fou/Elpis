// SPDX-License-Identifier: MIT
/** packages/auth/test/aides-session.ts — aide de test : écrit l'identité d'une session par la porte réservée à ouvrirSession. */
import { ECRIRE_IDENTITE } from "../src/session";
import type { Session } from "../src/session";

export function poserIdentite(session: Session, donnees: Record<string, unknown>): void {
  for (const [cle, valeur] of Object.entries(donnees)) session[ECRIRE_IDENTITE](cle, valeur);
}
