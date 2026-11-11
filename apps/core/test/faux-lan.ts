// SPDX-License-Identifier: MIT
/** apps/core/test/faux-lan.ts — faux service du LAN des vecteurs Python : réponses scriptées consommées dans l'ordre, requêtes notées (frontière multipart neutralisée, échéance X-Elpis-Timeout), port fermé. */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { pyJsonDumps } from "@elpis/commun";

export type ReponseScriptee = {
  statut: number;
  json?: unknown;
  texte?: string;
  octets?: string;
  type?: string;
  /** Délai avant de répondre (ms) ; `coupe` : connexion fermée sans réponse. */
  delaiMs?: number;
  coupe?: boolean;
};

export type RequeteVue = {
  m: string;
  p: string;
  type: string;
  auth: string | null;
  accept: string | null;
  corps: string;
  /** En-tête `X-Elpis-Timeout` (agent bureau), noté seulement s'il est présent. */
  to?: string;
};

/** Serveur HTTP/1.1 local : `reponses` est consommée requête après requête (599 au-delà), `vues` garde ce qui est arrivé. */
export class FauxLan {
  readonly vues: RequeteVue[] = [];
  reponses: ReponseScriptee[] = [];
  private readonly serveur: Server;
  private readonly sockets = new Set<Socket>();
  url = "";

  private constructor() {
    this.serveur = createServer((req, rep) => void this.servir(req, rep));
    this.serveur.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  static async demarrer(): Promise<FauxLan> {
    const f = new FauxLan();
    await new Promise<void>((ok) => f.serveur.listen(0, "127.0.0.1", ok));
    f.url = `http://127.0.0.1:${(f.serveur.address() as AddressInfo).port}`;
    return f;
  }

  private async servir(req: IncomingMessage, rep: ServerResponse): Promise<void> {
    const morceaux: Buffer[] = [];
    for await (const m of req) morceaux.push(m as Buffer);
    let corps = Buffer.concat(morceaux);
    let type = req.headers["content-type"] ?? "";
    const frontiere = /boundary=([0-9a-f]+)/.exec(type)?.[1];
    if (frontiere) {
      corps = Buffer.from(corps.toString("latin1").split(frontiere).join("<B>"), "latin1");
      type = type.split(frontiere).join("<B>");
    }
    this.vues.push({
      m: req.method ?? "",
      p: req.url ?? "",
      type,
      auth: req.headers.authorization ?? null,
      accept: req.headers.accept ?? null,
      corps: corps.toString("base64"),
      ...(typeof req.headers["x-elpis-timeout"] === "string" ? { to: req.headers["x-elpis-timeout"] } : {}),
    });
    const r = this.reponses.shift() ?? { statut: 599, json: { error: "non scripté" } };
    if (r.delaiMs) await new Promise((ok) => setTimeout(ok, r.delaiMs));
    if (r.coupe) {
      req.socket.destroy();
      return;
    }
    let sortie: Buffer;
    let t: string;
    if (r.json !== undefined) {
      sortie = Buffer.from(pyJsonDumps(r.json, { ensureAscii: false }), "utf-8");
      t = "application/json";
    } else if (r.texte !== undefined) {
      sortie = Buffer.from(r.texte, "utf-8");
      t = r.type ?? "text/plain; charset=utf-8";
    } else if (r.octets !== undefined) {
      sortie = Buffer.from(r.octets, "base64");
      t = r.type ?? "audio/wav";
    } else {
      sortie = Buffer.alloc(0);
      t = "text/plain";
    }
    rep.writeHead(r.statut, { "content-type": t, "content-length": String(sortie.length) });
    rep.end(sortie);
  }

  async arreter(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => this.serveur.close(() => ok()));
  }
}

/** Adresse d'un port qui n'écoute plus (connexion refusée). */
export async function portFerme(): Promise<string> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}
