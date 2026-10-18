// SPDX-License-Identifier: MIT
/** packages/http/src/app.ts — fabrique du serveur Fastify d'un process : socle HTTP comme uvicorn et Starlette, puis familles de routes montées selon le mode. */
import { STATUS_CODES } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger, FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";

import { installerLecteurCorps } from "./corps";
import { installerCors } from "./cors";
import { ENTETES_SECURITE, installerEntetesSecurite } from "./entetes";
import { installerGestionErreurs } from "./gestion-erreurs";
import type { Introuvable } from "./gestion-erreurs";
import { journal as journalDomaine } from "./journal";
import type { Journal } from "./journal";
import { installerMultipart } from "./multipart";
import { serialiserReponse } from "./reponses";
import { estRouteWs, monterFamilles } from "./routes";
import type { Famille, Gardes, RouteMontee, VerificationRoute } from "./routes";
import { installerRouteurStarlette } from "./routeur-starlette";
import { urlCommeUvicorn } from "./url";

declare module "fastify" {
  interface FastifyInstance {
    elpis: { mode: string; routes: readonly RouteMontee[] };
  }
}

/** Installée après le socle HTTP et avant les routes (authentification, flux…). */
export type Extension = (app: FastifyInstance) => void | Promise<void>;

export interface OptionsAppHttp<M extends string = string, A extends string = string> {
  mode: M;
  familles?: readonly Famille<M, A>[];
  /** Familles montées faute de `familles`, calculées après les extensions. */
  famillesParDefaut?: () => readonly Famille<M, A>[];
  gardes?: Gardes<A>;
  verifierRoute?: VerificationRoute<M, A>;
  extensions?: readonly Extension[];
  limiteCorps?: number;
  journal?: Journal;
  arretEnCours?: () => boolean;
  corsOrigines?: readonly string[];
  /** Extensions posées avant le montage des routes (session et CSRF de @elpis/auth). */
  avantRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /** Gestionnaire global d'un chemin sans route, paramètre de chemin vide compris (défaut : routeur Starlette). */
  introuvable?: Introuvable;
}

const LIMITE_CORPS_DEFAUT = 100 * 1024 * 1024;
const TAILLE_MAX_MESSAGE_WS = 16 * 1024 * 1024;

/** Node refuse une tête de requête de plus de 16 Ko (431) ; uvicorn ne borne pas un segment, le routeur non plus en deçà. */
const LONGUEUR_PARAMETRE_MAX = 16 * 1024;

/** Comme gunicorn (`forwarded_allow_ips`) : seuls les en-têtes X-Forwarded-* venus de la boucle locale (Caddy) comptent. */
export const MANDATAIRES_DE_CONFIANCE = ["127.0.0.1", "::1"];

/** Pas de ligne par requête (le journal d'accès est ailleurs), mais les erreurs de flux et d'écriture restent journalisées. */
class ControleurJournal extends LogController {
  override incomingRequest(): void {}
  override requestCompleted(): void {}
  override routeNotFound(): void {}
}

/** URL mal encodée ou erreur de routage : réponse au format `{"detail"}`, en-têtes de sécurité compris (404 comme Starlette). */
function erreurDeRoutage(erreur: FastifyError, _requete: FastifyRequest, reponse: FastifyReply): void {
  const statut = erreur.code === "FST_ERR_BAD_URL" ? 404 : (erreur.statusCode ?? 400);
  void reponse
    .headers(Object.fromEntries(ENTETES_SECURITE))
    .code(statut)
    .send({ detail: statut === 404 ? "Not Found" : erreur.message });
}

/** Réponses de Fastify gardées : uvicorn n'a ni délai de réception (408) ni plafond de tête de requête (431). */
const ERREURS_CLIENT_FASTIFY: Readonly<Record<string, readonly [number, string]>> = {
  ERR_HTTP_REQUEST_TIMEOUT: [408, '{"error":"Request Timeout","message":"Client Timeout","statusCode":408}'],
  HPE_HEADER_OVERFLOW: [
    431,
    '{"error":"Request Header Fields Too Large","message":"Exceeded maximum allowed HTTP header size","statusCode":431}',
  ],
};

/** Requête illisible (octet non ASCII, espace ou DEL dans la cible…) : le 400 en texte d'uvicorn. */
function requeteIllisible(erreur: Error & { code?: string }, socket: Socket): void {
  if (erreur.code === "ECONNRESET" || socket.destroyed) return;
  const fastify = ERREURS_CLIENT_FASTIFY[erreur.code ?? ""];
  const [statut, type, corps]: readonly [number, string, string] = fastify
    ? [fastify[0], "application/json", fastify[1]]
    : [400, "text/plain; charset=utf-8", "Invalid HTTP request received."];
  if (socket.writable) {
    const tete = `HTTP/1.1 ${statut} ${STATUS_CODES[statut] ?? ""}\r\ncontent-type: ${type}\r\n`;
    socket.write(`${tete}content-length: ${Buffer.byteLength(corps)}\r\nconnection: close\r\n\r\n${corps}`);
  }
  socket.destroy(erreur);
}

