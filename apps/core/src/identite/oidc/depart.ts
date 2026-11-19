// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/depart.ts — départ d'un flux SSO : `state`, `nonce` et PKCE S256 aléatoires, flux enregistré (plafonds), adresse d'autorisation construite (PAR si le fournisseur l'annonce). */
import {
  buildAuthorizationUrl,
  buildAuthorizationUrlWithPAR,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";

import type { Base } from "@elpis/db";

import type { FabriqueConfigurations } from "./configuration";
import { creerFlux, empreinte } from "./flux";
import type { CibleFlux } from "./flux";
import { RefusOidc } from "./refus";
import { empreinteFournisseur } from "../fournisseurs";
import type { FournisseurOidc } from "../reglages";

const OAUTH_NEXT_MAX = 2000;
const CARACTERES_INTERDITS = /[\p{Cc}\\\s]/u;

/** Adresse de retour enregistrée chez le fournisseur : l'origine publique réglée plus le chemin du retour. */
export function adresseCallback(publicUrl: string, id: string): string {
  return `${publicUrl}/api/auth/oidc/${id}/callback`;
}

/** Suite d'un flux d'autorisation OAuth d'Elpis : seulement `/oauth/authorize?…` (pas `//`), 2 000 caractères au plus ; sinon ignorée. */
export function oauthNextAdmis(brut: unknown): string | null {
  if (typeof brut !== "string" || brut.length > OAUTH_NEXT_MAX) return null;
  if (!brut.startsWith("/oauth/authorize?") || brut.startsWith("//") || CARACTERES_INTERDITS.test(brut))
    return null;
  return brut;
}

export interface DemandeDepart {
  readonly fournisseur: FournisseurOidc;
  readonly publicUrl: string;
  readonly cible: CibleFlux;
  readonly oauthNext: string | null;
  readonly essaiAdmin: number | null;
  readonly secretLiaison: string;
  readonly adresse: string;
}

/** Enregistre le flux puis rend l'adresse d'autorisation ; `plafond` si un plafond de flux est atteint, et le flux est retiré si la construction échoue. */
export async function preparerDepart(
  dep: { base: Base; configurations: FabriqueConfigurations; maintenant: () => number },
  d: DemandeDepart,
): Promise<{ url: string } | "plafond"> {
  const f = d.fournisseur;
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const ouverte = await dep.configurations.ouvrir(f, d.publicUrl);
  try {
    const cree = await creerFlux(
      dep.base,
      {
        providerId: f.id,
        secretLiaison: d.secretLiaison,
        state,
        nonce,
        codeVerifier,
        cible: d.cible,
        oauthNext: d.oauthNext,
        essaiAdmin: d.essaiAdmin,
        adresse: d.adresse,
        empreinteReglages: d.essaiAdmin === null ? null : empreinteFournisseur(f, d.publicUrl),
      },
      dep.maintenant(),
    );
    if (!cree) return "plafond";
    try {
      const parametres: Record<string, string> = {
        redirect_uri: adresseCallback(d.publicUrl, f.id),
        scope: f.scopes.join(" "),
        code_challenge: await calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce,
        ...(f.required_acr.length > 0 ? { acr_values: f.required_acr.join(" ") } : {}),
        ...(f.max_age_sec > 0 ? { max_age: String(f.max_age_sec) } : {}),
      };
      const url =
        ouverte.metadonnees.pushed_authorization_request_endpoint === undefined
          ? buildAuthorizationUrl(ouverte.config, parametres)
          : await buildAuthorizationUrlWithPAR(ouverte.config, parametres);
      return { url: url.href };
    } catch (e) {
      await dep.base.run("DELETE FROM auth_flows WHERE state_hash=?", [empreinte(state)]);
      if (e instanceof RefusOidc) throw e;
      throw new RefusOidc("unavailable", "authorization_url");
    }
  } finally {
    await ouverte.terminer();
  }
}
