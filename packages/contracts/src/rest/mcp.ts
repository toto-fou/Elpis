// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/mcp.ts — serveurs MCP côté panneau : dossiers déposés, catégories d'outils, manifeste, bibliothèque partagée, bouton « Tester ». */
import { z } from "zod";

import { entier } from "./commun";

export const schemaDossierMcp = z.object({ name: z.string(), path: z.string(), suggested_cmd: z.string() });
export const schemaReponseDossiersMcp = z.object({
  servers: z.array(schemaDossierMcp),
  root_path: z.string(),
});
export const schemaReponseDepotMcp = z.object({
  ok: z.literal(true),
  server_name: z.string(),
  path: z.string(),
  suggested_cmd: z.string(),
});

export const schemaOutilCategorie = z.object({
  name: z.string(),
  title: z.string().optional(),
  read_only: z.boolean().optional(),
  description: z.string().optional(),
});
export const schemaCategorieOutils = z.looseObject({
  name: z.string(),
  label: z.string(),
  icon: z.string(),
  color: z.string(),
  hidden: z.boolean(),
  default_on: z.boolean(),
  tools: z.array(schemaOutilCategorie),
});
export type CategorieOutils = z.infer<typeof schemaCategorieOutils>;
export const schemaReponseCategoriesMcp = z.object({
  ok: z.literal(true),
  categories: z.array(schemaCategorieOutils),
});

export const schemaServeurManifeste = z.object({
  name: z.string(),
  description: z.string(),
  type: z.string(),
  default_on: z.boolean(),
});
export const schemaReponseManifesteMcp = z.object({
  ok: z.literal(true),
  servers: z.array(schemaServeurManifeste),
});

/** Paire d'en-tête ou de variable : la valeur n'est jamais rendue, `has_value` dit seulement qu'elle existe. */
export const schemaPaireMasquee = z.object({
  name: z.string(),
  value: z.literal(""),
  has_value: z.boolean(),
});
/** Vue d'un compte ordinaire : de quoi reconnaître le serveur ; la vue administrateur y ajoute le détail sans secret. */
export const schemaServeurPartage = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  enabled: z.boolean(),
  has_auth: z.boolean(),
  shared: z.literal(true),
  url: z.string().optional(),
  command: z.string().optional(),
  auth_mode: z.string().optional(),
  auth_user: z.string().optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
  headers: z.array(schemaPaireMasquee).optional(),
  env: z.array(schemaPaireMasquee).optional(),
});
export type ServeurPartage = z.infer<typeof schemaServeurPartage>;
export const schemaReponseServeursPartages = z.object({
  ok: z.literal(true),
  servers: z.array(schemaServeurPartage),
  can_publish: z.boolean(),
});
export const schemaReponseServeurPartage = z.object({ ok: z.literal(true), server: schemaServeurPartage });

const schemaPaireMcp = z.object({ name: z.string(), value: z.string().optional() });
export const schemaCorpsServeurPartage = z.object({
  name: z.string(),
  type: z.enum(["sse", "http"]).optional(),
  url: z.string().optional(),
  auth_mode: z.enum(["", "basic", "bearer", "raw", "header"]).optional(),
  auth_user: z.string().optional(),
  auth_secret: z.string().optional(),
  headers: z.array(schemaPaireMcp).optional(),
  env: z.array(schemaPaireMcp).optional(),
  enabled: z.boolean().optional(),
});

/** Brouillon d'un serveur à éprouver : `id` vise un serveur déjà enregistré (secret laissé vide = inchangé). */
export const schemaCorpsTestMcp = z.looseObject({
  id: z.string().optional(),
  shared: z.boolean().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
  command: z.string().optional(),
});
export const schemaReponseTestMcp = z.union([
  z.object({ ok: z.literal(true), tools: z.array(z.string()), ms: entier }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ReponseTestMcp = z.infer<typeof schemaReponseTestMcp>;
