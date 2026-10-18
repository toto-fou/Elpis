// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-config.ts — console : configuration d'instance (`config.json`) et réglages de compression. */
import { z } from "zod";

import { entier } from "./commun";

export const schemaCompressionConfig = z.object({
  enabled: z.boolean(),
  keep_recent_turns: entier,
  keep_bridge_turns: entier,
  external_model: z.string(),
  endpoint_url: z.string(),
  endpoint_model: z.string(),
  endpoint_timeout_sec: entier,
  max_per_chat: entier,
  buffer_tokens: entier,
  partial_target_ratio: z.number(),
  threshold_pct: entier,
  threshold_tokens: entier,
});
export type CompressionConfig = z.infer<typeof schemaCompressionConfig>;
/** Tout champ absent garde sa valeur courante ; le serveur borne les autres. */
export const schemaCorpsCompressionConfig = schemaCompressionConfig.partial();

/** `type` : seul `main` existe ; `content` est le texte JSON de `config.json`. */
export const schemaReponseFichierConfig = z.object({ content: z.string() });
export const schemaCorpsFichierConfig = z.object({ type: z.literal("main"), content: z.string() });

/** Un changement vise un chemin pointé ; `from` (ou `from_absent`) sert de garde contre une modification concurrente. */
export const schemaChangementConfig = z.object({
  path: z.string(),
  to: z.unknown().optional(),
  delete: z.boolean().optional(),
  from: z.unknown().optional(),
  from_absent: z.boolean().optional(),
});
export const schemaCorpsModificationConfig = z.object({
  changes: z.array(schemaChangementConfig),
  force: z.boolean().optional(),
});
export const schemaReponseModificationConfig = z.object({ ok: z.literal(true), applied: entier });
/** 409 : valeurs de départ périmées. */
export const schemaConflitConfig = z.object({
  detail: z.string(),
  conflicts: z.array(z.object({ path: z.string(), current: z.unknown(), absent: z.boolean().optional() })),
});
/** 400 : réglages possédés par un autre écran de la console. */
export const schemaRefusPossedeConfig = z.object({ detail: z.string(), paths: z.array(z.string()) });
