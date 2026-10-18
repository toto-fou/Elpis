// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-llm.ts — console : connecteurs LLM partagés, fournisseurs autorisés, capacités du moteur, mode d'ordonnancement, trafic déboguable. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";
import { schemaConnecteurLlm, schemaPresetFournisseur } from "./llm";

export const schemaReponseConnecteursPartages = z.object({
  connectors: z.array(schemaConnecteurLlm),
  presets: z.record(z.string(), schemaPresetFournisseur),
  all_provider_types: z.array(z.string()),
});
export type ReponseConnecteursPartages = z.infer<typeof schemaReponseConnecteursPartages>;

/** Un connecteur partagé accepte les trois limites de capacité en plus des champs du compte ; une clé vide laisse la clé enregistrée. */
export const schemaCorpsConnecteurPartage = z.object({
  provider_type: z.string(),
  api_key: z.string().optional(),
  label: z.string().optional(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  models_json: z.string().optional(),
  context_window: z.union([entier, z.string(), z.null()]).optional(),
  max_models: z.union([entier, z.string(), z.null()]).optional(),
  max_concurrency: z.union([entier, z.string(), z.null()]).optional(),
});
export const schemaCorpsMajConnecteurPartage = schemaCorpsConnecteurPartage
  .partial()
  .extend({ enabled: z.boolean().optional() });

export const schemaReponseFournisseursAutorises = z.object({
  allowed: z.array(z.string()),
  cloud_provider_types: z.array(z.string()),
  presets: z.record(z.string(), schemaPresetFournisseur),
});
export const schemaCorpsFournisseursAutorises = z.object({ allowed: z.array(z.string()) });
export const schemaReponseFournisseursEcrits = z.object({
  ok: z.literal(true),
  allowed: z.array(z.string()),
});

const schemaModeOrdonnancement = z.enum(["auto", "classic", "optimized"]);
export const schemaReponseCapacitesLlm = z.object({
  capabilities: dictionnaire,
  configured_mode: z.string(),
  effective_mode: z.enum(["classic", "optimized"]),
});
export const schemaReponseSondeCapacites = z.object({ capabilities: dictionnaire });
export const schemaCorpsModeOrdonnancement = z.object({ mode: schemaModeOrdonnancement });
export const schemaReponseModeOrdonnancement = z.object({
  configured_mode: schemaModeOrdonnancement,
  effective_mode: z.enum(["classic", "optimized"]),
});

export const schemaResumeEchangeLlm = z.object({
  id: entier,
  ts: horodatage,
  req_id: z.string().nullable(),
  user_id: entier.nullable(),
  chat_id: z.string().nullable(),
  model: z.string().nullable(),
  path: z.string().nullable(),
  status: z.string().nullable(),
  finish_reason: z.string().nullable(),
  prompt_tokens: entier.nullable(),
  completion_tokens: entier.nullable(),
  duration_ms: entier.nullable(),
  n_messages: entier.nullable(),
  n_tool_calls: entier.nullable(),
  error: z.string().nullable(),
});
export const schemaReponseTraficLlm = z.object({
  calls: z.array(schemaResumeEchangeLlm),
  count: entier,
  enabled: z.boolean(),
  max_entries: entier,
});
/** Détail : le résumé, sans les charges brutes, plus la requête et la réponse décodées (texte brut si illisibles). */
export const schemaDetailEchangeLlm = z.looseObject({
  id: entier,
  ts: horodatage,
  request: z.unknown(),
  response: z.unknown(),
});
export const schemaReponseEffacementTrafic = z.object({ ok: z.literal(true), deleted: entier });
