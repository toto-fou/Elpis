// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/commun.ts — briques des contrats REST : entiers, horodatages, accusés `{ok: true}`. */
import { z } from "zod";

/** Décalage maximal accepté par les listes paginées de la console (serveur et front). */
export const DECALAGE_MAX = 100_000;

export const entier = z.number().int();
/** Secondes depuis l'époque, flottant Python (`1700000000.0` arrive en `1700000000`). */
export const horodatage = z.number();
export const dictionnaire = z.record(z.string(), z.unknown());

export const schemaOk = z.object({ ok: z.literal(true) });
export type ReponseOk = z.infer<typeof schemaOk>;
