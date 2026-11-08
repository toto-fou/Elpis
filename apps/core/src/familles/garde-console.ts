// SPDX-License-Identifier: MIT
/** apps/core/src/familles/garde-console.ts — garde des GET de la console qui écrivent une trace : ni inter-site, ni sans l'en-tête de la console. */
import { estInterSite } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { FastifyRequest } from "fastify";

/** En-tête que la console pose sur ses lectures tracées. */
export const ENTETE_CONSOLE = "x-elpis-console";

/** Refuse (403), avant tout travail et toute trace, une lecture venue d'un autre site ou sans l'en-tête que seule la console pose (une navigation de premier niveau ne peut pas le porter). */
export function exigerLectureConsole(req: FastifyRequest): void {
  if (estInterSite(req.headers)) throw new HttpError(403, "Lecture refusée : requête venue d'un autre site.");
  if (req.headers[ENTETE_CONSOLE] !== "1")
    throw new HttpError(403, "Lecture refusée : requête sans l'en-tête de la console.");
}
