// SPDX-License-Identifier: MIT
/** apps/toolhost/src/porte.ts — porte d'entrée de l'hôte (toolhost/auth.py + portes MCP de local_mcp_server.py) : jeton de service, enveloppe d'identité, Origin et famille des chemins MCP. */
import { AsyncResource } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";

import { lowerPy, pyJsonDumps, stripPy } from "@elpis/commun";
import { cheminDecode, premierEntete } from "@elpis/http";
import { FAMILY_NAMES, originAllowed } from "@elpis/mcp";
import { avecIdentite, IDENTITY_HEADER, verify } from "@elpis/securite";
import type { Identity } from "@elpis/securite";
import type { FastifyInstance, FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Identité vérifiée de l'enveloppe (`request.state.toolhost_identity`), `null` hors de l'API gardée. */
    identite: Identity | null;
  }
}

export const OPEN_PATHS: readonly string[] = ["/health"];
export const HTTP_MOUNT_PATH = "/mcp";
export const SSE_MOUNT_PATH = "/sse";
/** `SSE_PREFIXES` : flux et POST des messages du transport SSE. */
export const SSE_PREFIXES: readonly string[] = ["/sse", "/messages"];
export const MCP_PREFIXES: readonly string[] = [HTTP_MOUNT_PATH, ...SSE_PREFIXES];
export const MESSAGE_SANS_JETON = "hôte d'outils sans jeton de service : API sandbox fermée";

export interface ReglagesPorte {
  readonly jeton: string;
  readonly decalageMaxS: number;
}

/** `bearer_matches` : `Bearer <jeton>` (casse du schéma libre, blancs retirés) comparé à temps constant ; texte non ASCII d'un côté ou de l'autre : jamais égal (Python : 500). */
export function bearerMatches(autorisation: string | undefined, jeton: string): boolean {
  if (!jeton || !estAscii(jeton)) return false;
  const auth = stripPy(autorisation ?? "");
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  const recuTexte = stripPy(auth.slice(7));
  if (!estAscii(recuTexte)) return false;
  const recu = Buffer.from(recuTexte, "latin1");
  const attendu = Buffer.from(jeton, "latin1");
  return recu.length === attendu.length && timingSafeEqual(recu, attendu);
}

export function estAscii(texte: string): boolean {
  return [...texte].every((c) => c.charCodeAt(0) < 0x80);
}

/** Réponse de refus comme `_reject` : `json.dumps` (UTF-8 brut), `WWW-Authenticate: Bearer` sur un 401. */
function rejeter(reponse: FastifyReply, statut: number, detail: string): FastifyReply {
  if (statut === 401) void reponse.header("www-authenticate", "Bearer");
  return reponse
    .code(statut)
    .type("application/json; charset=utf-8")
    .send(pyJsonDumps({ detail }, { ensureAscii: false }));
}

/** 403 `{"error"}` (McpGateASGI) ou 404 `{"error"}` (FamilyScopeASGI), écrits comme `json.dumps`. */
function refusMcp(reponse: FastifyReply, statut: number, erreur: string): FastifyReply {
  return reponse
    .code(statut)
    .type("application/json; charset=utf-8")
    .send(pyJsonDumps({ error: erreur }, { ensureAscii: false }));
}

/** Ce que le montage `/` du service MCP répond à un chemin sans route : 404 en texte. */
export function introuvable(reponse: FastifyReply): FastifyReply {
  return reponse.code(404).type("text/plain; charset=utf-8").send("Not Found");
}

/** Segment de famille après `/mcp/` ou `/sse/` (barres retirées, minuscules) ; `undefined` hors de ces bases ou sans segment. */
function segmentFamille(chemin: string): string | undefined {
  for (const base of [HTTP_MOUNT_PATH, SSE_MOUNT_PATH]) {
    if (!chemin.startsWith(base + "/")) continue;
    return lowerPy(chemin.slice(base.length + 1).replace(/^\/+|\/+$/gu, "")) || undefined;
  }
  return undefined;
}

