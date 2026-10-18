// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/git.ts — connecteurs git du compte (`/api/git/connectors*`) : jeton en écriture seule, test et dépôts côté serveur. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

export const schemaConnecteurGit = z.object({
  id: entier,
  owner_user_id: entier,
  provider_type: z.string(),
  host: z.string(),
  api_base: z.string(),
  label: z.string(),
  username: z.string(),
  token_scheme: z.string(),
  created_at: horodatage,
  updated_at: horodatage,
  last_used: horodatage.nullable(),
  has_token: z.boolean(),
});
export type ConnecteurGit = z.infer<typeof schemaConnecteurGit>;
export const schemaReponseConnecteursGit = z.object({
  connectors: z.array(schemaConnecteurGit),
  provider_types: z.array(z.string()),
});

export const schemaCorpsAnalyseUrlGit = z.object({
  url: z.string().optional(),
  provider_type: z.string().optional(),
});
/** Analyse d'une URL de dépôt : hôte, type détecté et base d'API ; `{ok: false}` si l'URL ne dit rien. */
export const schemaReponseAnalyseUrlGit = z.union([
  z.object({
    ok: z.literal(true),
    host: z.string(),
    detected_provider_type: z.string(),
    api_base: z.string(),
    scheme: z.string(),
  }),
  z.object({ ok: z.literal(false) }),
]);

export const schemaCorpsConnecteurGit = z.object({
  provider_type: z.string(),
  host: z.string(),
  token: z.string(),
  api_base: z.string().optional(),
  label: z.string().optional(),
  username: z.string().optional(),
});
export const schemaCorpsMajConnecteurGit = z.object({
  provider_type: z.string().optional(),
  host: z.string().optional(),
  token: z.string().optional(),
  api_base: z.string().optional(),
  label: z.string().optional(),
  username: z.string().optional(),
});
export const schemaReponseConnecteurGitCree = z.object({ ok: z.literal(true), id: entier });

/** Dépôts visibles par le jeton ; hors garde SSRF ou API absente : `{ok: false, error}`. */
export const schemaReponseDepotsGit = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  host: z.string().optional(),
  repos: z.array(dictionnaire).optional(),
});
export const schemaReponseEssaiGit = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  hint: z.string().optional(),
  host: z.string().optional(),
  api_base: z.string().optional(),
});
