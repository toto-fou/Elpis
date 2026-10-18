// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/session.ts — session et comptes : `/api/me-lite`, connexion, déconnexion, mot de passe, comptes visibles, santé. */
import { z } from "zod";

import { entier } from "./commun";

export const schemaRole = z.enum(["user", "admin", "moderator"]);
export type Role = z.infer<typeof schemaRole>;

/** `is_admin` vaut vrai pour un administrateur ET pour un modérateur : `role` les distingue. */
export const schemaMoiConnecte = z.object({
  logged_in: z.literal(true),
  id: entier,
  username: z.string(),
  is_admin: z.boolean(),
  role: schemaRole,
  avatar: z.string().nullable(),
});
export const schemaMoiMotDePasseAChanger = z.object({
  logged_in: z.literal(false),
  must_change_password: z.literal(true),
  id: entier,
  username: z.string(),
});
export const schemaMoiDeconnecte = z.object({ logged_in: z.literal(false) });
/** L'ordre compte : la variante « mot de passe à changer » avant la déconnexion simple. */
export const schemaReponseMoi = z.union([
  schemaMoiConnecte,
  schemaMoiMotDePasseAChanger,
  schemaMoiDeconnecte,
]);
export type ReponseMoi = z.infer<typeof schemaReponseMoi>;

export const schemaCorpsConnexion = z.object({ username: z.string(), password: z.string() });
export type CorpsConnexion = z.infer<typeof schemaCorpsConnexion>;
export const schemaReponseConnexion = z.object({
  ok: z.literal(true),
  is_admin: z.boolean(),
  must_change_password: z.boolean(),
});
export type ReponseConnexion = z.infer<typeof schemaReponseConnexion>;

/** `old_password` omis seulement quand le compte doit changer son mot de passe. */
export const schemaCorpsChangementMotDePasse = z.object({
  old_password: z.string().optional(),
  new_password: z.string(),
});
export type CorpsChangementMotDePasse = z.infer<typeof schemaCorpsChangementMotDePasse>;

export const schemaCompteLite = z.object({ id: entier, username: z.string(), groups: z.string() });
export const schemaGroupe = z.object({ id: entier, name: z.string(), description: z.string().nullable() });
export const schemaReponseComptesLite = z.object({
  users: z.array(schemaCompteLite),
  my_groups: z.array(schemaGroupe),
});
export type ReponseComptesLite = z.infer<typeof schemaReponseComptesLite>;

export const schemaReponseSante = z.object({ status: z.literal("ok") });
