// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/coffre.ts — coffre d'identifiants du compte (`/api/coffre*`) et jetons `⟦creds:…⟧` d'une conversation : mot de passe en écriture seule. */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaEntreeCoffre = z.object({
  id: entier,
  nom: z.string(),
  origin: z.string().nullable(),
  origin_confirmed: z.boolean(),
  username: z.string(),
  allow_insecure_tls: z.boolean(),
  use_count: entier,
  last_used_at: horodatage.nullable(),
  created_at: horodatage,
  updated_at: horodatage,
});
export type EntreeCoffre = z.infer<typeof schemaEntreeCoffre>;
export const schemaReponseCoffre = z.object({ items: z.array(schemaEntreeCoffre) });
export const schemaReponseEntreeCoffre = z.object({ ok: z.literal(true), item: schemaEntreeCoffre });

export const schemaCorpsCreationCoffre = z.object({
  nom: z.string(),
  origin: z.string(),
  username: z.string(),
  password: z.string(),
  allow_insecure_tls: z.boolean().optional(),
});
/** Mot de passe absent ou vide : inchangé ; changer l'origine d'une entrée confirmée exige de le ressaisir. */
export const schemaCorpsMajCoffre = z.object({
  nom: z.string().optional(),
  origin: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  allow_insecure_tls: z.boolean().optional(),
});
/** Première confirmation d'une entrée reprise : l'origine seule ; toute autre origine exige aussi le mot de passe. */
export const schemaCorpsConfirmationCoffre = z.object({
  origin: z.string(),
  password: z.string().optional(),
});

export const schemaJetonCreds = z.object({
  id: entier,
  chat_id: z.string(),
  origin: z.string(),
  label: z.string(),
  entry_id: entier.nullable(),
  created_at: horodatage,
  expires_at: horodatage,
  uses_left: entier,
  allow_insecure_tls: z.boolean(),
});
export type JetonCreds = z.infer<typeof schemaJetonCreds>;
export const schemaReponseJetonsCreds = z.object({ items: z.array(schemaJetonCreds) });
export const schemaReponseJetonCreds = z.object({ ok: z.literal(true), item: schemaJetonCreds });
/** Le jeton en clair n'est rendu qu'à la création. */
export const schemaReponseJetonCredsCree = z.object({
  ok: z.literal(true),
  token: z.string(),
  item: schemaJetonCreds,
});

/** Depuis une entrée du coffre (`entry_id`) ou depuis un secret ponctuel (`origin`, `username`, `password`, `save`). */
export const schemaCorpsJetonCreds = z.object({
  chat_id: z.string(),
  entry_id: entier.optional(),
  origin: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  save: z.boolean().optional(),
  allow_insecure_tls: z.boolean().optional(),
});
