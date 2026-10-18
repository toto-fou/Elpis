// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/jetons.ts — jetons d'accès aux outils du compte (`/api/tokens*`) : liste et politique, création, régénération, révocation, schéma d'une famille. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

export const schemaJeton = z.object({
  id: entier,
  user_id: entier,
  kind: z.string(),
  name: z.string(),
  hint: z.string(),
  families: z.array(z.string()),
  created_at: horodatage,
  expires_at: horodatage.nullable(),
  last_used_at: horodatage.nullable(),
});
export type Jeton = z.infer<typeof schemaJeton>;

export const schemaPolitiqueJetons = z.object({
  tools_enabled: z.boolean(),
  tools_families: z.array(z.string()),
  max_days: entier,
  max_per_user: entier,
  families: z.array(z.object({ name: z.string(), label: z.string() })),
});
export const schemaReponseJetons = z.object({
  tokens: z.array(schemaJeton),
  policy: schemaPolitiqueJetons,
  opencode_enabled: z.boolean(),
  bridge_url: z.string(),
  tools_url: z.string(),
});
export type ReponseJetons = z.infer<typeof schemaReponseJetons>;

/** `days` vide ou absent : durée maximale de la politique ; `kind` : `tools` (défaut) ou `opencode`. */
export const schemaCorpsCreationJeton = z.object({
  name: z.string().optional(),
  kind: z.enum(["tools", "opencode"]).optional(),
  families: z.array(z.string()).optional(),
  days: z.union([entier, z.string(), z.null()]).optional(),
});
/** Le secret `token` n'est rendu qu'ici, une seule fois. */
export const schemaReponseJetonCree = z.object({ token: z.string(), item: schemaJeton });
export type ReponseJetonCree = z.infer<typeof schemaReponseJetonCree>;

/** Outils MCP d'une famille tels que le toolhost les publie (`tools/list`). */
export const schemaReponseSchemaFamille = z.object({
  family: z.string(),
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: dictionnaire.optional() })),
});

/** Autorisation OAuth d'un client MCP (jeton de rafraîchissement actif) ; l'identifiant d'autorisation sert à la révoquer. */
export const schemaAutorisationOauth = z.object({
  grant_id: z.string(),
  client_id: z.string(),
  client_name: z.string(),
  families: z.array(z.string()),
  created_at: horodatage,
  expires_at: horodatage,
  last_used_at: horodatage.nullable(),
});
export type AutorisationOauth = z.infer<typeof schemaAutorisationOauth>;
export const schemaReponseAutorisationsOauth = z.object({
  items: z.array(schemaAutorisationOauth),
  enabled: z.boolean(),
});
