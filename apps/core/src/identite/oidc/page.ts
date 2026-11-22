// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/page.ts — page de retour sans script (rafraîchissement immédiat et lien), ses en-têtes, le cookie de liaison et l'adresse de la console calculée depuis la configuration. */
import { httpsPorts } from "@elpis/config";
import type { FastifyRequest } from "fastify";

import { decouperHotePort } from "../../interface/urls-publiques";
import { COOKIE_LIAISON, DUREE_FLUX_S } from "./flux";
import type { CibleFlux } from "./flux";

export const HOTE_NON_CANONIQUE = "Utilisez l'adresse publique du service.";

/** Vrai si le nom d'hôte de la requête n'est pas celui de l'adresse publique réglée. */
export function hoteNonCanonique(req: FastifyRequest, publicUrl: string): boolean {
  return decouperHotePort((req.host ?? "").toLowerCase())[0] !== new URL(publicUrl).hostname.toLowerCase();
}

/** Politique de la page : aucune ressource, aucun script, aucun cadre ; le rafraîchissement par `meta` n'est pas régi par elle. */
export const ENTETES_RETOUR = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
} as const;

const ENTITES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

const echapper = (t: string): string => t.replace(/[&<>"']/gu, (c) => ENTITES[c] ?? c);

/** Page HTML minimale qui mène à `cible` : `meta refresh` immédiat et lien, aucun script. */
export function pageRetour(cible: string, texte = "Continuer"): string {
  const c = echapper(cible);
  return `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${c}"><title>Connexion</title></head><body><p><a href="${c}">${echapper(texte)}</a></p></body></html>\n`;
}

/** Page sans suite : le texte seul, sans lien. */
export function pageSimple(texte: string): string {
  return `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connexion</title></head><body><p>${echapper(texte)}</p></body></html>\n`;
}

/** Cookie de liaison du navigateur au flux : `__Host-`, HttpOnly, Secure, SameSite=Lax, dix minutes. */
export function enteteLiaison(secret: string): string {
  return `${COOKIE_LIAISON}=${secret}; Path=/; Max-Age=${DUREE_FLUX_S}; HttpOnly; Secure; SameSite=Lax`;
}

/** Adresse de la console : l'hôte de `auth.public_url` et le port HTTPS de la console réglé, jamais l'hôte de la requête. */
export function adresseConsole(publicUrl: string): string {
  const u = new URL(publicUrl);
  const port = httpsPorts().admin;
  return `https://${u.hostname}${port === 443 ? "" : `:${port}`}/admin`;
}

/** Adresse où mène une connexion réussie : la page d'accueil (avec la suite OAuth éventuelle) ou la console. */
export function cibleDeRetour(publicUrl: string, cible: CibleFlux, oauthNext: string | null): string {
  if (cible === "console") return adresseConsole(publicUrl);
  return oauthNext === null ? "/" : `/?oauth_next=${encodeURIComponent(oauthNext)}`;
}
