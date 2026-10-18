// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/bac-terminal.ts — terminal du bac relayé par l'hôte d'outils (`/api/terminal/*`) : frappe, taille, arrêt, sessions nommées. */
import { z } from "zod";

import { entier } from "./commun";

export const schemaCorpsSaisieTerminal = z.object({ data: z.string().optional() });
/** Frappe : `ok: false` si le terminal vient de se fermer. */
export const schemaReponseSaisieTerminal = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export const schemaCorpsTailleTerminal = z.object({ rows: entier.optional(), cols: entier.optional() });

export const schemaSessionTerminal = z.object({
  id: z.string(),
  uid: entier,
  tid: entier.nullable(),
  name: z.string(),
  created_at: z.number(),
  last_connected_at: z.number(),
});
export type SessionTerminal = z.infer<typeof schemaSessionTerminal>;
export const schemaReponseSessionsTerminal = z.object({
  sessions: z.array(schemaSessionTerminal),
  max: entier,
});
export const schemaCorpsCreerSessionTerminal = z.object({ name: z.string().optional() });
export const schemaReponseCreerSessionTerminal = z.object({
  ok: z.literal(true),
  session: schemaSessionTerminal,
  max: entier,
});
export const schemaCorpsRenommerSessionTerminal = z.object({ name: z.string() });
