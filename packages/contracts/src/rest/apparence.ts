// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/apparence.ts — skins visibles par l'utilisateur (`/api/skins`) ; la forme de la console en dérive. */
import { z } from "zod";

import { dictionnaire } from "./commun";
import { schemaMascotteCatalogue } from "./reglages";

/** `css_url` n'existe que pour un skin de plugin ; `brand` et `mascot` seulement s'ils sont définis. */
export const schemaSkin = z.object({
  id: z.string(),
  label: z.string(),
  desc: z.string(),
  darkBase: z.boolean(),
  sw: z.array(z.string()),
  builtin: z.boolean(),
  brand: dictionnaire.optional(),
  mascot: z.unknown().optional(),
  css_url: z.string().optional(),
});
export type Skin = z.infer<typeof schemaSkin>;

export const schemaReponseSkins = z.object({
  skins: z.array(schemaSkin),
  default: z.string(),
  mascottes: z.array(schemaMascotteCatalogue),
});
export type ReponseSkins = z.infer<typeof schemaReponseSkins>;
