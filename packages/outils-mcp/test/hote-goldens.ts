// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/hote-goldens.ts — service MCP d'essai qui sert des familles telles que leurs goldens les figent (`/mcp`, `/mcp/<famille>`, SSE), traitement fourni par l'essai, familles mises en panne à la demande. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";

import { getUsername } from "../src/boite";
import type { ContexteAppel } from "../src/contexte";
import { outilDuGolden } from "../src/goldens";
import type { Golden } from "../src/goldens";
import { ServiceMcpHttp } from "../src/http";
import { creerVerificateur } from "../src/jetons";
import { ServeurOutils } from "../src/serveur";
import type { DefinitionOutil } from "../src/serveur";
import { lireGolden } from "./familles-test";

export type Traitement = (
  nom: string,
  famille: string,
  args: Dict,
  ctx: ContexteAppel,
) => Promise<Dict> | Dict;

export interface HoteGoldens {
  readonly base: string;
  /** Chemins reçus, dans l'ordre (requête comprise). */
  readonly chemins: string[];
  /** Familles qui répondent 503 sur `/mcp/<f>` et `/sse/<f>`. */
  readonly enPanne: Set<string>;
  /** Familles qui ne répondent jamais (requête gardée ouverte). */
  readonly muettes: Set<string>;
  /** Sessions HTTP ouvertes d'une famille oubliées, comme après un redémarrage : 404 à leur prochaine requête. */
  oublierSessions(famille: string): void;
  arreter(): Promise<void>;
}

/** Paramètres du golden sans contrainte de type, défauts du Python : seule la liste publiée compte ici. */
function signatureLibre(golden: Golden, nom: string): DefinitionOutil["signature"] {
  return Object.fromEntries(
    (golden.fonctions[nom]?.parametres ?? []).map((p) => [
      p.nom,
      p.requis ? py.any() : py.any().defaut(p.defaut ?? null),
    ]),
  );
}

const parDefaut: Traitement = (nom, famille, _args, ctx) => ({
  ok: true,
  outil: nom,
  famille,
  compte: getUsername(ctx),
});

/** Arguments minimaux d'un outil : chaque paramètre requis du golden reçoit `"x"`. */
export function argumentsRequis(golden: Golden, nom: string): Dict {
  return Object.fromEntries(
    (golden.fonctions[nom]?.parametres ?? []).filter((p) => p.requis).map((p) => [p.nom, "x"]),
  );
}

/** Service sur un port libre : chaque famille de `familles` avec les définitions de son golden. */
export async function hoteDesGoldens(o: {
  familles: readonly string[];
  traiter?: Traitement;
  /** Jeton de service exigé (Bearer) ; sans lui, tout appel est accepté. */
  jeton?: string;
}): Promise<HoteGoldens> {
  const traiter = o.traiter ?? parDefaut;
  const serveur = new ServeurOutils();
  for (const f of o.familles) {
    const golden = lireGolden(f);
    serveur.enregistrerFamille(
      f,
      golden.outils.map((d) =>
        outilDuGolden(golden, String(d["name"]), {
          signature: signatureLibre(golden, String(d["name"])),
          traiter: (args, ctx) => traiter(String(d["name"]), f, args, ctx),
        }),
      ),
    );
  }
  const service = new ServiceMcpHttp({
    serveur,
    verificateur: o.jeton
      ? creerVerificateur({ jetons: { service: o.jeton, clients: {}, familles: {} } })
      : null,
    http: "/mcp",
    sse: "/sse",
    porteSurTout: true,
    pingMs: 0,
  });
  const chemins: string[] = [];
  const enPanne = new Set<string>();
  const muettes = new Set<string>();
  const sessions = new Map<string, string>();
  const oubliees = new Set<string>();
  const srv: Server = createServer((req, res) => {
    chemins.push(req.url ?? "");
    const [, montage, fam] = (req.url ?? "").split("?")[0]?.split("/") ?? [];
    if ((montage === "mcp" || montage === "sse") && fam !== undefined && muettes.has(fam)) return;
    if ((montage === "mcp" || montage === "sse") && fam !== undefined && enPanne.has(fam)) {
      res.writeHead(503, { "content-type": "text/plain" }).end("en panne");
      return;
    }
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string" && oubliees.has(sid)) {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}');
      return;
    }
    if (typeof sid === "string" && fam !== undefined) sessions.set(sid, fam);
    void service.traiter(req, res).then((pris) => {
      if (!pris) res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
    });
  });
  await new Promise<void>((fin) => srv.listen(0, "127.0.0.1", () => fin()));
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    chemins,
    enPanne,
    muettes,
    oublierSessions: (famille) => {
      for (const [sid, f] of sessions) if (f === famille) oubliees.add(sid);
    },
    arreter: async () => {
      await service.fermer();
      srv.closeAllConnections();
      await new Promise<void>((fin) => srv.close(() => fin()));
    },
  };
}
