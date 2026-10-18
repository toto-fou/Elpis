// SPDX-License-Identifier: MIT
/** packages/contracts/src/terminal.ts — WebSocket du terminal (`/ws/terminal[/:sid]`) : trames texte JSON, codes de fermeture ; la sortie et la frappe du PTY passent en binaire. */
import { z } from "zod";

/** Accueil : `fresh_shell` vrai si le shell vient d'être lancé (rien à rejouer). */
export const schemaTerminalAccueil = z.object({ type: z.literal("hello"), fresh_shell: z.boolean() });
export const schemaTerminalPong = z.object({ type: z.literal("pong") });
/** Fin du shell : la socket se ferme ensuite en 1000. */
export const schemaTerminalFin = z.object({ type: z.literal("exit") });
/** Envoyé par le relais du core juste avant la fermeture 4001. */
export const schemaTerminalSessionExpiree = z.object({ type: z.literal("session_expired") });

export const schemaTrameTerminalServeur = z.discriminatedUnion("type", [
  schemaTerminalAccueil,
  schemaTerminalPong,
  schemaTerminalFin,
  schemaTerminalSessionExpiree,
]);
export type TrameTerminalServeur = z.infer<typeof schemaTrameTerminalServeur>;

/** Contrôles du client en texte (1024 points de code au plus) ; le serveur accepte aussi `type` à la place de `op`. */
export const schemaTerminalRedimensionnement = z.object({
  op: z.literal("resize"),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
});
export const schemaTerminalPing = z.object({ op: z.literal("ping") });
export const schemaControleTerminal = z.discriminatedUnion("op", [
  schemaTerminalRedimensionnement,
  schemaTerminalPing,
]);
export type ControleTerminal = z.infer<typeof schemaControleTerminal>;
export const TERMINAL_CONTROLE_MAX = 1024;

/** Codes de fermeture : 4001 session expirée, 4002 sid invalide, 4003 inter-site, 4004 session inconnue, 1011 PTY ou hôte injoignable, 1012 arrêt. */
export const FERMETURES_TERMINAL = {
  normale: 1000,
  erreur: 1011,
  arret: 1012,
  sessionExpiree: 4001,
  sidInvalide: 4002,
  interSite: 4003,
  sessionInconnue: 4004,
} as const;
export type FermetureTerminal = (typeof FERMETURES_TERMINAL)[keyof typeof FERMETURES_TERMINAL];

export function decoderTrameTerminal(texte: string): TrameTerminalServeur | null {
  try {
    const r = schemaTrameTerminalServeur.safeParse(JSON.parse(texte));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Trame de contrôle sérialisée, refusée au-delà de la limite du serveur. */
export function encoderControleTerminal(controle: ControleTerminal): string {
  const texte = JSON.stringify(schemaControleTerminal.parse(controle));
  if ([...texte].length > TERMINAL_CONTROLE_MAX) throw new RangeError("trame de contrôle trop longue");
  return texte;
}
