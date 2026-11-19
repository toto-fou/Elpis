// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/admin-identite.ts — console › connexion d'entreprise : réglages `auth`, fournisseurs d'identité (LDAP, OIDC), secret et activation. */
import { z } from "zod";

import { entier } from "./commun";

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

const champsCommuns = {
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  preset: z.string(),
  ca_pem: z.string(),
  required_groups: z.array(z.string()),
  roles,
  group_map: carteGroupes,
  freshness_days: entier,
};
const champsLdap = {
  urls: z.array(z.string()),
  bind_dn: z.string(),
  user_base_dn: z.string(),
  user_filter: z.string(),
  attrs: z.object({ id: z.string(), username: z.string(), email: z.string(), name: z.string() }),
  groups: z.object({ mode: z.enum(["memberof", "chain", "member"]) }),
  max_failures: entier,
  failure_window_sec: entier,
  timeout_sec: entier,
};
const champsOidc = {
  issuer: z.string(),
  client_id: z.string(),
  client_auth: z.enum(["basic", "post"]),
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

export const schemaFournisseurAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ldap"), ...champsCommuns, ...champsLdap, ...etatFournisseur }),
  z.object({ type: z.literal("oidc"), ...champsCommuns, ...champsOidc, ...etatFournisseur }),
]);
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
    ca_pem_max: entier,
    required_groups_max: entier,
    ldap_urls_max: entier,
    secret_max: entier,
    freshness_days: z.object({ min: entier, max: entier, default: entier }),
    max_failures: z.object({ min: entier, max: entier, default: entier }),
    failure_window_sec: z.object({ min: entier, max: entier, default: entier }),
    timeout_sec: z.object({ min: entier, max: entier, default: entier }),
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
/** Modification : les champs à changer (les objets imbriqués sont fusionnés clé à clé, les listes remplacées) ; `id`, `type` et `enabled` ne se modifient pas. */
export const schemaCorpsMajFournisseur = z.record(z.string(), z.unknown());
/** Secret du fournisseur : texte vide pour le supprimer. */
export const schemaCorpsSecretFournisseur = z.object({ secret: z.string() });

/** Test d'un fournisseur : ses réglages tels que le formulaire les contient, enregistrés ou non, plus pour un annuaire `test_user` (identifiant de l'utilisateur d'essai, cherché sans jamais être lié) et `secret` (secret du compte de service pour ce test seul, jamais enregistré), tous deux facultatifs. */
export const schemaCorpsEssaiFournisseur = z
  .record(z.string(), z.unknown())
  .refine((o) => ["test_user", "secret"].every((k) => o[k] === undefined || typeof o[k] === "string"), {
    message: "test_user et secret : texte attendu",
  });
/** Étapes ordonnées du test ; `target` est `hôte:port` quand l'étape vise une adresse ; `complete` n'est vrai que pour un annuaire dont toutes les étapes, utilisateur d'essai compris, sont passées (les clés OIDC ne sont pas encore essayées). */
export const schemaReponseEssaiFournisseur = z.object({
  ok: z.boolean(),
  complete: z.boolean(),
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
