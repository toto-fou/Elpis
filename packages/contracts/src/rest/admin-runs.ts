// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-runs.ts — console : exécutions de tous les comptes (liste, agrégat par compte) ; chronologie et export reprennent les formes de `/api/runs/:id`. */
import { z } from "zod";

import { entier, horodatage } from "./commun";
import { schemaLigneExecution } from "./runs";

export const schemaExecutionListee = schemaLigneExecution
  .pick({
    id: true,
    kind: true,
    user_id: true,
    chat_id: true,
    routine_id: true,
    model: true,
    engine: true,
    started_at: true,
    ended_at: true,
    status: true,
    error_kind: true,
    input_tokens: true,
    output_tokens: true,
    cache_read_tokens: true,
    thinking_tokens: true,
    tool_tokens: true,
    llm_calls: true,
    prefill_ms: true,
    decode_ms: true,
    wait_ms: true,
    tool_calls: true,
    tool_errors: true,
    files_changed: true,
    sandbox_cpu_peak: true,
    sandbox_mem_peak_mb: true,
  })
  .extend({ username: z.string().nullable() });
export type ExecutionListee = z.infer<typeof schemaExecutionListee>;
export const schemaReponseExecutionsConsole = z.object({ items: z.array(schemaExecutionListee) });

export const schemaExecutionParCompte = z.object({
  user_id: entier.nullable(),
  username: z.string().nullable(),
  runs: entier,
  failed: entier,
  subagents: entier,
  input_tokens: entier,
  output_tokens: entier,
  thinking_tokens: entier,
  cache_read_tokens: entier,
  cache_creation_tokens: entier,
  tool_tokens: entier,
  llm_ms: entier,
  prefill_ms: entier,
  decode_ms: entier,
  wait_ms: entier,
  tool_calls: entier,
  tool_errors: entier,
  files_changed: entier,
  sandbox_cpu_peak: z.number().nullable(),
  sandbox_mem_peak_mb: z.number().nullable(),
  last_at: horodatage.nullable(),
});
/** `hours` : fenêtre effective, bornée à 1..720. */
export const schemaReponseExecutionsParCompte = z.object({
  hours: entier,
  items: z.array(schemaExecutionParCompte),
});
