// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/procedures.ts — accords humains des gestes sensibles d'une procédure (`/api/procedures/approbations*`) : demandes en attente d'une conversation, décision du compte. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaDemandeApprobation = z.object({
  id: z.string(),
  chat_id: z.string(),
  procedure_id: z.string(),
  version: entier,
  path: z.string(),
  description: z.string(),
  /** Geste demandé : action, cibles et valeur après substitution des paramètres, URL visée. */
  gesture: z.object({
    act: z.string(),
    targets: z.array(z.string()),
    value: z.string(),
    url: z.string(),
  }),
  page: z.string(),
  /** Premier passage d'un geste ajouté ou modifié par une réparation. */
  once: z.boolean(),
  /** Le geste `once` vient d'une réparation (sinon d'un enregistrement). */
  repaired: z.boolean(),
  state: z.enum(["pending", "approved", "refused", "consumed"]),
  created_at: horodatage,
  expires_at: horodatage,
});
export type DemandeApprobation = z.infer<typeof schemaDemandeApprobation>;
export const schemaReponseApprobations = z.object({ items: z.array(schemaDemandeApprobation) });

export const schemaCorpsDecisionApprobation = z.object({ decision: z.enum(["approve", "refuse"]) });
export const schemaReponseDecisionApprobation = z.object({
  ok: z.literal(true),
  item: schemaDemandeApprobation,
});

export const schemaVersionProcedure = z.object({
  version: entier,
  created_at: horodatage,
  parent_version: entier.nullable(),
  repaired_path: z.string().nullable(),
  /** Approuvée par l'utilisateur ; seule une version approuvée s'exécute sans humain (routine, sous-agent). */
  approved_at: horodatage.nullable(),
});
export const schemaProcedureListee = z.object({
  id: z.string(),
  origin: z.string(),
  description: z.string(),
  versions: z.array(schemaVersionProcedure),
});
export type ProcedureListee = z.infer<typeof schemaProcedureListee>;
export const schemaReponseProcedures = z.object({ items: z.array(schemaProcedureListee) });
/** Résumé lisible d'une version : une ligne par nœud, indentée par profondeur. */
export const schemaReponseResumeProcedure = z.object({ lines: z.array(z.string()), readable: z.boolean() });
export const schemaReponseApprobationVersion = z.object({ ok: z.literal(true), approved_at: horodatage });
export const schemaReponseSuppressionProcedure = z.object({ ok: z.literal(true), deleted: entier });
