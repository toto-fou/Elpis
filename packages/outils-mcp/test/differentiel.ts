// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/differentiel.ts — harnais différentiel Python ↔ TS : runner des étapes (le même que outils_mcp_protocole.py), service TS lancé sur un port libre, comparaison aux réponses enregistrées du Python. */
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ServiceMcpHttp } from "../src/http";
import type { VerificateurJetons } from "../src/jetons";
import type { ServeurOutils } from "../src/serveur";

type Dict = Record<string, unknown>;

/** Étape : requête (`m`, `u`, `h`, `corps`, `garder`), ou flux SSE (`sse`, `nom`), lecture (`lire`, `n`), fermeture (`fermer`). */
export interface Etape {
  m?: string;
  u?: string;
  h?: Record<string, string>;
  corps?: unknown;
  garder?: string;
  sse?: string;
  nom?: string;
  lire?: string;
  n?: number;
  fermer?: string;
}

export interface Cible {
  readonly base: string;
  arreter(): Promise<void>;
}

const ENTETES = ["content-type", "allow", "www-authenticate", "cache-control", "x-accel-buffering"];

function premiere(h: IncomingHttpHeaders, nom: string): string | undefined {
  const v = h[nom];
  return Array.isArray(v) ? v[0] : v;
}

/** Événements d'un flux SSE (`\r\n`) ; l'identifiant de session de l'endpoint est masqué. */
export function evenements(texte: string): Dict[] {
  const sortie: Dict[] = [];
  for (const bloc of texte.split("\r\n\r\n")) {
    if (!bloc.startsWith("event: ")) continue;
    const reste = bloc.slice("event: ".length);
    const i = reste.indexOf("\r\ndata: ");
    const nom = i < 0 ? reste : reste.slice(0, i);
    const donnees = i < 0 ? "" : reste.slice(i + "\r\ndata: ".length);
    let valeur: unknown;
    try {
      valeur = JSON.parse(donnees);
    } catch {
      valeur = donnees.includes("?session_id=")
        ? `${donnees.split("?session_id=")[0] ?? ""}?session_id=<sid>`
        : donnees;
    }
    sortie.push({ event: nom, data: valeur });
  }
  return sortie;
}

function jsonOuTexte(texte: string): unknown {
  try {
    return JSON.parse(texte);
  } catch {
    return texte;
  }
}

function normaliser(statut: number, h: IncomingHttpHeaders, texte: string, sids: Map<string, string>): Dict {
  const vus: Dict = {};
  for (const n of ENTETES) {
    const v = premiere(h, n);
    if (v !== undefined)
      vus[n] =
        n === "allow"
          ? v
              .split(",")
              .map((m) => m.trim())
              .sort()
              .join(", ")
          : v;
  }
  const sid = premiere(h, "mcp-session-id");
  if (sid !== undefined) {
    const nom = [...sids].find(([, v]) => v === sid)?.[0];
    vus["mcp-session-id"] = nom ? `$sid:${nom}` : "$sid:nouveau";
  }
  const ct = premiere(h, "content-type") ?? "";
  return {
    statut,
    entetes: vus,
    corps: ct.startsWith("text/event-stream") ? evenements(texte) : jsonOuTexte(texte),
  };
}

interface Reponse {
  statut: number;
  entetes: IncomingHttpHeaders;
  texte: string;
}

function envoyer(
  base: string,
  methode: string,
  chemin: string,
  entetes: Record<string, string>,
  corps?: string,
): Promise<Reponse> {
  const u = new URL(base);
  return new Promise((fin, echec) => {
    const r = request(
      {
        agent: false,
        host: u.hostname,
        port: u.port,
        method: methode,
        path: chemin,
        headers: { connection: "close", ...entetes },
      },
      (res) => {
        const morceaux: Buffer[] = [];
        res.on("data", (m: Buffer) => morceaux.push(m));
        res.on("end", () =>
          fin({
            statut: res.statusCode ?? 0,
            entetes: res.headers,
            texte: Buffer.concat(morceaux).toString("utf8"),
          }),
        );
        res.on("error", echec);
      },
    );
    r.on("error", echec);
    r.end(corps);
  });
}

interface Flux {
  blocs: string[];
  attente: (() => void) | null;
  chemin: string;
  fermer: () => void;
}

