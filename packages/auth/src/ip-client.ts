// SPDX-License-Identifier: MIT
/** packages/auth/src/ip-client.ts — IP réelle du client (access_logging._resolve_client_ip) : X-Forwarded-For cru seulement depuis un mandataire de confiance. */
import { adresseIpOuNul, dansReseau, reseauPy, stripPy } from "@elpis/commun";
import type { Reseau } from "@elpis/commun";

import { entete } from "./csrf";
import type { Entetes } from "./csrf";

export type { Reseau };

export const MANDATAIRES_DU_JOURNAL_PAR_DEFAUT = "127.0.0.0/8,::1";

/** `_parse_trusted_proxies` : IP ou CIDR séparés par des virgules ; les entrées invalides sont ignorées. */
export function analyserMandataires(spec: string | null | undefined): Reseau[] {
  const reseaux: Reseau[] = [];
  for (const brut of (spec || "").split(",")) {
    const s = stripPy(brut);
    const r = s ? reseauPy(s) : null;
    if (r) reseaux.push(r);
  }
  return reseaux;
}

/** Réseaux de `ACCESS_LOG_TRUSTED_PROXIES` (défaut boucle locale), lus une fois au démarrage comme Python. */
export function mandatairesDuJournal(env: NodeJS.ProcessEnv = process.env): Reseau[] {
  return analyserMandataires(env["ACCESS_LOG_TRUSTED_PROXIES"] ?? MANDATAIRES_DU_JOURNAL_PAR_DEFAUT);
}

/** `_is_trusted_proxy` : même version d'IP exigée (`::ffff:127.0.0.1` n'est pas dans 127.0.0.0/8). */
export function estMandataireDeConfiance(
  hote: string | null | undefined,
  reseaux: readonly Reseau[],
): boolean {
  if (!hote || !reseaux.length) return false;
  const ip = adresseIpOuNul(hote);
  return ip !== null && reseaux.some((r) => dansReseau(ip, r));
}

/** `_resolve_client_ip` : pair = adresse vue par le serveur (après réécriture des mandataires) ; "?" à défaut. */
export function ipClient(
  pair: string | null | undefined,
  entetes: Entetes,
  reseaux: readonly Reseau[],
): string {
  if (pair && estMandataireDeConfiance(pair, reseaux)) {
    const premier = stripPy(entete(entetes, "x-forwarded-for").split(",")[0] ?? "");
    if (premier) return premier;
  }
  return pair || "?";
}

/** `request.client.host` sous uvicorn : adresse du pair (mandataires de confiance appliqués), IPv4 transposée ramenée. */
export function adressePair(requete: { readonly ip: string }): string {
  const ip = requete.ip || "";
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}
