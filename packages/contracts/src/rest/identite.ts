// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/identite.ts — connexion par SSO OpenID Connect : départ du flux (le retour du fournisseur est une navigation, pas un appel de l'interface). */
import { z } from "zod";

/** Départ : où mène la connexion réussie (`app` : l'application, `console` : la console) et, pour l'application, la suite d'un flux d'autorisation OAuth (`/oauth/authorize?…`, ignorée sinon). */
export const schemaCorpsDepartOidc = z.object({
  target: z.enum(["app", "console"]),
  oauth_next: z.string().optional(),
});
export type CorpsDepartOidc = z.infer<typeof schemaCorpsDepartOidc>;

/** Adresse d'autorisation chez le fournisseur : le navigateur s'y rend. */
export const schemaReponseDepartOidc = z.object({ url: z.string() });
export type ReponseDepartOidc = z.infer<typeof schemaReponseDepartOidc>;

/** Preuve du titulaire après un retour SSO : `pending` quand ce navigateur porte une demande en cours (`username` : le compte local visé) ; sinon `{ pending: false, username: null }`. */
export const schemaReponsePreuveLien = z.object({ pending: z.boolean(), username: z.string().nullable() });
export type ReponsePreuveLien = z.infer<typeof schemaReponsePreuveLien>;

/** Ancien mot de passe local du compte visé. */
export const schemaCorpsPreuveLien = z.object({ password: z.string().min(1).max(1024) });
export type CorpsPreuveLien = z.infer<typeof schemaCorpsPreuveLien>;

/** Preuve réussie : la session est ouverte, `next` est l'adresse où mène la connexion. */
export const schemaReponsePreuveLienReussie = z.object({ ok: z.literal(true), next: z.string() });
export type ReponsePreuveLienReussie = z.infer<typeof schemaReponsePreuveLienReussie>;

/** Réponse 409 quand l'hôte de la requête n'est pas celui de l'adresse publique réglée : l'interface s'y rend d'abord. */
export const schemaHoteNonCanonique = z.object({ detail: z.string(), canonical: z.string() });
export type HoteNonCanonique = z.infer<typeof schemaHoteNonCanonique>;

/** Codes d'un refus de connexion, dans `/?auth_error=<code>&ref=<référence>` (la référence retrouve la cause au journal du serveur). */
export const CODES_ERREUR_CONNEXION = [
  "denied",
  "expired",
  "not_in_group",
  "groups_unknown",
  "conflict",
  "suspended",
  "mfa_required",
  "unavailable",
  "failed",
] as const;
export const schemaCodeErreurConnexion = z.enum(CODES_ERREUR_CONNEXION);
export type CodeErreurConnexion = z.infer<typeof schemaCodeErreurConnexion>;

/** Méthode de connexion SSO proposée par la page de connexion. */
export const schemaMethodeConnexionSso = z.object({ id: z.string(), label: z.string() });
export type MethodeConnexionSso = z.infer<typeof schemaMethodeConnexionSso>;
