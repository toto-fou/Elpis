// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-identite-balayage.ts — console › connexion d'entreprise : état de la dernière passe de l'annuaire, passe immédiate et confirmation des suspensions retenues. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

/** Compte retenu : identifiant, nom et raison du départ. */
export const schemaDepartRetenu = z.object({
  user_id: entier,
  username: z.string(),
  reason: z.string(),
});

/** Départ vu par une passe aboutie, daté (secondes), en attente d'une seconde observation. */
export const schemaDepartObserve = z.object({ user_id: entier, reason: z.string(), at: horodatage });

/** Dernière passe : instant, identités relues, suspendues, réactivées, laissées telles quelles faute de réponse lisible, raison d'abandon (rien n'a alors été modifié), suspensions retenues en attente de confirmation (`held`, 200 au plus sur `held_total`, `held_hash` : empreinte de l'ensemble complet), départs vus une première fois (`observed`) et instant de la dernière passe aboutie. */
export const schemaEtatBalayage = z.object({
  at: horodatage,
  seen: entier,
  suspended: entier,
  reactivated: entier,
  unknown: entier,
  aborted: z.string().nullable(),
  pending: entier,
  held: z.array(schemaDepartRetenu).default([]),
  held_total: entier.default(0),
  held_hash: z.string().default(""),
  observed: z.array(schemaDepartObserve).default([]),
  ok_at: horodatage.nullable().default(null),
});
export type EtatBalayageConsole = z.infer<typeof schemaEtatBalayage>;

/** Confirmation : les comptes que l'administrateur a vus dans `held` (1 à 200, distincts) et l'empreinte `held_hash` de l'ensemble vu ; 409 si l'ensemble des partis a changé (le corps rend alors l'état). */
export const schemaCorpsConfirmationBalayage = z.object({
  user_ids: z.array(entier.min(1)).min(1).max(200),
  held_hash: z.string().min(1).max(64),
});
