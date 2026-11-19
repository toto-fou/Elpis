// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/flux.ts — flux de connexion SSO en base : création plafonnée, consommation à usage unique, lien au navigateur, sessions du fournisseur, purge. */
import { createHash } from "node:crypto";

import { cleAdresse } from "@elpis/auth";
import type { Base, Executeur } from "@elpis/db";
import { chiffrerSecret, compareDigest } from "@elpis/securite";

export const DUREE_FLUX_S = 600;
export const FLUX_PAR_ADRESSE_MAX = 20;
export const FLUX_PAR_FOURNISSEUR_MAX = 5000;
export const COOKIE_LIAISON = "__Host-elpis-sso";

const FORME_SECRET = /^[A-Za-z0-9_-]{43}$/u;

export type CibleFlux = "app" | "console";

export interface FluxCree {
  readonly providerId: string;
  readonly secretLiaison: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly cible: CibleFlux;
  readonly oauthNext: string | null;
  readonly essaiAdmin: number | null;
  readonly adresse: string;
  /** Empreinte des réglages qui lancent un essai (rangée dans `profile_json`) ; `null` hors essai. */
  readonly empreinteReglages?: string | null;
}

export interface FluxLu {
  readonly providerId: string;
  readonly browserHash: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly cible: CibleFlux;
  readonly oauthNext: string | null;
  readonly essaiAdmin: number | null;
  readonly etape: string;
  readonly expiresAt: number;
  /** Empreinte des réglages au départ d'un essai ; `null` hors essai. */
  readonly empreinteReglages: string | null;
}

export const empreinte = (texte: string): string => createHash("sha256").update(texte, "utf8").digest("hex");

/** Secret de liaison lu du cookie : seule la forme exacte d'un secret émis par ce serveur est admise. */
export function secretLiaisonValide(brut: string | undefined): string | null {
  return brut !== undefined && FORME_SECRET.test(brut) ? brut : null;
}

/** Vrai si les deux empreintes hexadécimales sont égales (temps constant). */
export function memeEmpreinte(a: string, b: string): boolean {
  return a.length === b.length && compareDigest(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Flux créé sous l'écriture exclusive de la base, dans les plafonds par adresse (IPv6 au /64) et par fournisseur (essais d'administrateur exclus) ; faux si un plafond est atteint. */
export async function creerFlux(base: Base, f: FluxCree, maintenant: number): Promise<boolean> {
  return base.ecriture(async (x) => {
    if (f.essaiAdmin === null) {
      const total = await x.valeurs<[number]>(
        "SELECT COUNT(*) FROM auth_flows WHERE provider_id=? AND trial_admin IS NULL AND expires_at>?",
        [f.providerId, maintenant],
      );
      if (Number(total[0]?.[0] ?? 0) >= FLUX_PAR_FOURNISSEUR_MAX) return false;
    }
    const ip = empreinte(cleAdresse(f.adresse));
    const adresse = await x.valeurs<[number]>(
      "SELECT COUNT(*) FROM auth_flows WHERE ip_hash=? AND expires_at>?",
      [ip, maintenant],
    );
    if (Number(adresse[0]?.[0] ?? 0) >= FLUX_PAR_ADRESSE_MAX) return false;
    await x.run(
      "INSERT INTO auth_flows(state_hash, provider_id, browser_hash, ip_hash, nonce, code_verifier, target, oauth_next, trial_admin, stage, profile_json, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        empreinte(f.state),
        f.providerId,
        empreinte(f.secretLiaison),
        ip,
        f.nonce,
        f.codeVerifier,
        f.cible,
        f.oauthNext,
        f.essaiAdmin,
        "auth",
        f.empreinteReglages === undefined || f.empreinteReglages === null
          ? null
          : JSON.stringify({ settings: f.empreinteReglages }),
        maintenant,
        maintenant + DUREE_FLUX_S,
      ],
    );
    return true;
  });
}

type LigneFlux = {
  provider_id: string;
  browser_hash: string;
  nonce: string;
  code_verifier: string;
  target: string;
  oauth_next: string | null;
  trial_admin: number | null;
  stage: string;
  profile_json: string | null;
  expires_at: number;
};

/** Empreinte des réglages rangée dans le flux d'un essai ; `null` si absente ou illisible. */
function empreinteDuFlux(json: string | null): string | null {
  if (json === null) return null;
  try {
    const v = (JSON.parse(json) as { settings?: unknown } | null)?.settings;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Flux retrouvé par l'empreinte du `state` et supprimé dans la même écriture (usage unique) ; `null` s'il est inconnu. */
export async function consommerFlux(base: Base, state: string): Promise<FluxLu | null> {
  const cle = empreinte(state);
  const l = await base.ecriture(async (x) => {
    const ligne = await x.get<LigneFlux>(
      "SELECT provider_id, browser_hash, nonce, code_verifier, target, oauth_next, trial_admin, stage, profile_json, expires_at FROM auth_flows WHERE state_hash=?",
      [cle],
    );
    if (ligne !== undefined) await x.run("DELETE FROM auth_flows WHERE state_hash=?", [cle]);
    return ligne;
  });
  if (l === undefined) return null;
  return {
    providerId: l.provider_id,
    browserHash: l.browser_hash,
    nonce: l.nonce,
    codeVerifier: l.code_verifier,
    cible: l.target === "console" ? "console" : "app",
    oauthNext: l.oauth_next,
    essaiAdmin: l.trial_admin === null ? null : Number(l.trial_admin),
    etape: l.stage,
    expiresAt: Number(l.expires_at),
    empreinteReglages: empreinteDuFlux(l.profile_json),
  };
}

/** Ligne de session du fournisseur écrite à l'ouverture de la session (`subject` : le `sub` du jeton) ; le jeton d'identité est chiffré par le coffre, ou laissé nul s'il n'y a pas de clé. */
export async function noterSessionExterne(
  x: Executeur,
  e: {
    sid: string;
    uid: number;
    providerId: string;
    idpSid: string | null;
    subject: string;
    idToken: string | null;
    maintenant: number;
    expire: number;
    avertir?: (message: string) => void;
  },
): Promise<void> {
  let enc: string | null = null;
  if (e.idToken !== null) {
    try {
      enc = chiffrerSecret(e.idToken, `auth-ext-session:${e.sid}`);
    } catch {
      e.avertir?.(`connexion SSO ${e.providerId} : jeton d'identité non gardé (clé du coffre indisponible)`);
    }
  }
  await x.run(
    "INSERT INTO auth_ext_sessions(sid, user_id, provider_id, idp_sid, subject, id_token_enc, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)",
    [e.sid, e.uid, e.providerId, e.idpSid, e.subject, enc, e.maintenant, e.expire],
  );
}

/** Lignes périmées des deux tables supprimées ; rend leur nombre. */
export async function purgerFluxPerimes(x: Executeur, maintenant: number): Promise<number> {
  const a = await x.run("DELETE FROM auth_flows WHERE expires_at<?", [maintenant]);
  const b = await x.run("DELETE FROM auth_ext_sessions WHERE expires_at<?", [maintenant]);
  return a.changes + b.changes;
}

/** Flux, sessions du fournisseur et résultat d'essai d'un fournisseur éteint ou supprimé. */
export async function effacerEtatOidc(x: Executeur, providerId: string): Promise<void> {
  await x.run("DELETE FROM auth_flows WHERE provider_id=?", [providerId]);
  await x.run("DELETE FROM auth_ext_sessions WHERE provider_id=?", [providerId]);
  await x.run("DELETE FROM auth_trials WHERE provider_id=?", [providerId]);
}