/** Comme uvicorn : seul un upgrade `websocket` bascule, tout autre (h2c…) est servi en HTTP ordinaire. */
function upgradeWebSocket(requete: IncomingMessage): boolean {
  return String(requete.headers.upgrade ?? "").toLowerCase() === "websocket";
}

/** Erreur de protocole d'un client (trame trop grande, UTF-8 invalide…) en DEBUG sans pile, comme uvicorn ; toute autre erreur reste en ERROR. */
function erreurWebSocket(erreur: Error, socket: WebSocket, requete: FastifyRequest): void {
  const code = (erreur as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("WS_ERR_")) {
    requete.log.debug(`WebSocket ${requete.routeOptions.url ?? ""} fermée : ${erreur.message}`);
  } else {
    requete.log.error(erreur);
  }
  socket.terminate();
}

/** WebSocket comme uvicorn : messages de 16 Mio au plus, compression négociée, aucun sous-protocole ; un upgrade vers une route sans WebSocket est refusé (403). */
async function installerWebSocket(app: FastifyInstance): Promise<void> {
  await app.register(websocket, {
    options: { maxPayload: TAILLE_MAX_MESSAGE_WS, perMessageDeflate: true, handleProtocols: () => false },
    errorHandler: erreurWebSocket,
  });
  app.addHook("preHandler", async (requete, reponse) => {
    if (requete.ws && !estRouteWs(requete)) return reponse.code(403).send();
  });
}

/** HEAD comme uvicorn : en-têtes de la réponse, longueur du corps comprise, jamais le corps, y compris sous `app.inject`. */
function installerHeadSansCorps(app: FastifyInstance): void {
  app.addHook("onSend", async (requete, reponse, charge) => {
    if (requete.method !== "HEAD") return charge;
    if (charge === null || charge === undefined) {
      const s = reponse.statusCode;
      if (s >= 200 && s !== 204 && s !== 304 && !reponse.hasHeader("content-length"))
        void reponse.header("content-length", "0");
      return charge;
    }
    if (typeof charge === "string" || Buffer.isBuffer(charge)) {
      if (!reponse.hasHeader("content-length"))
        void reponse.header("content-length", String(Buffer.byteLength(charge)));
    } else if (typeof (charge as { destroy?: unknown }).destroy === "function") {
      (charge as { destroy: () => void }).destroy();
    }
    return null;
  });
}

/** Connexions gardées 120 s comme Gunicorn ; `requestTimeout` à 0 : pas de délai de réception imposé aux corps lents. */
export async function creerAppHttp<M extends string, A extends string>(
  options: OptionsAppHttp<M, A>,
): Promise<FastifyInstance> {
  const journal = options.journal ?? journalDomaine("http");
  const loggerInstance: FastifyBaseLogger = journal;
  const arretEnCours = options.arretEnCours ?? (() => false);
  const app: FastifyInstance = Fastify({
    loggerInstance,
    logController: new ControleurJournal(),
    bodyLimit: options.limiteCorps ?? LIMITE_CORPS_DEFAUT,
    keepAliveTimeout: 120_000,
    requestTimeout: 0,
    connectionTimeout: 0,
    return503OnClosing: false,
    exposeHeadRoutes: false,
    trustProxy: MANDATAIRES_DE_CONFIANCE,
    routerOptions: { maxParamLength: LONGUEUR_PARAMETRE_MAX },
    rewriteUrl: (requete) => urlCommeUvicorn(requete.url ?? "/"),
    frameworkErrors: erreurDeRoutage,
    clientErrorHandler: requeteIllisible,
    http: { shouldUpgradeCallback: upgradeWebSocket },
  });
  app.setReplySerializer(serialiserReponse);
  installerEntetesSecurite(app);
  app.addHook("onSend", async (_requete, reponse, charge) => {
    if (arretEnCours()) void reponse.header("connection", "close");
    return charge;
  });
  installerHeadSansCorps(app);
  installerGestionErreurs(app, journal, options.introuvable);
  installerLecteurCorps(app);
  await installerMultipart(app, options.limiteCorps ?? LIMITE_CORPS_DEFAUT);
  await installerWebSocket(app);
  const entreeCors = installerCors(
    app,
    options.corsOrigines ?? [],
    options.journal ?? journalDomaine("startup"),
  );
  for (const installer of options.extensions ?? []) await installer(app);
  entreeCors();
  await options.avantRoutes?.(app);
  installerRouteurStarlette(app);
  const familles = options.familles ?? options.famillesParDefaut?.() ?? [];
  const routes = monterFamilles(
    app,
    options.mode,
    familles,
    options.gardes ?? ({} as Gardes<A>),
    options.verifierRoute,
  );
  app.decorate("elpis", { mode: options.mode, routes });
  await app.ready();
  return app;
}