/** Ouvre un flux SSE et rend sa réponse normalisée et l'événement endpoint. */
function ouvrirFlux(
  base: string,
  chemin: string,
  entetes: Record<string, string>,
): Promise<{ flux: Flux; reponse: Dict }> {
  const u = new URL(base);
  return new Promise((fin, echec) => {
    const r = request(
      { agent: false, host: u.hostname, port: u.port, method: "GET", path: chemin, headers: entetes },
      (res) => {
        const flux: Flux = { blocs: [], attente: null, chemin: "", fermer: () => res.destroy() };
        let tampon = "";
        let premier = true;
        res.on("data", (m: Buffer) => {
          tampon += m.toString("utf8");
          let i = tampon.indexOf("\r\n\r\n");
          while (i >= 0) {
            const bloc = tampon.slice(0, i);
            tampon = tampon.slice(i + 4);
            if (premier) {
              premier = false;
              flux.chemin = bloc.split("data: ")[1] ?? "";
              const reponse = normaliser(res.statusCode ?? 0, res.headers, "", new Map());
              fin({ flux, reponse: { ...reponse, corps: evenements(bloc + "\r\n\r\n") } });
            } else if (!bloc.startsWith(":")) {
              flux.blocs.push(bloc);
              flux.attente?.();
            }
            i = tampon.indexOf("\r\n\r\n");
          }
        });
        res.on("error", () => undefined);
      },
    );
    r.on("error", echec);
    r.end();
  });
}

async function lireBlocs(flux: Flux, n: number): Promise<string[]> {
  const limite = Date.now() + 10_000;
  while (flux.blocs.length < n) {
    if (Date.now() > limite) throw new Error(`flux muet (${flux.blocs.length}/${n} événements)`);
    await new Promise<void>((fin) => {
      flux.attente = fin;
      setTimeout(fin, 100);
    });
  }
  return flux.blocs.splice(0, n);
}

/** Rejoue les étapes sur `base` et rend les réponses normalisées (mêmes règles que le runner Python). */
export async function rejouer(etapes: readonly Etape[], base: string): Promise<Dict[]> {
  const sids = new Map<string, string>();
  const flux = new Map<string, Flux>();
  const sortie: Dict[] = [];
  const subst = (v: string): string =>
    v.startsWith("$sid:")
      ? (sids.get(v.slice(5)) ?? "")
      : v.startsWith("$ep:")
        ? (flux.get(v.slice(4))?.chemin ?? "")
        : v;
  try {
    for (const e of etapes) {
      if (e.sse !== undefined) {
        const { flux: f, reponse } = await ouvrirFlux(base, e.sse, e.h ?? {});
        flux.set(e.nom ?? "", f);
        sortie.push(reponse);
        continue;
      }
      if (e.lire !== undefined) {
        const blocs = await lireBlocs(flux.get(e.lire) as Flux, e.n ?? 1);
        sortie.push({ evenements: evenements(blocs.join("\r\n\r\n") + "\r\n\r\n") });
        continue;
      }
      if (e.fermer !== undefined) {
        flux.get(e.fermer)?.fermer();
        continue;
      }
      const h = Object.fromEntries(Object.entries(e.h ?? {}).map(([k, v]) => [k, subst(v)]));
      const corps =
        e.corps === undefined ? undefined : typeof e.corps === "string" ? e.corps : JSON.stringify(e.corps);
      const r = await envoyer(base, e.m ?? "GET", subst(e.u ?? "/"), h, corps);
      if (e.garder !== undefined) sids.set(e.garder, premiere(r.entetes, "mcp-session-id") ?? "");
      sortie.push(normaliser(r.statut, r.entetes, r.texte, sids));
    }
  } finally {
    for (const f of flux.values()) f.fermer();
  }
  return sortie;
}

/** Service TS seul sur un port libre (comme `python server/local_mcp_server.py` : porte d'origine sur tous les chemins). */
export async function demarrerTs(o: {
  serveur: ServeurOutils;
  verificateur: VerificateurJetons | null;
  transport: "http" | "sse";
}): Promise<Cible> {
  const service = new ServiceMcpHttp({
    serveur: o.serveur,
    verificateur: o.verificateur,
    http: o.transport === "http" ? "/mcp" : null,
    sse: o.transport === "sse" ? "/sse" : null,
    porteSurTout: true,
    pingMs: 0,
  });
  const srv: Server = createServer((req, res) => {
    void service.traiter(req, res).then((pris) => {
      if (pris) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "content-length": "9" });
      res.end("Not Found");
    });
  });
  await new Promise<void>((fin) => srv.listen(0, "127.0.0.1", () => fin()));
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    arreter: async () => {
      await service.fermer();
      srv.closeAllConnections();
      await new Promise<void>((fin) => srv.close(() => fin()));
    },
  };
}

/** Écarts entre deux suites de réponses normalisées (indice, étape, attendu, obtenu). */
export function ecarts(
  etapes: readonly Etape[],
  python: readonly unknown[],
  ts: readonly unknown[],
): string[] {
  const sortie: string[] = [];
  for (let i = 0; i < Math.max(python.length, ts.length); i++) {
    const a = JSON.stringify(python[i]);
    const b = JSON.stringify(ts[i]);
    if (a !== b)
      sortie.push(`#${i} ${JSON.stringify(etapes[i]).slice(0, 120)}\n  python : ${a}\n  ts     : ${b}`);
  }
  return sortie;
}
