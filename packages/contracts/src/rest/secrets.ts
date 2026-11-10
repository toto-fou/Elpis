// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/secrets.ts — coffre « Secrets » : genres, portées, politique, vue publique (jamais de valeur), corps des routes du compte et de la console, secrets attachés à une conversation, résolution et recherche pour l'hôte d'outils. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";

export const GENRES_SECRET = ["web-login", "http-auth", "git", "llm", "mcp", "token"] as const;
export type GenreSecret = (typeof GENRES_SECRET)[number];
export const schemaGenreSecret = z.enum(GENRES_SECRET);

/** `unverified` : secret importé, inutilisable tant que son propriétaire ne l'a pas vérifié. */
export const ETATS_SECRET = ["active", "unverified"] as const;
export type EtatSecret = (typeof ETATS_SECRET)[number];

/** Usages que l'hôte d'outils peut faire résoudre (`POST /api/internal/secrets/resolve`). */
export const USAGES_RESOLUTION_SECRET = ["web-login", "http-auth"] as const;
export type UsageResolutionSecret = (typeof USAGES_RESOLUTION_SECRET)[number];

/** Genres qu'une conversation attache (`/secret attach`) : ceux des outils du navigateur. */
export const GENRES_ATTACHABLES = USAGES_RESOLUTION_SECRET;
/** Secrets attachés à une conversation, au plus. */
export const SECRETS_ATTACHES_MAX = 10;

/** Nom d'un secret : slug strict, unique par propriétaire (compte, ou instance). */
export const RE_NOM_SECRET = /^[a-z0-9][a-z0-9._-]{0,47}$/u;
export const ORIGINES_SECRET_MAX = 10;
export const VALEUR_SECRET_MAX = 16_384;
export const SECRETS_PAR_PROPRIETAIRE_MAX = 200;

/** Codes d'erreur du coffre (réponses `{detail, code}`, messages en anglais) ; ceux du navigateur viennent avec la session sécurisée. */
export const CODES_ERREUR_SECRET = [
  "secret_request_invalid",
  "secret_name_invalid",
  "secret_name_taken",
  "secret_scope_invalid",
  "secret_value_required",
  "secret_value_invalid",
  "secret_meta_invalid",
  "secret_limit",
  "secret_unknown",
  "secret_type_mismatch",
  "secret_unverified",
  "secret_scope_mismatch",
  "secret_not_attached",
  "secret_ambiguous",
  "secret_undecryptable",
  "secret_key_unavailable",
] as const;
export type CodeErreurSecret = (typeof CODES_ERREUR_SECRET)[number];

/** web-login, http-auth : origines exactes `scheme://host[:port]`. */
export const schemaPorteeOrigines = z.strictObject({
  origins: z.array(z.string().max(2048)).min(1).max(ORIGINES_SECRET_MAX),
});
/** git : hôte, port facultatif. */
export const schemaPorteeHote = z.strictObject({ host: z.string().min(1).max(300) });
/** llm : connecteur. */
export const schemaPorteeConnecteur = z.strictObject({ connector_id: entier.positive() });
/** mcp : serveur. */
export const schemaPorteeServeur = z.strictObject({ server: z.string().min(1).max(128) });
/** token : aucune portée. */
export const schemaPorteeVide = z.strictObject({});
export const schemaPorteeSecret = z.union([
  schemaPorteeOrigines,
  schemaPorteeHote,
  schemaPorteeConnecteur,
  schemaPorteeServeur,
  schemaPorteeVide,
]);
export type PorteeSecret = z.infer<typeof schemaPorteeSecret>;

export const schemaPolitiqueSecret = z.strictObject({
  subagents: z.boolean(),
  routines: z.boolean(),
  confirm_first_use: z.boolean(),
  tls: z.enum(["strict", "insecure"]),
});
export type PolitiqueSecret = z.infer<typeof schemaPolitiqueSecret>;
export const POLITIQUE_SECRET_DEFAUT: PolitiqueSecret = {
  subagents: true,
  routines: false,
  confirm_first_use: false,
  tls: "strict",
};

/** Métadonnées d'un secret : jamais sa valeur ni son chiffré ; `key_current` : chiffré par la clé courante. */
export const schemaSecret = z.object({
  id: entier,
  name: z.string(),
  kind: schemaGenreSecret,
  owner: z.enum(["user", "instance"]),
  scope: schemaPorteeSecret,
  username: z.string().nullable(),
  state: z.enum(ETATS_SECRET),
  version: entier,
  policy: schemaPolitiqueSecret,
  meta: dictionnaire,
  key_current: z.boolean(),
  use_count: entier,
  last_used_at: horodatage.nullable(),
  created_at: horodatage,
  updated_at: horodatage,
  rotated_at: horodatage.nullable(),
});
export type Secret = z.infer<typeof schemaSecret>;
export const schemaReponseSecrets = z.object({ secrets: z.array(schemaSecret) });
export const schemaReponseSecret = z.object({ secret: schemaSecret });

