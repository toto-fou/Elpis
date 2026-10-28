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
