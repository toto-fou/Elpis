// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-integrations.ts — console : service RAG, voix, prompts système, manifeste MCP. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

export const schemaCorpsEssaiRag = z.object({
  url: z.string().optional(),
  token: z.string().optional(),
  timeout: z.number().optional(),
});
/** Santé du service RAG telle qu'il la rend (champs libres) ; un échec reste un 200 `{ok: false, error}`. */
export const schemaReponseEssaiRag = z.union([
  z.object({ ok: z.literal(true), status: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const schemaCorpsEssaiVoix = z.looseObject({});
const schemaEssaiMoteurVoix = z.looseObject({ ok: z.boolean(), error: z.string().optional() });
export const schemaReponseEssaiVoix = z.looseObject({
  ok: z.boolean(),
  stt: schemaEssaiMoteurVoix,
  tts: schemaEssaiMoteurVoix,
  enabled: z.boolean(),
  saved_matches_form: z.boolean(),
  unsaved: z.array(z.string()),
  flags: z.object({ stt: z.boolean(), tts: z.boolean() }),
  https: z.boolean(),
  warnings: z.array(z.string()),
});
export const schemaCorpsModelesVoix = z.looseObject({ section: z.enum(["stt", "tts"]).optional() });
export const schemaReponseModelesVoix = z.looseObject({
  ok: z.boolean(),
  models: z.array(z.unknown()),
  current: z.unknown(),
  source: z.string(),
  error: z.string().optional(),
});

export const schemaPromptSysteme = z.object({
  category: z.string(),
  size_chars: entier,
  mtime: horodatage,
  exists: z.boolean(),
});
export const schemaReponsePromptsSysteme = z.object({
  directory: z.string(),
  template_exists: z.boolean(),
  items: z.array(schemaPromptSysteme),
});
export const schemaReponsePromptSysteme = z.looseObject({ category: z.string(), content: z.string() });
export const schemaReponseApercuPrompt = z.object({
  user_prompt: z.string(),
  active_categories: z.array(z.string()),
  available_categories: z.array(z.string()),
  assembled: z.string(),
  messages: z.array(z.looseObject({ role: z.string() })),
  size_chars: entier,
  approx_tokens: entier,
  tokens_exact: z.boolean(),
});
export const schemaCorpsPromptSysteme = z.object({ content: z.string() });
export const schemaReponseEcriturePromptSysteme = z.object({
  ok: z.literal(true),
  category: z.string(),
  size_chars: entier,
  path: z.string(),
});

/** Façons de joindre l'entrée depuis un applicatif tiers : HTTP streamable, SSE, repli stdio. */
const schemaPointsAcces = z.looseObject({
  http: z.string().optional(),
  sse: z.string().optional(),
  stdio: z.looseObject({ command: z.string(), args: z.array(z.string()) }).optional(),
});
export const schemaServeurManifeste2 = z.looseObject({
  name: z.string(),
  type: z.string(),
  url: z.string(),
  description: z.string().optional(),
  endpoints: schemaPointsAcces.optional(),
  default_on: z.array(z.string()).optional(),
  default_on_self: z.boolean().optional(),
  enabled: z.boolean(),
  role: z.string(),
  families: z.array(z.string()),
  has_token: z.boolean(),
  reachable: z.boolean().nullable(),
});
export const schemaReponseManifesteAdmin = z.object({
  ok: z.literal(true),
  manifest: z.looseObject({
    version: entier,
    source: z.string(),
    host_base_url: z.string(),
    mcp_base_url: z.string(),
    path: z.string(),
    loaded_at: horodatage,
    servers: z.array(schemaServeurManifeste2),
    sandbox_hosts: dictionnaire,
    placement: dictionnaire,
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
    live_categories: z.record(z.string(), entier),
    manifest_path: z.string(),
    schema_path: z.string(),
  }),
});
/** `omis` : entrées sans le transport demandé ; le jeton de service n'est inclus que sur `with_token=1`. */
export const schemaReponseExportManifeste = z.looseObject({
  ok: z.literal(true),
  transport: z.string(),
  base_url: z.string(),
  with_token: z.boolean(),
  mcpServers: z.record(z.string(), dictionnaire),
  omis: z.array(z.string()),
});
export const schemaReponseRechargementManifeste = z.object({
  ok: z.literal(true),
  source: z.string(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  servers: z.array(z.string()),
});
