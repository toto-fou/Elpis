// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/facade.ts — façade MCP de l'hôte : `/mcp[/<famille>]`, `/sse[/<famille>]` et `/messages/` aiguillés vers les familles natives avant toute analyse ; une requête qu'aucune ne prend est refusée. */
import type { IncomingMessage, ServerResponse } from "node:http";

import { pyJsonDumps } from "@elpis/commun";
import { cheminDecode, decouperCible } from "@elpis/http";
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

import { decrire } from "../decrire";
import type { Journal } from "../journal";
import { HTTP_MOUNT_PATH, introuvable, SSE_MOUNT_PATH } from "../porte";

export const MESSAGE_NON_SERVIE = "service MCP indisponible : famille non servie par l'hôte d'outils";
export const METHODES: HTTPMethods[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const CHEMINS_FACADE: readonly string[] = [
  HTTP_MOUNT_PATH,
  `${HTTP_MOUNT_PATH}/*`,
  SSE_MOUNT_PATH,
  `${SSE_MOUNT_PATH}/*`,
  "/messages",
  "/messages/*",
];

/** Familles servies par l'hôte lui-même. */
export interface AiguillageNatif {
  prend(chemin: string, requete: string): boolean;
  traiter(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface ContexteFacade {
  readonly natif?: AiguillageNatif | null;
  readonly journal: Journal;
}

/** Requête d'une famille native prise avant toute analyse : servie par @elpis/outils-mcp, 404 si non prise, 500 sur échec. */
function servirNatif(
  natif: AiguillageNatif,
  requete: FastifyRequest,
  reponse: FastifyReply,
  journal: Journal,
): void {
  reponse.hijack();
  const brut = reponse.raw;
  void natif.traiter(requete.raw, brut).then(
    (pris) => {
      if (pris || brut.headersSent) return;
      brut.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      brut.end("Not Found");
    },
    (e: unknown) => {
      journal.error(`famille native : requête MCP en échec : ${decrire(e)}`);
      if (brut.headersSent) return void brut.destroy();
      brut.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      brut.end("Internal Server Error");
    },
  );
}

/** Contexte de la famille : requêtes des familles natives aiguillées avant l'analyse ; sinon corps jamais lu ni validé ici. */
export function contexteFacade(ctx: Pick<ContexteFacade, "natif" | "journal">) {
  return async (sous: FastifyInstance): Promise<void> => {
    const natif = ctx.natif ?? null;
    if (natif !== null)
      sous.addHook("onRequest", (requete, reponse, fait) => {
        if (natif.prend(cheminDecode(requete), decouperCible(requete.url).requete))
          servirNatif(natif, requete, reponse, ctx.journal);
        fait();
      });
    sous.removeAllContentTypeParsers();
    sous.addContentTypeParser("*", (_requete, _flux, fini) => {
      fini(null);
    });
    sous.addHook("preParsing", async (requete, reponse, charge) => {
      if (!reponse.sent) delete requete.raw.headers["content-type"];
      return charge;
    });
  };
}

/** Requête qu'aucune famille native n'a prise : SSE introuvable, MCP HTTP refusé en 503. */
export function traiterFacade() {
  return (requete: FastifyRequest, reponse: FastifyReply): unknown => {
    if (reponse.sent) return undefined;
    if (!cheminDecode(requete).startsWith(HTTP_MOUNT_PATH)) return introuvable(reponse);
    return reponse
      .code(503)
      .type("application/json; charset=utf-8")
      .send(pyJsonDumps({ detail: MESSAGE_NON_SERVIE }, { ensureAscii: false }));
  };
}
