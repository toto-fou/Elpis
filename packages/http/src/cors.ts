// SPDX-License-Identifier: MIT
/** packages/http/src/cors.ts — CORS optionnel (`app.cors_origins`) : le CORSMiddleware de Starlette 1.0 réglé comme server/app.py (crédits, toutes méthodes, tous en-têtes). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { PREPARATIONS_FLUX } from "./entetes";
import type { PreparationFlux } from "./entetes";
import { erreursInattendues } from "./gestion-erreurs";
import type { Journal } from "./journal";

/** `ALL_METHODS` de Starlette (`allow_methods=["*"]`). */
const METHODES = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

/** `MutableHeaders.add_vary_header` : ajouté au premier Vary, qui remplace tous les autres, sans dédoublonner. */
function ajouterVary(reponse: FastifyReply, valeur: string): void {
  const avant = reponse.getHeader("vary");
  const premier = Array.isArray(avant) ? avant[0] : avant;
  void reponse.header("vary", premier === undefined ? valeur : `${String(premier)}, ${valeur}`);
}

/** `Headers.get` de Starlette : première occurrence de l'en-tête (Node joint les doublons). */
function entete(requete: FastifyRequest, nom: string): string | undefined {
  const bruts = requete.raw.rawHeaders;
  for (let i = 0; i + 1 < bruts.length; i += 2) if (bruts[i]?.toLowerCase() === nom) return bruts[i + 1];
  return undefined;
}

/** `preflight_response` : origine explicite (crédits), en-têtes demandés renvoyés, réseau privé refusé. */
function preflight(
  requete: FastifyRequest,
  reponse: FastifyReply,
  admise: boolean,
  origine: string,
  demandee: string,
): FastifyReply {
  const entetes: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": METHODES.join(", "),
    "access-control-max-age": "600",
    "access-control-allow-credentials": "true",
  };
  const echecs: string[] = [];
  if (admise) entetes["access-control-allow-origin"] = origine;
  else echecs.push("origin");
  if (!METHODES.includes(demandee)) echecs.push("method");
  const demandes = entete(requete, "access-control-request-headers");
  if (demandes !== undefined) entetes["access-control-allow-headers"] = demandes;
  if (entete(requete, "access-control-request-private-network") !== undefined) echecs.push("private-network");
  return reponse
    .code(echecs.length > 0 ? 400 : 200)
    .headers(entetes)
    .type("text/plain; charset=utf-8")
    .send(echecs.length > 0 ? `Disallowed CORS ${echecs.join(", ")}` : "OK");
}

/** Route hors CORS : relais, hors du middleware en Python. */
function horsCors(requete: FastifyRequest): boolean {
  return (requete.routeOptions.config as { horsCors?: boolean } | undefined)?.horsCors === true;
}

/** Liste vide : pas de CORS (le journal le dit). Sinon, pose les réponses et rend l'entrée du middleware, à poser après les extensions (maintenance, CSRF, session restent au-dessus comme en Python). */
export function installerCors(
  app: FastifyInstance,
  origines: readonly string[],
  journal: Journal,
): () => void {
  if (origines.length === 0) {
    journal.info(
      "CORS désactivé (app.cors_origins absent ou vide dans config.json). Les requêtes cross-origin seront bloquées par le navigateur.",
    );
    return () => undefined;
  }
  const admise = (o: string): boolean => origines.includes("*") || origines.includes(o);
  const atteintes = new WeakMap<FastifyRequest, string>();

  /** `CORSMiddleware.send` : crédits, origine admise renvoyée telle quelle ; jamais sur un 500 (ServerErrorMiddleware est au-dessus). */
  const simple: PreparationFlux = (requete, reponse) => {
    const origine = atteintes.get(requete);
    if (origine === undefined || erreursInattendues.has(requete)) return;
    atteintes.delete(requete);
    void reponse.header("access-control-allow-credentials", "true");
    if (admise(origine)) {
      void reponse.header("access-control-allow-origin", origine);
      ajouterVary(reponse, "Origin");
    }
  };
  app.addHook("onSend", async (requete, reponse, charge) => {
    simple(requete, reponse);
    return charge;
  });
  if (!app.hasDecorator(PREPARATIONS_FLUX)) app.decorate(PREPARATIONS_FLUX, [] as PreparationFlux[]);
  app.getDecorator<PreparationFlux[]>(PREPARATIONS_FLUX).push(simple);
  journal.info(`CORS activé pour ${origines.length} origine(s) : ${origines.join(", ")}`);

  return () => {
    app.addHook("onRequest", async (requete, reponse) => {
      const origine = entete(requete, "origin");
      const websocket = String(requete.headers.upgrade ?? "").toLowerCase() === "websocket";
      if (origine === undefined || websocket || horsCors(requete)) return undefined;
      const demandee = entete(requete, "access-control-request-method");
      if (requete.method === "OPTIONS" && demandee !== undefined)
        return preflight(requete, reponse, admise(origine), origine, demandee);
      atteintes.set(requete, origine);
      return undefined;
    });
  };
}