const nom = z.string().max(64);
const identifiant = z.string().max(256).nullable();
const valeur = z.string().max(VALEUR_SECRET_MAX);
const champsCreation = {
  name: nom,
  username: identifiant.optional(),
  value: valeur,
  policy: schemaPolitiqueSecret.partial().optional(),
  meta: dictionnaire.optional(),
};

/** Création : la portée suit le genre ; politique partielle complétée par les défauts. */
export const schemaCorpsCreationSecret = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("web-login"), scope: schemaPorteeOrigines, ...champsCreation }),
  z.strictObject({ kind: z.literal("http-auth"), scope: schemaPorteeOrigines, ...champsCreation }),
  z.strictObject({ kind: z.literal("git"), scope: schemaPorteeHote, ...champsCreation }),
  z.strictObject({ kind: z.literal("llm"), scope: schemaPorteeConnecteur, ...champsCreation }),
  z.strictObject({ kind: z.literal("mcp"), scope: schemaPorteeServeur, ...champsCreation }),
  z.strictObject({ kind: z.literal("token"), scope: schemaPorteeVide.optional(), ...champsCreation }),
]);
export type CorpsCreationSecret = z.infer<typeof schemaCorpsCreationSecret>;

/** Modification : champ absent = inchangé ; `value` vide = inchangée ; le genre ne change pas. Élargir la portée ou passer en `tls: insecure` exige une nouvelle valeur. */
export const schemaCorpsMajSecret = z.strictObject({
  name: nom.optional(),
  scope: schemaPorteeSecret.optional(),
  username: identifiant.optional(),
  value: valeur.optional(),
  policy: schemaPolitiqueSecret.partial().optional(),
  meta: dictionnaire.optional(),
});
export type CorpsMajSecret = z.infer<typeof schemaCorpsMajSecret>;

/** Rotation : nouvelle valeur, `version` + 1. */
export const schemaCorpsRotationSecret = z.strictObject({ value: valeur });

/** Résolution par l'hôte d'outils (compte de l'enveloppe signée) : par nom, sinon par origine. */
export const schemaCorpsResolutionSecret = z.strictObject({
  usage: z.enum(USAGES_RESOLUTION_SECRET),
  name: nom.nullable().optional(),
  origin: z.string().min(1).max(2048),
  chat_id: z.string().max(200).nullable().optional(),
  run: z.string().max(200).nullable().optional(),
});
export type CorpsResolutionSecret = z.infer<typeof schemaCorpsResolutionSecret>;
export const schemaReponseResolutionSecret = z.object({
  name: z.string(),
  username: z.string().nullable(),
  secret: z.string(),
  tls: z.enum(["strict", "insecure"]),
  version: entier,
});
export type ReponseResolutionSecret = z.infer<typeof schemaReponseResolutionSecret>;

/** Ids des secrets attachés à une conversation : `secrets` du corps d'un tour (remplace l'ensemble, ids invalides écartés) et `PUT /api/chats/:chat_id/secrets`. */
export const schemaIdsSecretsAttaches = z.array(entier.positive()).max(SECRETS_ATTACHES_MAX);
/** Remplacement de l'ensemble attaché : secrets du compte, `web-login` ou `http-auth`, vérifiés ; `[]` détache tout. */
export const schemaCorpsSecretsChat = z.strictObject({ ids: schemaIdsSecretsAttaches });
export type CorpsSecretsChat = z.infer<typeof schemaCorpsSecretsChat>;
/** Secrets attachés à la conversation, dans l'ordre d'attachement : métadonnées seules. */
export const schemaReponseSecretsChat = z.object({ secrets: z.array(schemaSecret) });
export type ReponseSecretsChat = z.infer<typeof schemaReponseSecretsChat>;

/** Secrets applicables à une origine pour la conversation de l'enveloppe signée (sans valeur) : `pw_session` ouvre une session sécurisée s'il y en a un. */
export const schemaCorpsSecretsApplicables = z.strictObject({
  origin: z.string().min(1).max(2048),
  name: nom.nullable().optional(),
});
export const schemaSecretApplicable = z.object({
  name: z.string(),
  kind: z.enum(GENRES_ATTACHABLES),
  username: z.string().nullable(),
  tls: z.enum(["strict", "insecure"]),
});
export type SecretApplicable = z.infer<typeof schemaSecretApplicable>;
export const schemaReponseSecretsApplicables = z.object({ secrets: z.array(schemaSecretApplicable) });
