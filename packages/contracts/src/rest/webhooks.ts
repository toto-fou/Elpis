// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/webhooks.ts — livraison d'un webhook de routine (`/api/webhooks/routines/:routine_id`, publique) : toujours 202 hors débit et taille. */
import { z } from "zod";

import { entier } from "./commun";

/** Corps libre de l'émetteur (Gitea, GitHub…) : le secret passe par signature HMAC, en-tête ou `?token=`. */
export const schemaCorpsWebhook = z.looseObject({});
/** 202 : acceptée, filtrée, doublon, ignorée ou lancée (`run_id`). */
export const schemaReponseWebhook = z.object({
  ok: z.literal(true),
  filtered: z.boolean().optional(),
  reason: z.string().optional(),
  duplicate: z.boolean().optional(),
  skipped: z.boolean().optional(),
  run_id: entier.optional(),
});
