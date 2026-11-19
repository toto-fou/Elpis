// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/metadonnees.ts — document de découverte d'un fournisseur OIDC vérifié point par point : émetteur exact, points d'accès en https sur l'origine de l'émetteur, seules les clés utiles gardées. */
import type { ServerMetadata } from "openid-client";

/** Points visités par le serveur, exigés sur la même origine que l'émetteur (le point d'autorisation, visité par le navigateur, doit seulement être en https). */
const POINTS_SERVEUR = ["token_endpoint", "jwks_uri"] as const;
const POINTS_SERVEUR_FACULTATIFS = ["userinfo_endpoint", "pushed_authorization_request_endpoint"] as const;

export type VerdictMetadonnees =
  | { readonly ok: true; readonly metadonnees: ServerMetadata }
  | { readonly ok: false; readonly raison: string };

const echec = (raison: string): VerdictMetadonnees => ({ ok: false, raison });

function adresseHttps(v: unknown): URL | null {
  if (typeof v !== "string" || v.length > 2048 || !URL.canParse(v)) return null;
  const u = new URL(v);
  return u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "" ? u : null;
}

function listeTextes(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/** Métadonnées retenues d'un document de découverte (texte pour l'administrateur en cas de refus). */
export function lireMetadonnees(doc: unknown, issuer: string): VerdictMetadonnees {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return echec("La réponse n'est pas un objet JSON.");
  const d = doc as Record<string, unknown>;
  const lire = (nom: string): unknown => (Object.hasOwn(d, nom) ? d[nom] : undefined);
  if (lire("issuer") !== issuer)
    return echec("L'émetteur annoncé par le serveur ne correspond pas exactement à celui configuré.");
  const origine = new URL(issuer).origin;
  if (adresseHttps(lire("authorization_endpoint")) === null)
    return echec("Le champ authorization_endpoint est absent ou n'est pas une adresse https.");
  const m: Record<string, unknown> = { issuer, authorization_endpoint: lire("authorization_endpoint") };
  for (const nom of POINTS_SERVEUR) {
    const u = adresseHttps(lire(nom));
    if (u === null) return echec(`Le champ ${nom} est absent ou n'est pas une adresse https.`);
    if (u.origin !== origine)
      return echec(
        `Le champ ${nom} n'est pas sur la même origine que l'émetteur : le fournisseur est mal configuré.`,
      );
    m[nom] = lire(nom);
  }
  for (const nom of POINTS_SERVEUR_FACULTATIFS) {
    const v = lire(nom);
    if (v === undefined) continue;
    const u = adresseHttps(v);
    if (u === null) return echec(`Le champ ${nom} n'est pas une adresse https.`);
    if (u.origin !== origine)
      return echec(
        `Le champ ${nom} n'est pas sur la même origine que l'émetteur : le fournisseur est mal configuré.`,
      );
    m[nom] = v;
  }
  const fin = adresseHttps(lire("end_session_endpoint"));
  if (fin !== null && fin.origin === origine && fin.hash === "")
    m["end_session_endpoint"] = lire("end_session_endpoint");
  if (typeof lire("backchannel_logout_supported") === "boolean")
    m["backchannel_logout_supported"] = lire("backchannel_logout_supported");
  for (const nom of [
    "id_token_signing_alg_values_supported",
    "token_endpoint_auth_methods_supported",
    "code_challenge_methods_supported",
    "scopes_supported",
  ]) {
    const l = listeTextes(lire(nom));
    if (l !== undefined) m[nom] = l;
  }
  if (typeof lire("authorization_response_iss_parameter_supported") === "boolean")
    m["authorization_response_iss_parameter_supported"] = lire(
      "authorization_response_iss_parameter_supported",
    );
  return { ok: true, metadonnees: m as unknown as ServerMetadata };
}

/** Adresse du document de découverte d'un émetteur. */
export function adresseDecouverte(issuer: string): string {
  return `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
}
