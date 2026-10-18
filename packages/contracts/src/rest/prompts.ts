// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/prompts.ts — prompts enregistrés, prompts partagés entre comptes et modèles à raccourci (`/api/prompts*`, `/api/prompt-templates*`). */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaPrompt = z.object({
  id: entier,
  user_id: entier,
  title: z.string(),
  content: z.string(),
  created_at: horodatage,
});
export type Prompt = z.infer<typeof schemaPrompt>;
export const schemaReponsePrompts = z.object({ items: z.array(schemaPrompt) });

/** `title` vide : le serveur le tire du contenu. */
export const schemaCorpsPrompt = z.object({ content: z.string(), title: z.string().optional() });
export const schemaReponseNouveauPrompt = z.object({ id: entier, ok: z.literal(true) });

export const schemaPromptPartage = z.object({
  id: entier,
  title: z.string(),
  content: z.string(),
  created_at: horodatage,
  from_username: z.string(),
});
export type PromptPartage = z.infer<typeof schemaPromptPartage>;
export const schemaReponsePromptsPartages = z.object({ items: z.array(schemaPromptPartage) });

export const schemaCorpsPartagePrompt = z.object({ prompt_id: entier, user_ids: z.array(entier) });
export const schemaReponsePartagePrompt = z.object({ ok: z.literal(true), shared_count: entier });
export const schemaCorpsIdsPrompts = z.object({ ids: z.array(entier) });
export const schemaReponseSuppressionPrompts = z.object({ ok: z.literal(true), deleted: entier });

export const schemaModelePrompt = z.object({
  id: entier,
  name: z.string(),
  title: z.string(),
  content: z.string(),
  created_at: horodatage,
  updated_at: horodatage,
});
export type ModelePrompt = z.infer<typeof schemaModelePrompt>;
export const schemaReponseModelesPrompt = z.object({ items: z.array(schemaModelePrompt) });
/** `name` : raccourci en minuscules, chiffres, `-` et `_` ; le serveur retire une barre initiale. */
export const schemaCorpsModelePrompt = z.object({
  name: z.string(),
  content: z.string(),
  title: z.string().optional(),
});
export const schemaReponseModelePrompt = z.object({ ok: z.literal(true), item: schemaModelePrompt });
