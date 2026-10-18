// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-agents.ts — console : sous-agents (`task`), lecture seule par type (défaut et imposition), sous-agents simultanés par tour ; section `agents` de config.json. */
import { z } from "zod";

import { entier } from "./commun";

/** Types réglables : les cinq livrés et `custom` (tous les agents personnels). */
export const TYPES_AGENTS_REGLABLES = ["explore", "implement", "verify", "web", "pr", "custom"] as const;
export type TypeAgentReglable = (typeof TYPES_AGENTS_REGLABLES)[number];

const parType = z.strictObject({
  explore: z.boolean(),
  implement: z.boolean(),
  verify: z.boolean(),
  web: z.boolean(),
  pr: z.boolean(),
  custom: z.boolean(),
});

/** `defaults` : lecture seule par défaut ; `forced` : imposée (ni le compte ni l'agent principal ne la lèvent). */
export const schemaLectureSeuleAgents = z.object({ defaults: parType, forced: parType });
export type LectureSeuleAgents = z.infer<typeof schemaLectureSeuleAgents>;

/** `max_parallel` : sous-agents d'un même tour lancés ensemble, de 1 à 10. */
export const schemaReglagesAgents = z.object({
  read_only: schemaLectureSeuleAgents,
  max_parallel: entier,
});
export type ReglagesAgents = z.infer<typeof schemaReglagesAgents>;

export const BORNES_PARALLELE_AGENTS = [1, 10] as const;
export const DEFAUTS_REGLAGES_AGENTS: ReglagesAgents = {
  read_only: {
    defaults: { explore: true, implement: false, verify: false, web: false, pr: false, custom: false },
    forced: { explore: false, implement: false, verify: false, web: false, pr: false, custom: false },
  },
  max_parallel: 3,
};

/** `GET /api/admin/agents` : réglages en vigueur (défauts pour une clé absente), types et bornes du formulaire. */
export const schemaReponseReglagesAgents = z.object({
  config: schemaReglagesAgents,
  types: z.array(z.enum(TYPES_AGENTS_REGLABLES)),
  bounds: z.object({ max_parallel: z.tuple([entier, entier]) }),
});
export type ReponseReglagesAgents = z.infer<typeof schemaReponseReglagesAgents>;

/** Corps du `POST` : toute clé absente garde sa valeur ; type inconnu, non-booléen ou `max_parallel` hors bornes : 400. */
export const schemaCorpsReglagesAgents = z.object({
  agents: z.object({
    read_only: z
      .object({ defaults: parType.partial().optional(), forced: parType.partial().optional() })
      .optional(),
    max_parallel: entier.optional(),
  }),
});
export type CorpsReglagesAgents = z.infer<typeof schemaCorpsReglagesAgents>;
export const schemaReponseReglagesAgentsEcrits = z.object({
  ok: z.literal(true),
  config: schemaReglagesAgents,
});
