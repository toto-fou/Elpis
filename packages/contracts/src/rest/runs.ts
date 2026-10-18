// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/runs.ts — exécutions (`/api/runs/*`) et pilotage d'un tour (`/api/chat/*`, `/api/chats/active-runs`). */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

const champsExecution = {
  id: z.string(),
  kind: z.string(),
  user_id: entier.nullable(),
  chat_id: z.string(),
  routine_id: entier.nullable(),
  parent_id: z.string(),
  project_id: entier.nullable(),
  model: z.string(),
  engine: z.string(),
  started_at: horodatage,
  ended_at: horodatage.nullable(),
  status: z.string(),
  error_kind: z.string(),
  input_tokens: entier,
  output_tokens: entier,
  cache_read_tokens: entier,
  cache_creation_tokens: entier,
  thinking_tokens: entier,
  llm_calls: entier,
  prefill_ms: entier,
  decode_ms: entier,
  wait_ms: entier,
  tool_calls: entier,
  tool_errors: entier,
  tool_families: z.record(z.string(), z.number()),
  files_changed: entier,
  sandbox_cpu_peak: z.number().nullable(),
  sandbox_mem_peak_mb: z.number().nullable(),
  tool_tokens: entier,
};

export const schemaLigneExecution = z.object(champsExecution);
/** Ligne de la table `runs` ; `children` (exécutions filles, récursives) sur `/api/runs/:id` et dans les filles. */
export type Execution = z.infer<typeof schemaLigneExecution> & { children?: Execution[] | undefined };
export const schemaExecution: z.ZodType<Execution> = schemaLigneExecution.extend({
  children: z.lazy(() => z.array(schemaExecution)).optional(),
});

export const schemaEtapeLlm = z.object({
  type: z.literal("llm"),
  at: horodatage,
  ts: horodatage,
  source: z.string(),
  model: z.string(),
  connector: z.string(),
  input_tokens: entier,
  output_tokens: entier,
  cache_read_tokens: entier,
  cache_creation_tokens: entier,
  thinking_tokens: entier,
  tool_tokens: entier,
  duration_ms: entier,
  iterations: entier,
  status: z.string(),
  error_kind: z.string(),
});
export const schemaEtapeOutil = z.object({
  type: z.literal("tool"),
  at: horodatage,
  call_id: z.string().nullable(),
  started_at: horodatage.nullable(),
  ts: horodatage,
  tool_name: z.string(),
  category: z.string().nullable(),
  status: z.string(),
  duration_ms: entier,
  exit_code: entier.nullable(),
  args_bytes: entier.nullable(),
  result_bytes: entier.nullable(),
  error_short: z.string().nullable(),
  argument: z.string(),
  result: z.string(),
});
export const schemaEtapeFille = z.object({
  type: z.literal("child"),
  at: horodatage,
  run_id: z.string(),
  kind: z.string().nullable(),
  status: z.string().nullable(),
  duration_ms: entier,
});
export const schemaEtapeChronologie = z.discriminatedUnion("type", [
  schemaEtapeLlm,
  schemaEtapeOutil,
  schemaEtapeFille,
]);
export type EtapeChronologie = z.infer<typeof schemaEtapeChronologie>;

export const schemaChronologie = z.object({
  run: schemaExecution,
  events: z.array(schemaEtapeChronologie),
  children: z.array(schemaExecution),
});
export type Chronologie = z.infer<typeof schemaChronologie>;

/** Fichier téléchargé par `/api/runs/:id/export` : chronologies complètes, secrets masqués. */
export const schemaExportExecution = schemaChronologie.extend({
  format: z.literal("elpis-run/1"),
  children_timelines: z.array(schemaChronologie),
});
export type ExportExecution = z.infer<typeof schemaExportExecution>;

/** Champs de reprise présents seulement quand un run tient le chat (`resumable: true`). */
export const schemaEtatGeneration = z.object({
  generation_running: z.boolean(),
  run_id: z.string().nullable(),
  resumable: z.boolean(),
  started_at: horodatage.nullable().optional(),
  base_count: entier.nullable().optional(),
  is_continue: z.boolean().optional(),
  user_message: z.string().optional(),
  engine_key: z.string().optional(),
  image_request: dictionnaire.optional(),
});
export type EtatGeneration = z.infer<typeof schemaEtatGeneration>;

export const schemaReponseRunsActifs = z.object({ chat_ids: z.array(z.string()) });

export const schemaCorpsAnnulation = z.object({ chat_id: z.string().optional() });
export const schemaReponseAnnulation = z.object({ status: z.literal("cancelled") });
export const schemaCorpsAnnulationTache = z.object({ child_id: z.string() });
export const schemaReponseAnnulationTache = z.object({ status: z.literal("cancelled"), active: z.boolean() });

export const schemaCorpsFinRaisonnement = z.object({ chat_id: z.string() });
/** `reason` vide si `ok` ; sinon `no_chat`, `disabled`, `no_active_completion`, `unsupported` ou `engine_refused`. */
export const schemaReponseFinRaisonnement = z.object({ ok: z.boolean(), reason: z.string() });

/** Route obsolète : les messages reviennent tels quels, la compression se fait pendant le flux. */
export const schemaReponseCompressionObsolete = z.object({
  ok: z.literal(true),
  compressed: z.literal(false),
  messages: z.unknown(),
  deprecated: z.literal(true),
  reason: z.string(),
});
