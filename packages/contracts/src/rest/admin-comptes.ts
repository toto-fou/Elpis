// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-comptes.ts — console : comptes, groupes, accès aux moteurs LLM, quota et réseau du bac, accès délivrés, clients OAuth. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";
import { schemaRole } from "./session";

export const schemaCorpsCreationCompte = z.object({
  username: z.string(),
  password: z.string(),
  role: schemaRole.optional(),
});
export const schemaCorpsRoleCompte = z.object({ role: schemaRole });
/** `role` est rendu tel que reçu. */
export const schemaReponseRoleCompte = z.object({ ok: z.literal(true), role: schemaRole });
export const schemaCorpsReinitialisationMotDePasse = z.object({
  target_id: entier,
  new_password: z.string(),
});
export const schemaReponseSuppressionCompte = z.object({
  ok: z.literal(true),
  sandbox_deleted: z.boolean(),
  sandbox_error: z.string().optional(),
});

export const schemaProfilReseau = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.string(),
  ips: z.array(z.string()),
  description: z.string(),
  domains: z.array(z.string()),
  ports: z.array(z.unknown()),
  dns: z.array(z.string()),
});
export const schemaMachineBureau = z.object({
  name: z.string(),
  os: z.string(),
  access: z.string(),
  allowed_users: z.array(z.string()),
});
export const schemaCompteConsole = z.object({
  id: entier,
  username: z.string(),
  is_admin: entier,
  created_at: horodatage,
  avatar: z.string().nullable(),
  group_names: z.string(),
  group_ids: z.array(entier),
  sandbox_quota_mb: entier,
  network_profile_id: z.string(),
  forced_network_profile_id: z.string(),
  sandbox_used_mb: z.number(),
  llm_engine_keys: z.array(z.string()).nullable(),
  llm_can_manage_models: z.boolean().nullable(),
  llm_effective_engine_keys: z.array(z.string()).nullable(),
  llm_engine_source: z.string(),
  llm_effective_can_manage_models: z.boolean(),
  llm_manage_source: z.string(),
});
export type CompteConsole = z.infer<typeof schemaCompteConsole>;
export const schemaReponseComptesConsole = z.object({
  users: z.array(schemaCompteConsole),
  network_profiles: z.array(schemaProfilReseau),
  desktop_targets: z.array(schemaMachineBureau),
});
export type ReponseComptesConsole = z.infer<typeof schemaReponseComptesConsole>;

export const schemaCorpsMachinesCompte = z.object({ targets: z.array(z.string()) });
export const schemaReponseMachinesCompte = z.object({
  ok: z.literal(true),
  changed: z.array(z.unknown()),
  desktop_targets: z.array(schemaMachineBureau),
});

export const schemaMoteurChoisissable = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.string(),
  provider_type: z.string(),
  enabled: z.boolean(),
});
export const schemaReponseMoteursChoisissables = z.object({ engines: z.array(schemaMoteurChoisissable) });

/** `null` : valeur héritée (aucun réglage propre). */
export const schemaCorpsAccesLlm = z.object({
  engine_keys: z.array(z.string()).nullable().optional(),
  can_manage_models: z.boolean().nullable().optional(),
});
export const schemaAccesLlmCompte = z.object({
  engine_keys: z.array(z.string()).nullable(),
  can_manage_models: z.boolean().nullable(),
  effective_engine_keys: z.array(z.string()).nullable(),
  engine_source: z.string(),
  effective_can_manage_models: z.boolean(),
  manage_source: z.string(),
});
export const schemaReponseAccesLlmCompteEcrit = schemaAccesLlmCompte.extend({ ok: z.literal(true) });
export const schemaAccesLlmGroupe = z.object({
  engine_keys: z.array(z.string()).nullable(),
  can_manage_models: z.boolean().nullable(),
});
export const schemaReponseAccesLlmGroupeEcrit = schemaAccesLlmGroupe.extend({ ok: z.literal(true) });

/** `quota_mb` : -1 rétablit le quota global. */
export const schemaCorpsQuotaBac = z.object({ quota_mb: entier });
export const schemaReponseQuotaBac = z.object({ ok: z.literal(true), quota_mb: entier });
/** `profile_id` vide : retire le profil imposé. */
export const schemaCorpsProfilReseau = z.object({ profile_id: z.string().optional() });
export const schemaReponseProfilReseau = z.object({
  ok: z.literal(true),
  forced_network_profile_id: z.string(),
  network_profile_id: z.string(),
  container_destroyed: z.boolean(),
});

export const schemaReponseAccesCompte = z.object({
  tokens: z.array(
    z.object({
      id: entier,
      kind: z.string(),
      name: z.string(),
      families: z.array(z.string()),
      created_at: horodatage,
      expires_at: horodatage.nullable(),
      last_used_at: horodatage.nullable(),
    }),
  ),
  grants: z.array(
    z.object({
      grant_id: z.string().nullable(),
      client_name: z.string().nullable(),
      families: z.array(z.string()).nullable(),
      created_at: horodatage.nullable(),
      last_used_at: horodatage.nullable(),
    }),
  ),
});
export const schemaReponseRevocationAcces = z.object({
  ok: z.literal(true),
  tokens: entier,
  oauth: entier,
});

export const schemaGroupeConsole = z.object({
  id: entier,
  name: z.string(),
  description: z.string().nullable(),
  created_at: horodatage,
  member_count: entier,
  llm_engine_keys: z.array(z.string()).nullable(),
  llm_can_manage_models: z.boolean().nullable(),
});
export const schemaReponseGroupesConsole = z.object({ groups: z.array(schemaGroupeConsole) });
export const schemaCorpsGroupe = z.object({ name: z.string(), description: z.string().optional() });
export const schemaReponseGroupeCree = z.object({ ok: z.literal(true), id: entier });
export const schemaCorpsGroupesCompte = z.object({ group_ids: z.array(entier) });
export const schemaReponseGroupesCompte = z.object({ ok: z.literal(true), group_ids: z.array(entier) });

export const schemaClientOauth = z.object({
  client_id: z.string(),
  kind: z.string(),
  name: z.string(),
  has_secret: z.boolean(),
  auth_method: z.string(),
  redirect_uris: z.array(z.string()),
  metadata: dictionnaire,
  created_at: horodatage,
  fetched_at: horodatage.nullable(),
  last_used_at: horodatage.nullable(),
  grants: entier,
  age_days: entier,
});
export const schemaReponseClientsOauth = z.object({ items: z.array(schemaClientOauth) });
