// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/echange.ts — retour du fournisseur : code échangé, jeton d'identité vérifié (signature, émetteur, public, nonce, validité), revendications lues, `acr` et `amr` exigés ; ne crée ni compte ni session. */
import { authorizationCodeGrant, fetchUserInfo, ResponseBodyError } from "openid-client";

import type { ConfigurationOuverte } from "./configuration";
import type { FluxLu } from "./flux";
import { RefusOidc } from "./refus";
import {
  appartenanceDe,
  emailVerifieDe,
  groupeRequisSeulDe,
  groupesDe,
  identifiantFiable,
  lireRevendication,
  secondFacteurProuve,
  secondFacteurSatisfait,
  sujetDe,
  texteDe,
} from "./revendications";
import type { Revendications } from "./revendications";
import type { Appartenance, ProfilIdentite } from "../provisionnement";
import type { Fournisseur } from "../reglages";
import { ancreIdentite } from "../ancre";
import { ErreurSortant } from "../sortant";

const REQUETE_MAX = 4096;
const ERREUR_FOURNISSEUR = /^[a-z_]{1,40}$/u;
const SID_MAX = 255;

export interface RetourVerifie {
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
  /** Revendications du jeton d'identité d'où viennent le profil, `acr`, `amr` et groupes (liste blanche pour l'essai à blanc). */
  readonly vue: VueRevendications;
  /** Groupes du jeton en entier (la vue en garde 50) ; `null` quand ils ne se lisent pas. */
  readonly groupesComplets: readonly string[] | null;
  readonly idToken: string | null;
  /** Le jeton prouve un second facteur (condition pour devenir administrateur). */
  readonly secondFacteur: boolean;
  readonly idpSid: string | null;
  /** `sub` du jeton d'identité, rangé avec la session pour la déconnexion par canal arrière. */
  readonly sub: string;
}

export interface VueRevendications {
  readonly iss: string;
  readonly sujet: string;
  readonly identifiant: string;
  readonly nom: string;
  readonly email: string;
  readonly emailVerifie: boolean;
  readonly acr: string | null;
  readonly amr: string[];
  readonly groupes: string[] | null;
  readonly sujetEstIdentifiant: boolean;
}

function chaineDansCause(e: unknown): ErreurSortant | null {
  for (let c: unknown = e, i = 0; c instanceof Error && i < 6; c = c.cause, i++)
    if (c instanceof ErreurSortant) return c;
  return null;
}

/** Cause d'un échec de la bibliothèque, réduite à des codes que le serveur connaît : jamais un message ni un corps du fournisseur. */
function causeDe(e: unknown): string {
  const sortant = chaineDansCause(e);
  if (sortant !== null) return `sortant:${sortant.code}`;
  if (e instanceof ResponseBodyError)
    return `token_endpoint:${ERREUR_FOURNISSEUR.test(e.error) ? e.error : "autre"}`;
  const code = (e as { code?: unknown } | null)?.code;
  return `lib:${typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : ((e as Error | null)?.name ?? "inconnu")}`;
}

/** Vrai quand le point de jetons refuse l'authentification du client (`invalid_client`, ou 401 avec défi). */
function authentificationClientRefusee(e: unknown): boolean {
  if (e instanceof ResponseBodyError) return e.error === "invalid_client";
  return (e as { code?: unknown } | null)?.code === "OAUTH_WWW_AUTHENTICATE_CHALLENGE";
}

function refusDe(e: unknown): RefusOidc {
  if (e instanceof RefusOidc) return e;
  return new RefusOidc(chaineDansCause(e) === null ? "failed" : "unavailable", causeDe(e));
}

/** Adresse de retour reconstruite depuis `auth.public_url`, jamais depuis la requête ; seule la chaîne de requête reçue y est reprise. */
export function adresseDeRetour(publicUrl: string, id: string, requete: string): URL {
  return new URL(`${publicUrl}/api/auth/oidc/${id}/callback?${requete}`);
}

/** Chaîne de requête brute d'une URL de requête (sans le `?`), bornée. */
export function requeteBrute(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? "" : url.slice(i + 1, i + 1 + REQUETE_MAX + 1);
}

function liste(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
}

