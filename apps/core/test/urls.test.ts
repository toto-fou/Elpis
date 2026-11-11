// SPDX-License-Identifier: MIT
/** apps/core/test/urls.test.ts — URL brutes et corps JSON des réponses comme uvicorn + httptools et Starlette (vecteurs de migration-kit/vecteurs/http_urls.py). */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DefinitionRoute } from "../src/routes";
import { appTest } from "./aides";
import { entrees, py, serialiserReponse, urlCommeUvicorn } from "@elpis/http";

interface Reponse {
  statut: number;
  json?: unknown;
  texte?: string;
  location?: string;
  allow?: string;
}

interface RequeteVecteur extends Reponse {
  id: string;
  methode: string;
  cible: string;
}

const vecteurs = JSON.parse(readFileSync(new URL("./vecteurs/http_urls.json", import.meta.url), "utf8")) as {
  requetes: RequeteVecteur[];
};

const route = (chemin: string, traiter: DefinitionRoute["traiter"]): DefinitionRoute => ({
  methode: "GET",
  chemin,
  processus: ["main"],
  acces: "public",
  traiter,
});

/** Les routes de l'app de référence, écrites comme un porteur de routes les écrirait. */
const ROUTES: DefinitionRoute[] = [
  route("/f/:nom", (r) => entrees(r, { path: { nom: py.str() } }).path),
  route("/f/:nom/g", (r) => ({ nom_g: entrees(r, { path: { nom: py.str() } }).path.nom })),
  route("/n/:n", (r) => entrees(r, { path: { n: py.int() } }).path),
  route("/p/*", (r) => ({ x: entrees(r, { path: { x: py.str().alias("*") } }).path.x })),
  route("/c/:call_id([0-9]+)", (r) => entrees(r, { path: { call_id: py.int() } }).path),
  route("/statique", () => ({ ok: true })),
  route("/q", (r) => entrees(r, { query: { v: py.str().defaut("") } }).query),
  route("/nan", () => ({ x: NaN })),
  route("/inf", () => ({ x: [1, { y: -Infinity }] })),
  route("/demi", () => ({ x: "a\ud800" })),
  route("/texte-echappe", () => ({ x: "\\ud800", n: null })),
];

const TETE_TROP_LONGUE = {
  statut: 431,
  json: {
    error: "Request Header Fields Too Large",
    message: "Exceeded maximum allowed HTTP header size",
    statusCode: 431,
  },
};

/** Écarts admis, un par un, avec la réponse de Fastify. */
const ECARTS: Readonly<Record<string, { raison: string } & Reponse>> = {
  "convertisseur-int-2p66": {
    raison: "entier au-delà de 2^53",
    statut: 400,
    json: { detail: "Paramètre hors bornes." },
  },
  "segment-20000": { raison: "tête de requête de plus de 16 Ko : 431 de Node", ...TETE_TROP_LONGUE },
  "joker-20000": { raison: "tête de requête de plus de 16 Ko : 431 de Node", ...TETE_TROP_LONGUE },
};

