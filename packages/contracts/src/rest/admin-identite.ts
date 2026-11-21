// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-identite.ts — console › SSO OpenID Connect : réglages `auth`, fournisseurs d'identité (OIDC), secret et activation. */
import { z } from "zod";

import { entier } from "./commun";

/** Identifiant d'un fournisseur : minuscules, chiffres et tirets, 31 caractères au plus, sans tiret en tête. */
export const REGEX_ID_FOURNISSEUR = /^[a-z0-9][a-z0-9-]{0,30}$/u;

/** Niveaux `acr` à un seul facteur : ils n'invitent jamais à un second facteur. */
export const ACR_FAIBLES: ReadonlySet<string> = new Set(["0", "1"]);

/** Méthodes `amr` qui attestent à elles seules plusieurs facteurs. */
export const AMR_MULTI_FACTEUR: ReadonlySet<string> = new Set(["mfa", "mca"]);

/** Famille de chaque méthode `amr` de la RFC 8176 (connaissance, possession, inhérence). */
export const FAMILLES_AMR: ReadonlyMap<string, string> = new Map([
  ...["pwd", "pin", "kba"].map((m): [string, string] => [m, "connaissance"]),
  ...["otp", "hwk", "swk", "sms", "tel", "sc"].map((m): [string, string] => [m, "possession"]),
  ...["face", "fpt", "iris", "retina", "vbm"].map((m): [string, string] => [m, "inherence"]),
]);

/** Vrai si les exigences invitent le fournisseur à un second facteur : `amr` `mfa`, `mca` ou de possession ou d'inhérence, ou `acr` autre que 0 ou 1. */
export function secondFacteurDemande(acr: readonly string[], amr: readonly string[]): boolean {
  const fort = (m: string): boolean => {
    const f = FAMILLES_AMR.get(m);
    return AMR_MULTI_FACTEUR.has(m) || (f !== undefined && f !== "connaissance");
  };
  return amr.some((m) => fort(m.trim().toLowerCase())) || acr.some((a) => !ACR_FAIBLES.has(a.trim()));
}

/** Vrai si tout jeton admis à la connexion prouve un second facteur (une seule valeur listée suffit à entrer) : chaque `acr` exigé est autre que 0 ou 1, ou chaque `amr` exigé est `mfa` ou `mca`. */
export function secondFacteurPourTous(acr: readonly string[], amr: readonly string[]): boolean {
  return (
    (acr.length > 0 && acr.every((a) => !ACR_FAIBLES.has(a.trim()))) ||
    (amr.length > 0 && amr.every((m) => AMR_MULTI_FACTEUR.has(m.trim().toLowerCase())))
  );
}

const modeLocal = z.enum(["all", "admins"]);
const roles = z.object({
  enabled: z.boolean(),
  admin_groups: z.array(z.string()),
  moderator_groups: z.array(z.string()),
});
const carteGroupes = z.object({
  enabled: z.boolean(),
  map: z.array(z.object({ external: z.string(), group_id: entier })),
});

const champsFournisseur = {
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  ca_pem: z.string(),
  required_groups: z.array(z.string()),
  roles,
  group_map: carteGroupes,
  freshness_days: entier,
  issuer: z.string(),
  client_id: z.string(),
  client_auth: z.enum(["basic", "post"]),
  id_token_alg: z
    .enum(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"])
    .default("RS256"),
  scopes: z.array(z.string()),
  subject_claim: z.string(),
  username_claim: z.string(),
  email_claim: z.string(),
  name_claim: z.string(),
  groups_claim: z.string(),
  required_acr: z.array(z.string()),
  required_amr: z.array(z.string()),
  max_age_sec: entier,
  clock_skew_sec: entier,
  session_max_age_sec: entier,
  logout: z.object({ rp_initiated: z.boolean(), backchannel: z.boolean() }),
};
/** État d'un fournisseur ajouté à ses réglages : secret rangé et lisible pour l'adresse courante, test réussi sur les réglages courants, actif, identités rattachées. */
const etatFournisseur = {
  has_secret: z.boolean(),
  tested: z.boolean(),
  active: z.boolean(),
  identities: entier,
};

export const schemaFournisseurAuth = z.object({
  type: z.literal("oidc"),
  ...champsFournisseur,
  ...etatFournisseur,
});
export type FournisseurAuth = z.infer<typeof schemaFournisseurAuth>;

export const schemaReglagesAuth = z.object({
  public_url: z.string(),
  local: z.object({ mode: modeLocal }),
  providers: z.array(schemaFournisseurAuth),
  /** Fournisseurs écrits à la main dans config.json qui ne se lisent pas : jamais actifs, à supprimer. */
  invalid_providers: z.array(
    z.object({ id: z.string().nullable(), label: z.string().nullable(), enabled: z.boolean() }),
  ),
  prerequisites: z.object({
    public_url_https: z.boolean(),
    /** Attribut Secure du cookie de session réellement en vigueur dans ce processus. */
    cookie_secure: z.boolean(),
    /** Administrateurs actifs à mot de passe local. */
    local_admins: entier,
  }),
  bounds: z.object({
    providers_max: entier,
    label_max: entier,
    required_groups_max: entier,
    secret_max: entier,
    freshness_days: z.object({ min: entier, max: entier, default: entier }),
    clock_skew_sec: z.object({ min: entier, max: entier, default: entier }),
  }),
});
export type ReglagesAuthConsole = z.infer<typeof schemaReglagesAuth>;

export const schemaCorpsReglagesAuth = z.object({
  public_url: z.string().optional(),
  local: z.object({ mode: modeLocal }).optional(),
});

/** Création : `type`, `id`, `label` et les champs sans valeur par défaut ; le fournisseur est toujours créé éteint. */
export const schemaCorpsCreationFournisseur = z.record(z.string(), z.unknown());
/** Modification : les champs à changer (les objets imbriqués sont fusionnés clé à clé, les listes remplacées) ; `id`, `type` et `enabled` ne se modifient pas ; `confirm_admin_mapping: true` (booléen, jamais enregistré) confirme qu'un groupe du fournisseur donne le rôle d'administrateur. */
export const schemaCorpsMajFournisseur = z.record(z.string(), z.unknown());
/** Secret du fournisseur : texte vide pour le supprimer. */
export const schemaCorpsSecretFournisseur = z.object({ secret: z.string() });

/** Test d'un fournisseur : ses réglages tels que le formulaire les contient, enregistrés ou non. */
export const schemaCorpsEssaiFournisseur = z.record(z.string(), z.unknown());
/** Étapes ordonnées du test ; `target` est `hôte:port` quand l'étape vise une adresse . */
export const schemaReponseEssaiFournisseur = z.object({
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
});
export type ReponseEssaiFournisseur = z.infer<typeof schemaReponseEssaiFournisseur>;