/** Échange le code du retour et rend le profil vérifié ; toute anomalie est un `RefusOidc` dont le code est d'une liste fermée. */
export async function verifierRetour(
  ouverte: ConfigurationOuverte,
  f: Fournisseur,
  e: { publicUrl: string; flux: FluxLu; state: string; requete: string; maintenant: number },
): Promise<RetourVerifie> {
  if (e.requete.length > REQUETE_MAX) throw new RefusOidc("failed", "query_too_long");
  const url = adresseDeRetour(e.publicUrl, f.id, e.requete);
  const erreur = url.searchParams.get("error");
  const iss = url.searchParams.getAll("iss");
  const annonce = ouverte.metadonnees["authorization_response_iss_parameter_supported"] === true;
  if (iss.length > 1 || (iss.length === 1 ? iss[0] !== f.issuer : annonce))
    throw new RefusOidc("failed", "iss_mismatch");
  if (erreur !== null)
    throw new RefusOidc("denied", `provider_error:${ERREUR_FOURNISSEUR.test(erreur) ? erreur : "autre"}`);
  if (url.searchParams.get("state") !== e.state) throw new RefusOidc("failed", "state_mismatch");
  const { config } = ouverte;
  let jetons: Awaited<ReturnType<typeof authorizationCodeGrant>>;
  try {
    jetons = await authorizationCodeGrant(config, url, {
      expectedState: e.state,
      expectedNonce: e.flux.nonce,
      pkceCodeVerifier: e.flux.codeVerifier,
      idTokenExpected: true,
      ...(f.max_age_sec > 0 ? { maxAge: f.max_age_sec } : {}),
    });
  } catch (err) {
    if (chaineDansCause(err) === null && authentificationClientRefusee(err))
      throw new RefusOidc("failed", "client_auth_rejected");
    throw refusDe(err);
  }
  const claims = jetons.claims();
  if (claims === undefined) throw new RefusOidc("failed", "id_token_missing");
  if (typeof claims.iat !== "number" || claims.iat > e.maintenant + f.clock_skew_sec)
    throw new RefusOidc("failed", "iat_in_future");
  if (claims.azp !== undefined && claims.azp !== f.client_id) throw new RefusOidc("failed", "azp_mismatch");
  if (Array.isArray(claims.aud) && claims.aud.some((a) => a !== f.client_id))
    throw new RefusOidc("failed", "aud_untrusted");
  const sujet = sujetDe(claims, f);
  if (sujet === null) throw new RefusOidc("failed", "subject_invalid");
  if (!secondFacteurSatisfait(claims, f)) throw new RefusOidc("mfa_required", "acr_amr");
  let groupes = groupesDe(claims, f);
  let requisSeul = groupeRequisSeulDe(claims, f);
  let complement: Revendications = {};
  if (
    (groupes === null || texteDe(claims, f.username_claim) === "") &&
    ouverte.metadonnees.userinfo_endpoint !== undefined
  ) {
    try {
      complement = await fetchUserInfo(config, jetons.access_token, claims.sub);
    } catch (err) {
      throw refusDe(err);
    }
    groupes ??= groupesDe(complement, f);
    requisSeul ??= groupeRequisSeulDe(complement, f);
  }
  const identifiant = texteDe(claims, f.username_claim) || texteDe(complement, f.username_claim);
  const sourceIdentifiant = texteDe(claims, f.username_claim) === "" ? complement : claims;
  const nom = texteDe(claims, f.name_claim) || texteDe(complement, f.name_claim);
  const email =
    emailVerifieDe(claims, f) ||
    (lireRevendication(claims, f.email_claim) === undefined ? emailVerifieDe(complement, f) : "");
  const sid = lireRevendication(claims, "sid");
  const acr = lireRevendication(claims, "acr");
  return {
    profil: {
      subject: sujet,
      issuer: ancreIdentite(f),
      extUsername: identifiant,
      identifiantFiable: identifiantFiable(sourceIdentifiant, f),
    },
    appartenance: groupes === null && requisSeul !== null ? "oui" : appartenanceDe(groupes, f),
    vue: {
      iss: f.issuer,
      sujet,
      identifiant,
      nom,
      email,
      emailVerifie: email !== "",
      acr: typeof acr === "string" ? acr.slice(0, 128) : null,
      amr: liste(lireRevendication(claims, "amr")),
      groupes: groupes === null ? (requisSeul === null ? null : [requisSeul]) : groupes.slice(0, 50),
      sujetEstIdentifiant: identifiant !== "" && identifiant === sujet,
    },
    groupesComplets: groupes,
    secondFacteur: secondFacteurProuve(claims, f),
    sub: claims.sub,
    idToken: jetons.id_token ?? null,
    idpSid: typeof sid === "string" && sid !== "" && sid.length <= SID_MAX && sid.isWellFormed() ? sid : null,
  };
}