/** Ligne de requête envoyée octet pour octet (`app.inject` normalise l'URL) ; réponse lue jusqu'à la fermeture. */
function requeteBrute(port: number, methode: string, cible: string): Promise<Reponse> {
  return new Promise((resoudre, rejeter) => {
    const socket = connect(port, "127.0.0.1");
    const morceaux: Buffer[] = [];
    socket.on("data", (m: Buffer) => morceaux.push(m));
    socket.on("error", rejeter);
    socket.on("end", () => {
      const tout = Buffer.concat(morceaux);
      const fin = tout.indexOf("\r\n\r\n");
      const [ligne = "", ...lignes] = tout.subarray(0, fin).toString("latin1").split("\r\n");
      const entetes = new Map(
        lignes.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
      );
      const corps = tout.subarray(fin + 4).toString("utf8");
      const reponse: Reponse = { statut: Number(ligne.split(" ")[1]) };
      if (entetes.get("content-type")?.startsWith("application/json")) reponse.json = JSON.parse(corps);
      else reponse.texte = corps;
      for (const nom of ["location", "allow"] as const) {
        const valeur = entetes.get(nom);
        if (valeur !== undefined) reponse[nom] = valeur;
      }
      resoudre(reponse);
    });
    const tete = `${methode} @@CIBLE@@ HTTP/1.1\r\nHost: t\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
    const [avant = "", apres = ""] = tete.split("@@CIBLE@@");
    socket.write(Buffer.concat([Buffer.from(avant), Buffer.from(cible, "latin1"), Buffer.from(apres)]));
  });
}

describe("URL brutes et réponses : uvicorn + httptools (production Python) ↔ Fastify", () => {
  let app: FastifyInstance;
  let port = 0;

  beforeAll(async () => {
    app = await appTest({ familles: [{ nom: "urls", routes: ROUTES }] });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it(`${vecteurs.requetes.length} requêtes : statut, corps, Location et Allow identiques, sauf écarts admis listés`, async () => {
    const ecarts: unknown[] = [];
    const vus = new Set<string>();
    for (const { id, methode, cible, ...python } of vecteurs.requetes) {
      const obtenu = await requeteBrute(port, methode, cible);
      const admis = ECARTS[id];
      let attendu: Reponse = python;
      if (admis) {
        vus.add(id);
        const { raison: _raison, ...reponse } = admis;
        expect(python, `${id} : l'écart admis existe encore`).not.toEqual(reponse);
        attendu = reponse;
      }
      try {
        expect(obtenu).toEqual(attendu);
      } catch {
        ecarts.push({
          id,
          attendu: JSON.stringify(attendu).slice(0, 200),
          obtenu: JSON.stringify(obtenu).slice(0, 200),
        });
      }
    }
    expect(ecarts).toEqual([]);
    expect([...vus].sort()).toEqual(Object.keys(ECARTS).sort());
  });
});

describe("chemin réécrit avant le routage et corps JSON des réponses", () => {
  it("urlCommeUvicorn : seul le chemin est décodé puis réencodé ; requête et fragment restent tels quels", () => {
    expect(urlCommeUvicorn("/f/abc?v=%ff#%zz")).toBe("/f/abc?v=%ff#%zz");
    expect(urlCommeUvicorn("/f/a%2Fb?v=%2F#x")).toBe("/f/a/b?v=%2F#x");
    expect(urlCommeUvicorn("/f/%ff%zz%")).toBe("/f/%EF%BF%BD%25zz%25");
    expect(urlCommeUvicorn("/f/%3F%23%25%20")).toBe("/f/%3F%23%25%20");
    expect(urlCommeUvicorn("/f/caf%E9#a?b")).toBe("/f/caf%EF%BF%BD#a?b");
  });

  it("serialiserReponse : NaN, ±inf et demi-paire lèvent comme JSONResponse ; un texte échappé passe", () => {
    expect(() => serialiserReponse({ a: [1, { b: NaN }] })).toThrow(/not JSON compliant/);
    expect(() => serialiserReponse([Infinity])).toThrow(/not JSON compliant/);
    expect(() => serialiserReponse({ toJSON: () => ({ x: -Infinity }) })).toThrow(/not JSON compliant/);
    expect(() => serialiserReponse({ x: "\ud800" })).toThrow(/surrogates/);
    expect(() => serialiserReponse({ x: "\\\ud800" })).toThrow(/surrogates/);
    expect(serialiserReponse({ x: "\\ud800", n: null, d: new Date(0) })).toBe(
      '{"x":"\\\\ud800","n":null,"d":"1970-01-01T00:00:00.000Z"}',
    );
    expect(serialiserReponse(undefined)).toBe("null");
    const cycle: Record<string, unknown> = {};
    cycle.moi = cycle;
    expect(() => serialiserReponse(cycle)).toThrow(TypeError);
  });
});
