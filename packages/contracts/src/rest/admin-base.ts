// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-base.ts — console : base de données (état, cible enregistrée, test, simulation, bascule vers PostgreSQL ou retour à SQLite, tâche en cours). */
import { z } from "zod";

import { dictionnaire, entier } from "./commun";

export const schemaCibleEnregistree = z.object({
  backend: z.string(),
  host: z.string(),
  port: entier.nullable(),
  name: z.string(),
  user: z.string(),
  tls: z.string(),
  /** Vrai si une cible attend sa bascule ; le mot de passe n'est jamais rendu. */
  pending: z.boolean(),
  password_present: z.boolean(),
});
export const schemaEtatTacheBase = z.looseObject({ state: z.string() });
export const schemaReponseBase = z.object({
  /** Infos de la base active, ou `{error}` si elle ne répond pas. */
  active: z.looseObject({
    backend: z.string().optional(),
    location: z.string().optional(),
    generation: entier.optional(),
    version: z.string().optional(),
    size_bytes: entier.optional(),
    migrations: entier.optional(),
    last_migration: z.string().nullable().optional(),
    pending_migrations: z.array(z.string()).optional(),
    pool: dictionnaire.nullable().optional(),
    error: z.string().optional(),
  }),
  saved: schemaCibleEnregistree,
  env: z.array(z.string()),
  job: schemaEtatTacheBase,
});
export type ReponseBase = z.infer<typeof schemaReponseBase>;

/** `password` vide : le secret déjà enregistré est repris. */
export const schemaCorpsCibleBase = z.object({
  backend: z.enum(["postgres", "postgresql"]),
  host: z.string(),
  name: z.string(),
  user: z.string(),
  port: entier.optional(),
  tls: z.enum(["off", "require", "verify"]).optional(),
  password: z.string().optional(),
});
export const schemaReponseEnregistrementBase = z.object({
  ok: z.literal(true),
  saved: schemaCibleEnregistree,
});
/** Test ou simulation : succès détaillé du moteur de transfert, ou `{ok: false, error}`. */
export const schemaReponseEssaiBase = z.looseObject({ ok: z.boolean(), error: z.string().optional() });
export const schemaReponseTacheBase = schemaEtatTacheBase;
