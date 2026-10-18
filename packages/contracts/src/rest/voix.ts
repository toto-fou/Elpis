// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/voix.ts — dictée et réponse vocale du compte : état (`/api/voice/status`) et transcription ; la synthèse (`/api/voice/speak`) rend de l'audio, hors registre. */
import { z } from "zod";

import { entier } from "./commun";

export const schemaReponseEtatVoix = z.object({
  stt: z.boolean(),
  tts: z.boolean(),
  /** Moteur de dictée actif ET dictée activée dans les réglages du compte. */
  dictation: z.boolean(),
  reply: z.boolean(),
  language: z.unknown(),
  sample_rate: entier,
  max_utterance_sec: z.unknown(),
  max_upload_mb: z.unknown(),
  max_chars: z.unknown(),
  voice: z.unknown(),
});
export type ReponseEtatVoix = z.infer<typeof schemaReponseEtatVoix>;

/** Un énoncé écarté (trop court, bruit, confiance faible) répond 200 avec `text` vide et `rejected`. */
export const schemaReponseTranscription = z.object({
  text: z.string(),
  duration_ms: entier.optional(),
  rejected: z.string().optional(),
});
export type ReponseTranscription = z.infer<typeof schemaReponseTranscription>;

export const schemaCorpsSynthese = z.object({ text: z.string(), auto: z.boolean().optional() });
