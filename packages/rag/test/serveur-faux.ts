// SPDX-License-Identifier: MIT
/** packages/rag/test/serveur-faux.ts — faux serveur HTTP local pour les tests : requêtes enregistrées, réponse décidée par un gestionnaire. */
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface RequeteRecue {
  methode: string;
  chemin: string;
  recherche: string;
  entetes: IncomingHttpHeaders;
  corps: unknown;
}

export interface ReponseFausse {
  statut?: number;
  json?: unknown;
  texte?: string;
  entetes?: Record<string, string>;
  attenteMs?: number;
  couper?: boolean;
}

export type Gestionnaire = (r: RequeteRecue, rang: number) => ReponseFausse | Promise<ReponseFausse>;

export interface ServeurFaux {
  url: string;
  requetes: RequeteRecue[];
  arreter: () => Promise<void>;
}

/** Serveur sur un port libre ; `rang` est le numéro (depuis 0) de la requête dans l'ordre d'arrivée. */
export async function demarrerServeurFaux(gestionnaire: Gestionnaire): Promise<ServeurFaux> {
  const requetes: RequeteRecue[] = [];
  const serveur = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m: Buffer) => morceaux.push(m));
    req.on("end", () => {
      void (async () => {
        const brut = Buffer.concat(morceaux).toString("utf8");
        let corps: unknown = brut === "" ? undefined : brut;
        try {
          if (brut !== "") corps = JSON.parse(brut) as unknown;
        } catch {
          corps = brut;
        }
        const u = new URL(req.url ?? "/", "http://x");
        const recue: RequeteRecue = {
          methode: req.method ?? "GET",
          chemin: u.pathname,
          recherche: u.search,
          entetes: req.headers,
          corps,
        };
        const rang = requetes.length;
        requetes.push(recue);
        const rep = await gestionnaire(recue, rang);
        if (rep.attenteMs) await new Promise((r) => setTimeout(r, rep.attenteMs));
        if (rep.couper) {
          req.socket.destroy();
          return;
        }
        const texte = rep.texte ?? (rep.json === undefined ? "" : JSON.stringify(rep.json));
        res.writeHead(rep.statut ?? 200, { "content-type": "application/json", ...rep.entetes });
        res.end(texte);
      })();
    });
  });
  await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", resolve));
  const { port } = serveur.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requetes,
    arreter: () =>
      new Promise<void>((resolve) => {
        serveur.closeAllConnections();
        serveur.close(() => resolve());
      }),
  };
}
