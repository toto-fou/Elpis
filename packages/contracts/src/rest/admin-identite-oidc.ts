// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-identite-oidc.ts — console › essai à blanc d'un fournisseur SSO : lancement (étapes puis adresse d'autorisation) et dernier résultat. */
import { z } from "zod";

import { CODES_ERREUR_CONNEXION } from "./identite";

/** Causes d'un essai qui n'a pas abouti, nommées pour dire quoi corriger ; jamais un message du fournisseur. */
export const CAUSES_ECHEC_ESSAI = [
  "settings_changed",
  "secret_missing",
  "client_auth_rejected",
  "code_rejected",
  "alg_unexpected",
  "signing_key",
  "aud_untrusted",
  "token_mismatch",
  "clock",
  "subject_invalid",
  "id_token_missing",
] as const;

/** Raisons d'un essai à blanc, liste fermée : codes d'une connexion refusée, raisons de refus d'un compte, causes d'un échec. */
export const RAISONS_ESSAI = [
  ...CODES_ERREUR_CONNEXION,
  "issuer_mismatch",
  "name_invalid",
  "account_conflict",
  "no_local_admin",
  "prelink_invalid",
  ...CAUSES_ECHEC_ESSAI,
] as const;
export type RaisonEssai = (typeof RAISONS_ESSAI)[number];

/** Raisons de refus d'un compte par la décision d'une connexion SSO, que le serveur rend à la connexion comme à l'essai. */
export const RAISONS_REFUS_COMPTE = [
  "issuer_mismatch",
  "groups_unknown",
  "not_in_group",
  "suspended",
  "name_invalid",
  "account_conflict",
  "no_local_admin",
  "prelink_invalid",
] as const satisfies readonly RaisonEssai[];
export type RaisonRefusCompte = (typeof RAISONS_REFUS_COMPTE)[number];

/** Étapes du test préalable ; `url` n'est rendue que si toutes passent : l'administrateur s'y connecte dans un nouvel onglet. */
export const schemaReponseLancementEssai = z.object({
  ok: z.boolean(),
  steps: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      level: z.enum(["ok", "warn", "fail"]),
      detail: z.string(),
      target: z.string().nullable(),
    }),
  ),
  url: z.string().nullable(),
});
export type ReponseLancementEssai = z.infer<typeof schemaReponseLancementEssai>;

/** Résultat d'un essai à blanc : revendications d'une liste blanche (groupes tronqués à 50, `null` quand ils ne se lisent pas) et décision qui serait prise. */
export const schemaResultatEssaiBlanc = z.object({
  /** Secondes depuis l'époque. */
  at: z.number(),
  /** Le parcours est allé au bout et les groupes se lisent : le test du fournisseur est alors retenu. */
  ok: z.boolean(),
  claims: z
    .object({
      iss: z.string(),
      subject: z.string(),
      identifier: z.string(),
      name: z.string(),
      email: z.string(),
      email_verified: z.boolean(),
      acr: z.string().nullable(),
      amr: z.array(z.string()),
      /** Ce qui prouve un second facteur dans le jeton : un niveau `acr` déclaré (`acr`), les méthodes `amr` (`amr`), ou rien (`null`). */
      second_factor: z.enum(["acr", "amr"]).nullable(),
      groups: z.array(z.string()).nullable(),
    })
    .nullable(),
  /** Même décision qu'une vraie connexion : `login` (compte rattaché), `link` (rattachement préparé dispensé de preuve), `proof` (rattachement préparé : ancien mot de passe demandé), `create`, `refuse`, ou `error` (le parcours n'a pas abouti). */
  decision: z.object({
    outcome: z.enum(["login", "link", "proof", "create", "refuse", "error"]),
    /** Compte visé quand il est connu (compte rattaché, préparé, créé, ou nom déjà pris). */
    username: z.string().nullable(),
    /** Raison d'un refus ou cause d'un échec, d'une liste fermée ; jamais un message du fournisseur. */
    reason: z.enum(RAISONS_ESSAI).nullable(),
    /** Avec `account_conflict` : vrai si tout compte qui porte ce nom est déjà rattaché à un fournisseur (aucun ne peut être préparé), faux si l'un est local ; absent pour les autres décisions. */
    conflict_linked: z.boolean().optional(),
  }),
  /** Rôle et groupes Elpis qu'obtiendrait ce compte à cette connexion (rien n'est écrit) ; `null` quand la connexion serait refusée ou que le parcours n'a pas abouti. */
  rights: z
    .object({
      roles_enabled: z.boolean(),
      groups_enabled: z.boolean(),
      /** Faux : une appartenance est illisible, aucun droit ne serait modifié. */
      readable: z.boolean(),
      role: z.enum(["user", "moderator", "admin"]).nullable(),
      groups: z.array(z.object({ id: z.number(), name: z.string() })),
      /** Groupes Elpis de la correspondance qui n'existent plus (ignorés). */
      missing_group_ids: z.array(z.number()),
      /** Groupes d'administrateurs ignorés : le fournisseur n'est invité à aucun second facteur. */
      admin_ignored: z.boolean(),
    })
    .nullable()
    .default(null),
  warnings: z.array(z.string()),
});
export type ResultatEssaiBlanc = z.infer<typeof schemaResultatEssaiBlanc>;

export const schemaReponseDernierEssai = z.object({ result: schemaResultatEssaiBlanc.nullable() });
export type ReponseDernierEssai = z.infer<typeof schemaReponseDernierEssai>;
export const schemaCorpsLancementEssai = z.object({}).strict().optional();
