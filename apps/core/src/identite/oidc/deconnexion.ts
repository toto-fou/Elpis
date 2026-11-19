// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/deconnexion.ts — déconnexion côté fournisseur OIDC : adresse de fin de session construite sans appel sortant, et jeton de déconnexion par canal arrière vérifié (signature, émetteur, public, événement) puis appliqué aux seules sessions de ce fournisseur. */
import { buildEndSessionUrl, Configuration } from "openid-client";
import type { JWK } from "openid-client";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

import { revoquerSid } from "@elpis/auth";
import type { Base, Executeur } from "@elpis/db";
import { dechiffrerSecret } from "@elpis/securite";

import { fournisseursActifs } from "../fournisseurs";
import { lireReglagesAuth } from "../reglages";
import type { FournisseurOidc } from "../reglages";
import type { FabriqueConfigurations } from "./configuration";
import { RefusOidc } from "./refus";

export const EVENEMENT_DECONNEXION = "http://schemas.openid.net/event/backchannel-logout";
export const CORPS_DECONNEXION_MAX = 16 * 1024;
export const APPELS_PAR_MINUTE = 60;
const AGE_MAX_S = 600;
const CHAMP_MAX = 255;
const JTI_MAX = 2000;

export interface JetonDeconnexion {
  readonly sid: string | null;
  readonly sub: string | null;
  readonly jti: string | null;
  readonly iat: number;
}

function texteBorne(v: unknown): string | null | undefined {
  if (v === undefined) return null;
  return typeof v === "string" && v !== "" && v.length <= CHAMP_MAX && v.isWellFormed() ? v : undefined;
}

/** Raison d'un refus de jeton, d'une liste fermée : jamais un message de la bibliothèque ni une valeur du jeton. */
function raisonJose(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const claim = (e as { claim?: unknown } | null)?.claim;
  if (code === "ERR_JWT_EXPIRED") return "expired";
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return "bad_signature";
  if (code === "ERR_JOSE_ALG_NOT_ALLOWED") return "bad_alg";
  if (code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS") return "no_key";
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    if (claim === "iss") return "bad_issuer";
    if (claim === "aud") return "bad_audience";
    return claim === "nbf" ? "not_yet_valid" : "bad_claim";
  }
  return "invalid";
}

/** Jeton de déconnexion vérifié : signature avec l'algorithme et les clés réglés du fournisseur, émetteur, public, validité, événement, absence de `nonce`, `sid` ou `sub` présent. */
export async function verifierJetonDeconnexion(
  fabrique: FabriqueConfigurations,
  f: FournisseurOidc,
  publicUrl: string,
  jeton: string,
  t: number,
): Promise<JetonDeconnexion> {
  const refus = (raison: string): RefusOidc => new RefusOidc("failed", raison);
  if (jeton === "" || jeton.length > CORPS_DECONNEXION_MAX) throw refus("malformed");
  let entete: { alg?: unknown; kid?: unknown };
  try {
    entete = decodeProtectedHeader(jeton);
  } catch {
    throw refus("malformed");
  }
  if (entete.alg !== f.id_token_alg) throw refus("bad_alg");
  const kid = typeof entete.kid === "string" ? entete.kid : undefined;
  const cles: JWK[] = await fabrique.clesDeSignature(f, publicUrl, kid);
  let payload: Record<string, unknown>;
  try {
    const verifie = await jwtVerify(jeton, createLocalJWKSet({ keys: cles as never }), {
      algorithms: [f.id_token_alg],
      issuer: f.issuer,
      audience: f.client_id,
      clockTolerance: f.clock_skew_sec,
      currentDate: new Date(t * 1000),
    });
    payload = verifie.payload as Record<string, unknown>;
  } catch (e) {
    throw refus(raisonJose(e));
  }
  const iat = payload["iat"];
  if (typeof iat !== "number" || !Number.isFinite(iat)) throw refus("iat_missing");
  if (iat - t > f.clock_skew_sec || t - iat > AGE_MAX_S) throw refus("iat_invalid");
  const evenements = payload["events"];
  if (
    evenements === null ||
    typeof evenements !== "object" ||
    Array.isArray(evenements) ||
    !Object.hasOwn(evenements, EVENEMENT_DECONNEXION)
  )
    throw refus("no_event");
  if (Object.hasOwn(payload, "nonce")) throw refus("nonce_present");
  const sid = texteBorne(payload["sid"]);
  const sub = texteBorne(payload["sub"]);
  const jti = texteBorne(payload["jti"]);
  if (sid === undefined || sub === undefined || jti === undefined) throw refus("bad_claim");
  if (sid === null && sub === null) throw refus("no_subject");
  return { sid, sub, jti, iat };
}

/** Plafond d'appels par fournisseur et par minute pour ce process (fenêtre fixe, en mémoire). */
export class PlafondAppels {
  private readonly fenetres = new Map<string, { debut: number; n: number }>();

