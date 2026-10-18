// SPDX-License-Identifier: MIT
/** packages/http/src/entetes.ts — en-têtes de sécurité posés s'ils manquent, sur toutes les réponses, erreurs comprises. */
import type { OutgoingHttpHeaders } from "node:http";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const ENTETES_SECURITE: readonly (readonly [string, string])[] = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-frame-options", "SAMEORIGIN"],
  ["content-security-policy", "frame-ancestors 'self'"],
];

/** Point d'extension : préparations `onSend` des extensions (session, Vary…) rejouées avant une réponse en flux. */
export const PREPARATIONS_FLUX = "preparationsFlux";
export type PreparationFlux = (requete: FastifyRequest, reponse: FastifyReply) => void;

function completer(reponse: FastifyReply): void {
  for (const [nom, valeur] of ENTETES_SECURITE) {
    if (!reponse.hasHeader(nom)) void reponse.header(nom, valeur);
  }
}

/** En-têtes d'une réponse écrite à la main (`reply.hijack()` puis `reply.raw.writeHead`) : préparations, sécurité, tableaux gardés. */
export function entetesFlux(reponse: FastifyReply, propres: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  const app = reponse.server;
  if (app.hasDecorator(PREPARATIONS_FLUX)) {
    for (const preparer of app.getDecorator<PreparationFlux[]>(PREPARATIONS_FLUX))
      preparer(reponse.request, reponse);
  }
  completer(reponse);
  const entetes: OutgoingHttpHeaders = {};
  for (const [nom, valeur] of Object.entries(reponse.getHeaders())) {
    if (valeur !== undefined) entetes[nom] = valeur;
  }
  return { ...entetes, ...propres };
}

/** Posés dès `onRequest` (les réponses d'erreur gardent ces en-têtes) et revérifiés en `onSend`. */
export function installerEntetesSecurite(app: FastifyInstance): void {
  if (!app.hasDecorator(PREPARATIONS_FLUX)) app.decorate(PREPARATIONS_FLUX, [] as PreparationFlux[]);
  app.addHook("onRequest", async (_requete, reponse) => {
    completer(reponse);
  });
  app.addHook("onSend", async (_requete, reponse, charge) => {
    completer(reponse);
    return charge;
  });
}
