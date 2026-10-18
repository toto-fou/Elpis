// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/images.ts — images générées du compte : état du moteur, galerie, suppression ; le fichier d'une image (`GET /api/images/:id`) n'est pas du JSON. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

const schemaPreferencesImages = z.object({
  ratio: z.string(),
  side: entier,
  n: entier,
  enhance: z.boolean(),
});
/** Moteur absent, désactivé ou fermé au compte : seulement `ready` et `available` faux ; sinon l'état complet. */
export const schemaReponseEtatImages = z.union([
  z.object({ ready: z.literal(false), available: z.literal(false) }),
  z.object({
    ready: z.literal(true),
    available: z.boolean(),
    tool_enabled: z.boolean(),
    provider: z.string(),
    model: z.string(),
    ratios: z.array(z.string()),
    sides: z.array(entier),
    default_side: entier,
    max_side: entier,
    step: entier,
    max_n: entier,
    size_policy: z.string(),
    sizes: z.array(z.unknown()),
    features: z.object({
      seed: z.boolean(),
      negative: z.boolean(),
      steps: z.boolean(),
      strength: z.boolean(),
      edit: z.boolean(),
    }),
    enhance_enabled: z.boolean(),
    keep_per_user: entier,
    prefs: schemaPreferencesImages,
    stored: entier,
  }),
]);
export type ReponseEtatImages = z.infer<typeof schemaReponseEtatImages>;

export const schemaImageGeneree = z.object({
  id: z.string(),
  url: z.string(),
  thumb_url: z.string(),
  width: entier,
  height: entier,
  mime: z.string(),
  seed: entier.optional(),
  chat_id: z.string().nullable(),
  prompt: z.string(),
  model: z.string(),
  created_at: horodatage,
  revised_prompt: z.string().optional(),
});
export type ImageGeneree = z.infer<typeof schemaImageGeneree>;
/** `next_before` : curseur de la page suivante, `null` en fin de galerie. */
export const schemaReponseGalerieImages = z.object({
  items: z.array(schemaImageGeneree),
  next_before: horodatage.nullable(),
  total: entier,
  keep: entier,
});
