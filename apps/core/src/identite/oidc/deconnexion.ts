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
export const REFUS_PAR_MINUTE = 20;
const ADRESSES_MAX = 5000;
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
    if (claim === "exp") return "bad_exp";
    return claim === "nbf" ? "not_yet_valid" : "bad_claim";
  }
  return "invalid";
}

/** Jeton de déconnexion vérifié (avec `sansReseau`, sur les seules clés déjà gardées en mémoire) : signature avec l'algorithme et les clés réglés du fournisseur, émetteur, public, validité, événement, absence de `nonce`, `sid` ou `sub` présent. */
export async function verifierJetonDeconnexion(
  fabrique: FabriqueConfigurations,
  f: FournisseurOidc,
  publicUrl: string,
  jeton: string,
  t: number,
  sansReseau = false,
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
  const cles: JWK[] | null = sansReseau
    ? fabrique.clesEnMemoire(f, publicUrl)
    : await fabrique.clesDeSignature(f, publicUrl, kid);
  if (cles === null) throw refus("no_key");
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
  const aud = payload["aud"];
  if (Array.isArray(aud) && aud.some((x) => x !== f.client_id)) throw refus("bad_audience");
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
  if (jti === null) throw refus("jti_missing");
  if (sid === null && sub === null) throw refus("no_subject");
  return { sid, sub, jti, iat };
}

/** Refus par adresse source et par minute pour ce process (fenêtre fixe, en mémoire, bornée) : seuls les refus comptent, un jeton valide n'est jamais compté. */
export class RefusParAdresse {
  private readonly fenetres = new Map<string, { debut: number; n: number }>();

  /** Vrai si cette adresse a déjà atteint le plafond de refus de la minute. */
  saturee(cle: string, t: number): boolean {
    const w = this.fenetres.get(cle);
    return w !== undefined && t - w.debut < 60 && w.n >= REFUS_PAR_MINUTE;
  }

  /** Note un refus de cette adresse. */
  noter(cle: string, t: number): void {
    const w = this.fenetres.get(cle);
    if (w !== undefined && t - w.debut < 60) {
      w.n += 1;
      return;
    }
    if (this.fenetres.size >= ADRESSES_MAX) {
      for (const [k, v] of this.fenetres) if (t - v.debut >= 60) this.fenetres.delete(k);
      if (this.fenetres.size >= ADRESSES_MAX)
        this.fenetres.delete(this.fenetres.keys().next().value as string);
    }
    this.fenetres.set(cle, { debut: t, n: 1 });
  }
}

/** Ligne de journal d'un refus agrégée : une ligne par raison et par minute au plus, avec le nombre, écrite à la fin de la minute. */
export class RefusAgreges {
  private readonly raisons = new Map<string, number>();

  private readonly ecrire: (raison: string, n: number) => void;

  constructor(ecrire: (raison: string, n: number) => void) {
    this.ecrire = ecrire;
  }

  /** Compte un refus ; la ligne de sa raison part une minute plus tard. */
  noter(raison: string): void {
    const n = this.raisons.get(raison);
    if (n !== undefined) {
      this.raisons.set(raison, n + 1);
      return;
    }
    this.raisons.set(raison, 1);
    setTimeout(() => {
      const total = this.raisons.get(raison) ?? 0;
      this.raisons.delete(raison);
      this.ecrire(raison, total);
    }, 60_000).unref();
  }
}

/** Jetons de déconnexion déjà appliqués (`jti`) : un rejeu dans leur durée de validité est reçu sans effet. */
export class JetonsVus {
  private readonly vus = new Map<string, number>();

  /** Vrai si ce `jti` du fournisseur a déjà été appliqué. */
  dejaVu(id: string, jti: string, t: number): boolean {
    const fin = this.vus.get(`${id}\u0000${jti}`);
    return fin !== undefined && fin >= t;
  }

  /** Note ce `jti` comme appliqué jusqu'à `expire`. */
  noter(id: string, jti: string, expire: number, t: number): void {
    for (const [cle, fin] of this.vus) if (fin < t) this.vus.delete(cle);
    if (this.vus.size >= JTI_MAX) this.vus.delete(this.vus.keys().next().value as string);
    this.vus.set(`${id}\u0000${jti}`, expire);
  }
}

type LigneSession = { sid: string; user_id: number; expires_at: number };

/** Sessions de CE fournisseur visées par le jeton : par `sid` (et `sub` s'il est donné, avec les sessions de ce sujet sans `sid` rangé), sinon par `sub` seul. */
async function sessionsVisees(
  x: Executeur,
  f: FournisseurOidc,
  j: JetonDeconnexion,
): Promise<LigneSession[]> {
  if (j.sid !== null) {
    if (j.sub !== null)
      return x.all<LigneSession>(
        "SELECT sid, user_id, expires_at FROM auth_ext_sessions WHERE provider_id=? AND subject=? AND (idp_sid=? OR idp_sid IS NULL)",
        [f.id, j.sub, j.sid],
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

/** Flux `proof` en attente de ce sujet chez ce fournisseur supprimés : la personne recommence par le SSO. */
async function supprimerPreuvesDuSujet(x: Executeur, providerId: string, sub: string): Promise<void> {
  const flux = await x.all<{ state_hash: string; profile_json: string | null }>(
    "SELECT state_hash, profile_json FROM auth_flows WHERE provider_id=? AND stage='proof'",
    [providerId],
  );
  for (const l of flux) {
    let v: Partial<Record<"sub" | "subject", unknown>> = {};
    try {
      v = l.profile_json === null ? {} : ((JSON.parse(l.profile_json) as typeof v | null) ?? {});
    } catch {
      v = {};
    }
    if (v.sub === sub || v.subject === sub)
      await x.run("DELETE FROM auth_flows WHERE state_hash=?", [l.state_hash]);
  }
}

export interface BilanDeconnexion {
  readonly sessions: number;
  readonly comptes: readonly number[];
  readonly fermees: readonly { readonly sid: string; readonly uid: number }[];
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
    if (j.sub !== null) await supprimerPreuvesDuSujet(x, f.id, j.sub);
    return visees;
  });
  return {
    sessions: lignes.length,
    comptes: [...new Set(lignes.map((l) => Number(l.user_id)))],
    fermees: lignes.map((l) => ({ sid: l.sid, uid: Number(l.user_id) })),
  };
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
  if (f === undefined || !f.logout.rp_initiated) return null;
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
