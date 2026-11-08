// SPDX-License-Identifier: MIT
/** packages/auth/src/ip-client.ts — IP réelle du client : X-Forwarded-For cru seulement depuis un mandataire de confiance, lu de droite à gauche (`ipDuClient`) ; port de `_resolve_client_ip` gardé pour les vecteurs. */
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

/** `_resolve_client_ip` (première entrée de X-Forwarded-For, non vérifiée) : port tenu par les vecteurs Python ; l'app lit `ipDuClient`. */
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

/** Requête lue par `ipDuClient` : adresse résolue par Fastify (`trustProxy`), socket, en-têtes. */
export interface RequeteIp {
  readonly ip: string;
  readonly socket?: { readonly remoteAddress?: string | undefined } | null;
  readonly headers: Entetes;
}

const ADRESSE_MAX = 64;

/** Adresse IP valide d'au plus 64 caractères (IPv4 transposée ramenée), null sinon. */
function adresseValide(brut: string | null | undefined): string | null {
  const s = brut ?? "";
  const ip = s.startsWith("::ffff:") && s.includes(".") ? s.slice(7) : s;
  return ip.length <= ADRESSE_MAX && adresseIpOuNul(ip) !== null ? ip : null;
}

let mandatairesMemorises: readonly Reseau[] | null = null;
const mandatairesParDefaut = (): readonly Reseau[] => (mandatairesMemorises ??= mandatairesDuJournal());

/** IP du client (journaux, débit de connexion) : `req.ip` validée, sinon la socket ; depuis un mandataire de `reseaux`, X-Forwarded-For lu de droite à gauche jusqu'à la première adresse hors mandataires, arrêt à une entrée invalide ; sans `reseaux`, ceux de `mandatairesDuJournal()` lus une fois. */
export function ipDuClient(req: RequeteIp, reseaux: readonly Reseau[] = mandatairesParDefaut()): string {
  const pair = adresseValide(req.ip) ?? adresseValide(req.socket?.remoteAddress) ?? "?";
  if (!estMandataireDeConfiance(pair, reseaux)) return pair;
  const brut = req.headers["x-forwarded-for"];
  const liste = (Array.isArray(brut) ? brut.join(",") : (brut ?? "")).split(",");
  let ip = pair;
  for (let i = liste.length - 1; i >= 0; i--) {
    const entree = (liste[i] as string).trim();
    if (!entree) continue;
    const candidat = adresseValide(entree);
    if (candidat === null) break;
    ip = candidat;
    if (!estMandataireDeConfiance(candidat, reseaux)) break;
  }
  return ip;
}
