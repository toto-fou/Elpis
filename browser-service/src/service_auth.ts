// SPDX-License-Identifier: MIT
// browser-service/src/service_auth.ts — jeton d'appel du service (BROWSER_SERVICE_TOKEN, posé par l'hôte d'outils) : Bearer exigé sur chaque appel.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { RequestHandler } from "express";

/** Refus 401 d'un appel sans le jeton attendu. */
export interface RefusAppel {
  statut: number;
  error: string;
  code: string;
}

function egal(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** null si l'appel porte le jeton attendu, sinon le refus 401 à rendre. */
export function refusAppel(req: { headers?: IncomingHttpHeaders }, attendu: string): RefusAppel | null {
  const auth = String(req.headers?.authorization || "");
  const presente = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (attendu && presente && egal(presente, attendu)) return null;
  return {
    statut: 401,
    error: "Unauthorized: missing or invalid browser service token",
    code: "unauthorized",
  };
}

/** Middleware Express du jeton `attendu`, à poser avant toute route, statiques comprises. */
export function gardeJeton(attendu: string): RequestHandler {
  return (req, res, next) => {
    const refus = refusAppel(req, attendu);
    if (!refus) return next();
    const { statut, ...corps } = refus;
    return res.status(statut).json(corps);
  };
}
