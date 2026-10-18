// SPDX-License-Identifier: MIT
/** packages/http/src/requete.ts — lecture d'une requête comme Starlette : en-tête, premier en-tête d'un nom répété, paramètre de requête. */
import type { FastifyRequest } from "fastify";

import { analyserRequete } from "./url";

/** En-tête de ce nom ; le premier s'il arrive en tableau. */
export function entete(requete: FastifyRequest, nom: string): string | undefined {
  const v = requete.headers[nom];
  return Array.isArray(v) ? v[0] : v;
}

/** Premier en-tête de ce nom, comme `Headers.get` de Starlette (Node joint les doublons). */
export function premierEntete(requete: FastifyRequest, nom: string): string | undefined {
  const distincts = (requete.raw as { headersDistinct?: Record<string, string[] | undefined> })
    .headersDistinct;
  return distincts?.[nom]?.[0] ?? entete(requete, nom);
}

/** `request.query_params.get(nom)` : dernière valeur de la requête brute, `null` si absent. */
export function parametreRequete(requete: FastifyRequest, nom: string): string | null {
  const url = requete.originalUrl;
  const debut = url.indexOf("?");
  if (debut < 0) return null;
  const diese = url.indexOf("#", debut);
  const valeurs = analyserRequete(url.slice(debut + 1, diese < 0 ? undefined : diese)).filter(
    ([cle]) => cle === nom,
  );
  return valeurs.length > 0 ? (valeurs[valeurs.length - 1] as [string, string])[1] : null;
}