/** `FamilyScopeASGI` : famille portée par le chemin ; `undefined` sans segment, `null` si inconnue. */
export function familleDuChemin(chemin: string): string | null | undefined {
  const fam = segmentFamille(chemin);
  if (fam === undefined) return undefined;
  return FAMILY_NAMES.includes(fam) ? fam : null;
}

const PORTEE = Symbol("portee-identite");

type RequeteAvecPortee = FastifyRequest & { [PORTEE]?: AsyncResource };

/** Contrôles de chemin MCP, dans l'ordre des middlewares (Origin puis famille) ; vrai si une réponse a été envoyée. */
function porteMcp(requete: FastifyRequest, reponse: FastifyReply, chemin: string): boolean {
  if (!originAllowed(premierEntete(requete, "origin"))) {
    void refusMcp(reponse, 403, "origine non autorisée");
    return true;
  }
  const fam = segmentFamille(chemin);
  if (fam !== undefined && !FAMILY_NAMES.includes(fam)) {
    void refusMcp(reponse, 404, `famille d'outils inconnue : ${fam}`);
    return true;
  }
  return false;
}

/** Porte de toute requête, avant le routage comme le middleware ASGI : `/health` ouvert, chemins MCP aux portes du service, reste sous jeton et enveloppe. */
export function installerPorte(app: FastifyInstance, reglages: ReglagesPorte): void {
  app.decorateRequest("identite", null);
  app.addHook(
    "onRequest",
    (requete: FastifyRequest, reponse: FastifyReply, fait: HookHandlerDoneFunction) => {
      const chemin = cheminDecode(requete);
      if (OPEN_PATHS.includes(chemin)) return suite(requete, reponse, fait);
      if (MCP_PREFIXES.some((p) => chemin.startsWith(p))) {
        if (requete.ws) return void reponse.code(403).send();
        if (porteMcp(requete, reponse, chemin)) return undefined;
        return suite(requete, reponse, fait);
      }
      const refus = (statut: number, detail: string): void => {
        if (requete.ws) void reponse.code(403).send();
        else void rejeter(reponse, statut, detail);
      };
      if (!reglages.jeton) return refus(503, MESSAGE_SANS_JETON);
      if (!bearerMatches(requete.headers.authorization, reglages.jeton))
        return refus(401, "jeton de service requis");
      const brut = requete.headers[IDENTITY_HEADER];
      const ident = verify(typeof brut === "string" ? brut : undefined, reglages.jeton, {
        maxSkewS: reglages.decalageMaxS,
      });
      if (ident === null) return refus(401, "enveloppe d'identité absente ou invalide");
      requete.identite = ident;
      return avecIdentite(ident, () => {
        (requete as RequeteAvecPortee)[PORTEE] = new AsyncResource("toolhost-identite");
        suite(requete, reponse, fait);
      });
    },
  );
  app.addHook(
    "preHandler",
    (requete: FastifyRequest, _reponse: FastifyReply, fait: HookHandlerDoneFunction) => {
      const portee = (requete as RequeteAvecPortee)[PORTEE];
      if (portee === undefined) return fait();
      return portee.runInAsyncScope(fait);
    },
  );
}

/** Chemin sans route (méthode comprise) : le montage `/` du service MCP répond 404 en texte, jamais 405 ni 307 ; WebSocket : 403 ; saut de ligne intérieur (hors du `.*` du montage) : 404 JSON de FastAPI. */
export function sansRoute(requete: FastifyRequest, reponse: FastifyReply): FastifyReply {
  if (requete.ws) return reponse.code(403).send();
  if (/\n[\s\S]/u.test(cheminDecode(requete))) return reponse.code(404).send({ detail: "Not Found" });
  return introuvable(reponse);
}

function suite(requete: FastifyRequest, reponse: FastifyReply, fait: HookHandlerDoneFunction): void {
  if (requete.is404) return void sansRoute(requete, reponse);
  fait();
}
