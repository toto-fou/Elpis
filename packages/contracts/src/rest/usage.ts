// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/usage.ts — usage du compte connecté seul (`/api/usage/me`) : conversations, messages, tokens par type et par source, exécutions de routines. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaUsageSource = z.object({
  source: z.string(),
  tokens: entier,
  turns: entier,
  input: entier,
  output: entier,
  cache: entier,
  input_new: entier,
  tools: entier,
  thinking: entier,
  response: entier,
});
export type UsageSource = z.infer<typeof schemaUsageSource>;

export const schemaUsageTokens = z.object({
  input: entier,
  output: entier,
  total: entier,
  cache: entier,
  input_new: entier,
  cache_creation: entier,
  cache_pct: z.number(),
  tools: entier,
  thinking: entier,
  response: entier,
  estimated: z.boolean(),
  split_available: z.boolean(),
  by_source: z.array(schemaUsageSource),
});

/** Fenêtre ramenée à 1, 7, 30 ou 90 jours ; `since` est un horodatage flottant. */
export const schemaReponseUsageMoi = z.object({
  days: entier,
  since: horodatage,
  chats: z.object({ active: entier, archived: entier, total: entier }),
  messages: z.object({ sent: entier, received: entier }),
  tokens: schemaUsageTokens,
  routines: z.object({
    runs: entier,
    ok: entier,
    error: entier,
    input_tokens: entier,
    output_tokens: entier,
    avg_duration_ms: entier,
  }),
});
export type ReponseUsageMoi = z.infer<typeof schemaReponseUsageMoi>;
