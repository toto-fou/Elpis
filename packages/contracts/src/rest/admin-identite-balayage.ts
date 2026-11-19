// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-identite-balayage.ts — console › connexion d'entreprise : état de la dernière passe de l'annuaire, passe immédiate et confirmation des suspensions retenues. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

/** Dernière passe : instant, identités relues, suspendues, réactivées, laissées telles quelles faute de réponse lisible, raison d'abandon (rien n'a alors été modifié) et suspensions retenues en attente de confirmation. */
export const schemaEtatBalayage = z.object({
  at: horodatage,
  seen: entier,
  suspended: entier,
  reactivated: entier,
  unknown: entier,
  aborted: z.string().nullable(),
  pending: entier,
});
export type EtatBalayageConsole = z.infer<typeof schemaEtatBalayage>;

/** Confirmation : le décompte de suspensions que l'administrateur a vu ; 409 s'il a changé. */
export const schemaCorpsConfirmationBalayage = z.object({ pending: entier });
