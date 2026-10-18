// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-cycle.ts — console : redémarrage de main et invalidation des caches de modèles (le canal interne `restart-self` est hors registre). */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

/** Échec : main injoignable (`error`) ou refus de main (`main_status`). */
export const schemaReponseRedemarrage = z.union([
  z.object({
    ok: z.literal(true),
    target: z.literal("main"),
    main_url: z.string(),
    active_generations: entier.nullable(),
    drain_max_s: z.number().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    target: z.literal("main"),
    error: z.string().optional(),
    main_status: entier.optional(),
  }),
]);
export type ReponseRedemarrage = z.infer<typeof schemaReponseRedemarrage>;
export const schemaReponseInvalidationCaches = z.object({ ok: z.literal(true), cleared: dictionnaire });
