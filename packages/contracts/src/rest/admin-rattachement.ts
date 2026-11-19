// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-rattachement.ts — console : rattachement des comptes locaux à une identité d'annuaire (assistant LDAP, détachement) et rattachements préparés (OIDC). */
import { z } from "zod";

import { entier, horodatage } from "./commun";

export const schemaEtatEntreeAnnuaire = z.enum(["active", "desactivee", "verrouillee", "expiree", "inconnu"]);

/** Entrée d'annuaire proposée : `subject` est la clé stable, la seule donnée que le serveur croit en retour ; `in_required_group` est nul quand les groupes sont illisibles. */
export const schemaPropositionAnnuaire = z.object({
  subject: z.string(),
  dn: z.string(),
  ext_username: z.string(),
  ext_name: z.string(),
  ext_email: z.string(),
  state: schemaEtatEntreeAnnuaire,
  in_required_group: z.boolean().nullable(),
});
export type PropositionAnnuaire = z.infer<typeof schemaPropositionAnnuaire>;

export const schemaCompteAMigrer = z.object({
  user_id: entier,
  username: z.string(),
  role: z.enum(["admin", "moderator", "user"]),
  last_login_at: horodatage.nullable(),
  suspended: z.boolean(),
  proposal: schemaPropositionAnnuaire.nullable(),
});
export type CompteAMigrer = z.infer<typeof schemaCompteAMigrer>;

/** Comptes locaux sans identité (page de 100 au plus) et nombre total restant. */
export const schemaReponseMigration = z.object({
  items: z.array(schemaCompteAMigrer),
  total: entier,
  offset: entier,
  limit: entier,
});
export type ReponseMigration = z.infer<typeof schemaReponseMigration>;

export const schemaCorpsRechercheMigration = z.object({ query: z.string().min(3).max(64) });
export const schemaReponseRechercheMigration = z.object({ items: z.array(schemaPropositionAnnuaire) });

export const RAISONS_LIEN = [
  "account_not_found",
  "account_has_identity",
  "account_suspended",
  "admin_confirmation_required",
  "last_local_admin",
  "entry_already_linked",
  "duplicate",
  "entry_not_found",
  "entry_ambiguous",
  "entry_not_active",
  "entry_not_loginable",
  "not_in_group",
  "groups_unknown",
  "directory_unavailable",
] as const;

/** Au plus 50 liens ; `confirm_admins` liste les comptes administrateurs et modérateurs que l'opérateur confirme un par un ; `keep_tokens` garde les jetons d'API et accès OAuth (révoqués par défaut). */
export const schemaCorpsRattachement = z.object({
  links: z
    .array(z.object({ user_id: entier, subject: z.string().min(1).max(256) }))
    .min(1)
    .max(50),
  confirm_admins: z.array(entier).max(50).default([]),
  keep_tokens: z.boolean().default(false),
});
export const schemaReponseRattachement = z.object({
  results: z.array(
    z.object({
      user_id: entier,
      subject: z.string(),
      result: z.enum(["linked", ...RAISONS_LIEN]),
      revoked_tokens: entier.optional(),
      revoked_oauth: entier.optional(),
      kept: z.literal(true).optional(),
      role_will_be_managed: z.literal(true).optional(),
    }),
  ),
  kept_tokens: z.boolean().default(false),
});
export type ReponseRattachement = z.infer<typeof schemaReponseRattachement>;

/** Mot de passe temporaire posé dans le même geste que le détachement (politique de mot de passe de l'instance). */
export const schemaCorpsDetachement = z.object({ new_password: z.string().min(1) });

export const schemaRattachementPrepare = z.object({
  id: entier,
  user_id: entier,
  username: z.string().nullable(),
  expected: z.string(),
  waiver: z.boolean(),
  created_by: entier,
  created_at: horodatage,
  expires_at: horodatage,
});
export type RattachementPrepare = z.infer<typeof schemaRattachementPrepare>;
export const schemaReponseRattachementsPrepares = z.object({ items: z.array(schemaRattachementPrepare) });

/** `waiver` : dispense de la preuve par l'ancien mot de passe, refusée pour un administrateur ; `confirm_admin` obligatoire pour un administrateur. */
export const schemaCorpsRattachementPrepare = z.object({
  user_id: entier,
  expected: z.string().min(1).max(255),
  waiver: z.boolean().default(false),
  confirm_admin: z.boolean().default(false),
});

export const schemaIdentiteCompte = z.object({
  provider_id: z.string(),
  ext_username: z.string().nullable(),
  linked_at: horodatage,
});
export type IdentiteCompte = z.infer<typeof schemaIdentiteCompte>;
