// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-rattachement.ts — console : détachement d'un compte de son identité externe et rattachements préparés (OIDC). */
import { z } from "zod";

import { entier, horodatage } from "./commun";

/** Mot de passe temporaire posé dans le même geste que le détachement (politique de mot de passe de l'instance). */
export const schemaCorpsDetachement = z.object({ new_password: z.string().min(1) });

export const schemaRattachementPrepare = z.object({
  id: entier,
  username: z.string().nullable(),
  expected: z.string(),
  waiver: z.boolean(),
  expires_at: horodatage,
});
export type RattachementPrepare = z.infer<typeof schemaRattachementPrepare>;
export const schemaReponseRattachementsPrepares = z.object({ items: z.array(schemaRattachementPrepare) });

/** `waiver` : dispense de la preuve par l'ancien mot de passe, refusée pour un administrateur ; `confirm_admin` obligatoire pour un administrateur. */
export const schemaCorpsRattachementPrepare = z.object({
  user_id: entier,
  expected: z.string().min(1).max(255),
  waiver: z.boolean().default(false),
  confirm_admin: z.boolean().default(false),
});

export const schemaIdentiteCompte = z.object({
  provider_id: z.string(),
  ext_username: z.string().nullable(),
});
export type IdentiteCompte = z.infer<typeof schemaIdentiteCompte>;
