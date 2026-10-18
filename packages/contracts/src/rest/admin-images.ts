// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-images.ts — console : moteur de génération d'images (test, modèles, clé d'API scellée). */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

/** Corps du test et de la liste des modèles : surcharges du formulaire sur la configuration enregistrée. */
export const schemaCorpsEssaiImages = z.object({
  provider: z.string().optional(),
  url: z.string().optional(),
  model: z.string().optional(),
  verify: z.union([z.boolean(), z.string()]).optional(),
  ca_pem: z.string().optional(),
  api_key: z.string().optional(),
});
export const schemaEtatCleImages = z.object({ has_key: z.boolean(), stale: z.boolean() });
/** Un test raté reste un 200 : `ok` faux et `error` ; les champs de mesure n'existent qu'après une réponse du moteur. */
export const schemaReponseEssaiImages = schemaEtatCleImages.extend({
  ok: z.boolean(),
  provider: z.string(),
  enabled: z.boolean(),
  ready: z.boolean(),
  error: z.string().optional(),
  latency_ms: entier.optional(),
  model: z.string().optional(),
  mode: z.string().optional(),
  limits: dictionnaire.optional(),
  defaults: dictionnaire.optional(),
  warnings: z.array(z.string()).optional(),
});
export type ReponseEssaiImages = z.infer<typeof schemaReponseEssaiImages>;
export const schemaReponseModelesImages = z.object({
  ok: z.boolean(),
  models: z.array(z.unknown()),
  error: z.string().optional(),
});
/** `api_key` vide efface la clé ; elle est scellée pour l'origine de `url`. */
export const schemaCorpsCleImages = z.object({ api_key: z.string(), url: z.string().optional() });
export const schemaReponseCleImages = schemaEtatCleImages.extend({ ok: z.literal(true) });
