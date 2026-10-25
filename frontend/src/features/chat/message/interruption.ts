// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/interruption.ts — ligne « Interrompue : cause » d'une réponse en échec : cause typée d'après le genre d'erreur, action adaptée, détail technique copiable. */

export type ActionInterruption = "reprendre" | "nouveau" | null;

export interface Interruption {
  cause: string;
  action: ActionInterruption;
  /** Texte copié par « Copier le détail » (message puis détail technique). */
  detail: string;
}

export interface MessageEnErreur {
  errorMessage?: string | null;
  errorDetail?: string | null;
  errorKind?: string | null;
}

const CAUSES: Readonly<Record<string, readonly [string, ActionInterruption]>> = {
  unreachable: ["serveur injoignable", "reprendre"],
  network: ["connexion perdue", "reprendre"],
  timeout: ["délai dépassé", "reprendre"],
  loading: ["modèle en chargement", "reprendre"],
  rate_limited: ["moteur occupé", "reprendre"],
  busy: ["moteur occupé", "reprendre"],
  account_busy: ["trop de générations en cours", "reprendre"],
  context_overflow: ["contexte saturé", "nouveau"],
  forbidden: ["accès refusé", null],
  invalid_request: ["requête refusée", null],
  unknown: ["erreur interne", "reprendre"],
};

// Erreur d'avant les genres (ou du navigateur) : genre déduit du message.
function genreDeduit(message: string): string {
  if (/failed to fetch|networkerror|réseau|network/i.test(message)) return "network";
  if (/contexte|context/i.test(message)) return "context_overflow";
  return "unknown";
}

/** Cause, action et détail d'une réponse en échec. */
export function interruption(m: MessageEnErreur): Interruption {
  const message = (m.errorMessage || "").trim();
  const genre = m.errorKind && CAUSES[m.errorKind] ? m.errorKind : genreDeduit(message);
  const [cause, action] = CAUSES[genre] ?? ["erreur interne", "reprendre"];
  const detail = [message, (m.errorDetail || "").trim()].filter(Boolean).join("\n");
  return { cause, action, detail };
}
