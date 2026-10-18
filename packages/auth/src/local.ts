// SPDX-License-Identifier: MIT
/** packages/auth/src/local.ts — requête de la machine elle-même, sans mandataire (local_request.py), et mandataires de confiance. */
import type { Entetes } from "./csrf";

const BOUCLE = new Set(["127.0.0.1", "::1", "localhost"]);
const RELAIS = ["x-forwarded-for", "x-real-ip", "forwarded", "via"];

/** `forwarded_allow_ips` par défaut d'uvicorn et gunicorn : seul le Caddy local réécrit l'adresse du client. */
export const MANDATAIRES_DE_CONFIANCE: readonly string[] = ["127.0.0.1", "::1"];

/** Pair = adresse de la socket (jamais l'adresse réécrite) ; un en-tête de relais suffit à refuser. */
export function estLocalDirect(pair: string | undefined, entetes: Entetes): boolean {
  const adresse = (pair ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, "");
  return BOUCLE.has(adresse) && !RELAIS.some((h) => entetes[h] !== undefined);
}
