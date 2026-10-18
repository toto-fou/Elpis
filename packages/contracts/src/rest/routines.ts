// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/routines.ts — routines planifiées du compte (`/api/routines*`) : CRUD, activation, exécution immédiate, historique des runs, webhook. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

export const schemaRoutine = z.object({
  id: entier,
  owner_user_id: entier,
  name: z.string(),
  cron_expr: z.string(),
  model: z.string().nullable(),
  system_prompt: z.string(),
  task_prompt: z.string(),
  /** Références des serveurs MCP (id, manifeste, url) et non les serveurs eux-mêmes. */
  mcp_snapshot: z.array(dictionnaire),
  skills: z.array(z.string()),
  thinking_mode: z.boolean(),
  enabled: z.boolean(),
  created_at: horodatage,
  updated_at: horodatage,
  last_fire_minute: z.unknown(),
  runs_keep: entier,
  notify_on: z.enum(["all", "error", "none"]),
  notify_keep: entier,
  webhook_enabled: z.boolean(),
  webhook_filter: dictionnaire,
  trigger_after_id: entier.nullable(),
  trigger_after_on: z.enum(["ok", "error", "always"]),
  agents_enabled: z.boolean(),
  connector_id: entier.nullable(),
  webhook_has_secret: z.boolean(),
});
export type Routine = z.infer<typeof schemaRoutine>;
/** La liste ajoute le dernier run et le nombre de runs en cours. */
export const schemaRoutineListee = schemaRoutine.extend({
  last_run: z.looseObject({}).nullable(),
  running_count: entier,
});
export const schemaReponseRoutines = z.object({ items: z.array(schemaRoutineListee) });

/** `cron` est accepté comme synonyme de `cron_expr` ; `active_mcp_servers` de `mcp_servers`. */
export const schemaCorpsRoutine = z.object({
  name: z.string(),
  cron_expr: z.string().optional(),
  cron: z.string().optional(),
  model: z.string().nullable().optional(),
  connector_id: z.union([entier, z.string(), z.null()]).optional(),
  system_prompt: z.string().optional(),
  task_prompt: z.string().optional(),
  mcp_servers: z.array(dictionnaire).optional(),
  active_mcp_servers: z.array(dictionnaire).optional(),
  skills: z.array(z.string()).optional(),
  thinking_mode: z.boolean().optional(),
  enabled: z.boolean().optional(),
  trigger_after_id: z.union([entier, z.string(), z.null()]).optional(),
  trigger_after_on: z.enum(["ok", "error", "always"]).optional(),
  agents_enabled: z.boolean().optional(),
  runs_keep: z.union([entier, z.string(), z.null()]).optional(),
  notify_on: z.enum(["all", "error", "none"]).nullable().optional(),
  notify_keep: z.union([entier, z.string(), z.null()]).optional(),
});
/** Mise à jour partielle : une clé absente reste inchangée. */
export const schemaCorpsMajRoutine = schemaCorpsRoutine.partial();
export const schemaReponseRoutineCreee = z.object({ id: entier, ok: z.literal(true) });
export const schemaReponseActivationRoutine = z.object({ ok: z.literal(true), enabled: z.boolean() });

/** Soit le run démarré, soit `skipped` avec la raison (cap de runs simultanés ou refus du planificateur). */
export const schemaReponseLancementRoutine = z.union([
  z.object({ ok: z.literal(true), run_id: entier }),
  z.object({ ok: z.literal(false), skipped: z.literal(true), reason: z.string() }),
]);

export const schemaRunRoutine = z.object({
  id: entier,
  routine_id: entier,
  owner_user_id: entier,
  status: z.string(),
  trigger: z.string(),
  started_at: horodatage,
  ended_at: horodatage.nullable(),
  duration_ms: entier.nullable(),
  input_tokens: entier.nullable(),
  output_tokens: entier.nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  tool_limit_reached: entier,
  worker_boot_id: z.string().nullable(),
  heartbeat_at: horodatage.nullable(),
  files: z.array(z.unknown()),
});
export type RunRoutine = z.infer<typeof schemaRunRoutine>;
export const schemaReponseRunsRoutine = z.object({ items: z.array(schemaRunRoutine) });
/** `stopping` vrai : arrêt demandé ; faux : le run n'était plus actif (`status` dit pourquoi). */
export const schemaReponseArretRun = z.union([
  z.object({ ok: z.literal(true), stopping: z.literal(true) }),
  z.object({ ok: z.literal(true), stopping: z.literal(false), status: z.string().nullable() }),
]);

/** Le secret n'est rendu qu'à la rotation. */
export const schemaReponseRotationWebhook = z.object({
  ok: z.literal(true),
  secret: z.string(),
  path: z.string(),
});
export const schemaReponseDesactivationWebhook = z.object({
  ok: z.literal(true),
  webhook_enabled: z.literal(false),
});
export const schemaFiltreWebhook = z.object({
  events: z.array(z.string()),
  branch: z.string(),
  repo: z.string(),
});
export const schemaCorpsFiltreWebhook = schemaFiltreWebhook.partial();
export const schemaReponseFiltreWebhook = z.object({
  ok: z.literal(true),
  webhook_filter: schemaFiltreWebhook,
});