  /** Compte un appel ; faux au-delà du plafond de la minute. */
  prendre(id: string, t: number): boolean {
    const w = this.fenetres.get(id);
    if (w === undefined || t - w.debut >= 60) {
      this.fenetres.set(id, { debut: t, n: 1 });
      return true;
    }
    w.n += 1;
    return w.n <= APPELS_PAR_MINUTE;
  }
}

/** Jetons de déconnexion déjà appliqués (`jti`) : un rejeu dans leur durée de validité est reçu sans effet. */
export class JetonsVus {
  private readonly vus = new Map<string, number>();

  /** Vrai si ce `jti` du fournisseur a déjà été appliqué ; sinon le note jusqu'à `expire`. */
  dejaVu(id: string, jti: string, expire: number, t: number): boolean {
    for (const [cle, fin] of this.vus) if (fin < t) this.vus.delete(cle);
    const cle = `${id}\u0000${jti}`;
    if (this.vus.has(cle)) return true;
    if (this.vus.size >= JTI_MAX) this.vus.delete(this.vus.keys().next().value as string);
    this.vus.set(cle, expire);
    return false;
  }
}

type LigneSession = { sid: string; user_id: number; expires_at: number };

/** Sessions de CE fournisseur visées par le jeton : par `sid` (et `sub` s'il est donné), sinon par `sub` seul, rangé avec la session. */
async function sessionsVisees(
  x: Executeur,
  f: FournisseurOidc,
  j: JetonDeconnexion,
): Promise<LigneSession[]> {
  if (j.sid !== null) {
    if (j.sub !== null)
      return x.all<LigneSession>(
        "SELECT sid, user_id, expires_at FROM auth_ext_sessions WHERE provider_id=? AND idp_sid=? AND subject=?",
        [f.id, j.sid, j.sub],
      );
    return x.all<LigneSession>(
      "SELECT sid, user_id, expires_at FROM auth_ext_sessions WHERE provider_id=? AND idp_sid=?",
      [f.id, j.sid],
    );
  }
  if (j.sub === null) return [];
  return x.all<LigneSession>(
    "SELECT sid, user_id, expires_at FROM auth_ext_sessions WHERE provider_id=? AND subject=?",
    [f.id, j.sub],
  );
}

export interface BilanDeconnexion {
  readonly sessions: number;
  readonly comptes: readonly number[];
}

/** Révoque les sessions de ce fournisseur visées par le jeton et supprime leurs lignes ; rend leur nombre et les comptes touchés. */
export async function appliquerDeconnexion(
  base: Base,
  f: FournisseurOidc,
  j: JetonDeconnexion,
  t: number,
): Promise<BilanDeconnexion> {
  const lignes = await base.ecriture(async (x) => {
    const visees = await sessionsVisees(x, f, j);
    for (const l of visees) {
      await revoquerSid(x, l.sid, Number(l.user_id), t, Number(l.expires_at));
      await x.run("DELETE FROM auth_ext_sessions WHERE sid=?", [l.sid]);
    }
    return visees;
  });
  return { sessions: lignes.length, comptes: [...new Set(lignes.map((l) => Number(l.user_id)))] };
}

export interface DependancesFinDeSession {
  readonly base: Base;
  readonly configurations: FabriqueConfigurations;
  readonly cookieSecure: () => boolean;
}

/** Ligne de session du fournisseur supprimée ; adresse de fin de session chez lui si le fournisseur est actif, la demande et la découverte gardée l'annonce (sans appel sortant), sinon `null`. */
export async function adresseDeFinDeSession(
  dep: DependancesFinDeSession,
  sid: string,
): Promise<string | null> {
  const ligne = await dep.base.ecriture(async (x) => {
    const l = await x.get<{ provider_id: string; id_token_enc: string | null }>(
      "SELECT provider_id, id_token_enc FROM auth_ext_sessions WHERE sid=?",
      [sid],
    );
    if (l !== undefined) await x.run("DELETE FROM auth_ext_sessions WHERE sid=?", [sid]);
    return l;
  });
  if (ligne === undefined) return null;
  const f = (await fournisseursActifs(dep.base, dep.cookieSecure)).find((p) => p.id === ligne.provider_id);
  if (f === undefined || f.type !== "oidc" || !f.logout.rp_initiated) return null;
  const publicUrl = lireReglagesAuth().public_url;
  const metadonnees = dep.configurations.metadonneesGardees(f, publicUrl);
  if (metadonnees?.end_session_endpoint === undefined) return null;
  const parametres: Record<string, string> = {
    post_logout_redirect_uri: `${publicUrl}/`,
    client_id: f.client_id,
  };
  if (ligne.id_token_enc !== null) {
    try {
      parametres["id_token_hint"] = dechiffrerSecret(ligne.id_token_enc, `auth-ext-session:${sid}`);
    } catch {
      // jeton illisible : l'adresse part sans indice
    }
  }
  const url = buildEndSessionUrl(new Configuration(metadonnees, f.client_id), parametres);
  return url.protocol === "https:" && url.origin === new URL(f.issuer).origin ? url.href : null;
}
