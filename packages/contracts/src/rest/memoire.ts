// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/memoire.ts — mémoire long terme du compte (`/api/memory/*`) : fichiers USER.md et MEMORY.md, journal d'audit, annulation d'une écriture. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

/** Écriture qui a fait apparaître une note ; `chat_title` et `chat_exists` seulement si elle vient d'un chat. */
export const schemaOrigineNote = z.object({
  ts: horodatage.nullable(),
  source: z.string().nullable(),
  chat_id: z.string().nullable(),
  op: z.string().nullable(),
  chat_title: z.string().optional(),
  chat_exists: z.boolean().optional(),
});

/** `n_entries` et `origins` manquent quand le fichier n'existe pas ou après une écriture ; `scope_hash` seulement pour une portée. */
export const schemaEtatFichierMemoire = z.object({
  exists: z.boolean(),
  path: z.string(),
  limit: entier,
  chars: entier,
  usage_pct: z.number(),
  n_entries: entier.optional(),
  entries: z.array(z.string()),
  entry_ids: z.array(z.string()),
  last_modified: horodatage.nullable(),
  origins: z.array(schemaOrigineNote.nullable()).optional(),
  scope_hash: z.string().optional(),
});
export type EtatFichierMemoire = z.infer<typeof schemaEtatFichierMemoire>;

export const schemaReponseEtatMemoire = z.object({
  username: z.string(),
  user_md: schemaEtatFichierMemoire,
  memory_md: schemaEtatFichierMemoire,
  scopes: z.array(schemaEtatFichierMemoire),
});
export type ReponseEtatMemoire = z.infer<typeof schemaReponseEtatMemoire>;

export const schemaCorpsEcritureMemoire = z.object({ entries: z.array(z.string()) });
export const schemaReponseEcritureMemoire = z.object({
  ok: z.literal(true),
  state: schemaEtatFichierMemoire,
});

/** Ligne du journal d'audit : les champs hors liste (outil, portée, annulation) passent tels quels. */
export const schemaLigneAuditMemoire = z.looseObject({
  ts: horodatage,
  action: z.string(),
  store: z.string(),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
});
export const schemaReponseAuditMemoire = z.object({
  username: z.string(),
  count: entier,
  summary: z.record(z.string(), entier),
  entries: z.array(schemaLigneAuditMemoire),
});
export type ReponseAuditMemoire = z.infer<typeof schemaReponseAuditMemoire>;

/** `ok` faux : au moins un fichier n'a pu être supprimé (détail dans `errors`). */
export const schemaReponseEffacementMemoire = z.object({
  ok: z.boolean(),
  removed: z.array(z.string()),
  errors: z.array(z.string()),
});

export const schemaVueEcritureMemoire = z.object({
  op: z.string(),
  ts: horodatage.nullable(),
  action: z.string().nullable(),
  store: z.string().nullable(),
  source: z.string().nullable(),
  title: z.string().nullable(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  n_before: entier,
  n_after: entier,
  undone: z.boolean(),
  can_undo: z.boolean(),
});
export type VueEcritureMemoire = z.infer<typeof schemaVueEcritureMemoire>;
export const schemaReponseAnnulationMemoire = z.object({ ok: z.literal(true), op: schemaVueEcritureMemoire });
