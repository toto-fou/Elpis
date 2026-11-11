// SPDX-License-Identifier: MIT
/** apps/core/test/routage.test.ts — apps main et admin composées contre les vraies apps Python (vecteurs http_routage.py) : barres finales (307), 405 + Allow, HEAD. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composer } from "../src/composition";
import type { ModeApp } from "../src/mode";
import { appTest, journalMuet } from "./aides";
import { motifVersRegex, urlCommeUvicorn } from "@elpis/http";

interface Reponse {
  statut: number;
  location?: string;
  allow?: string;
  json?: unknown;
}

interface Mesure extends Reponse {
  id: string;
  methode: string;
  cible: string;
  entetes: Record<string, string>;
}

const V = JSON.parse(
  readFileSync(new URL("./vecteurs/http_routage.json", import.meta.url), "utf8"),
) as Record<ModeApp, Mesure[]>;

/** Écarts admis (processus:identifiant), avec la réponse du core. */
const STATIQUE_BARRE = {
  raison:
    "fichier statique suivi d'une barre : StaticFiles le sert (os.path.normpath), @fastify/send non (statiques, hors routeur)",
  statut: 404,
  json: { detail: "Not Found" },
};
const ABSOLUE_SANS_CHEMIN = {
  raison: "cible en forme absolue sans chemin (`GET http://t`) : 400 d'uvicorn (httptools), 404 du core",
  statut: 404,
  json: { detail: "Not Found" },
};
const SAUT_DE_LIGNE_FINAL = {
  raison:
    "`$` des regex de Starlette accepte un saut de ligne final (`/api/health%0A` = 200) ; pas le routeur de Fastify",
  statut: 404,
  json: { detail: "Not Found" },
};
const ECARTS: Readonly<Record<string, { raison: string } & Reponse>> = {
  "main:statique-fichier-barre": STATIQUE_BARRE,
  "admin:statique-fichier-barre": STATIQUE_BARRE,
  "main:cible-absolue-sans-chemin": ABSOLUE_SANS_CHEMIN,
  "admin:cible-absolue-sans-chemin": ABSOLUE_SANS_CHEMIN,
  "main:sante-saut-de-ligne": SAUT_DE_LIGNE_FINAL,
  "admin:sante-saut-de-ligne": SAUT_DE_LIGNE_FINAL,
  "main:pont-mcp-head": {
    raison:
      "Allow d'une route à plusieurs méthodes : ordre déclaré (Python : ordre d'un set, aléatoire par process)",
    statut: 405,
    allow: "GET, POST, DELETE",
  },
};

/** Ligne de requête envoyée octet pour octet ; mêmes champs relevés que le générateur Python. */
function requeteBrute(port: number, m: Mesure): Promise<Reponse> {
  return new Promise((resoudre, rejeter) => {
    const socket = connect(port, "127.0.0.1");
    const morceaux: Buffer[] = [];
    socket.on("data", (x: Buffer) => morceaux.push(x));
    socket.on("error", rejeter);
    socket.on("end", () => {
      const tout = Buffer.concat(morceaux);
      const fin = tout.indexOf("\r\n\r\n");
      const [ligne = "", ...lignes] = tout.subarray(0, fin).toString("latin1").split("\r\n");
      const h = new Map(
        lignes.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
      );
      const r: Reponse = { statut: Number(ligne.split(" ")[1]) };
      for (const nom of ["location", "allow"] as const) {
        const v = h.get(nom);
        if (v !== undefined) r[nom] = v;
      }
      if (r.statut >= 300 && h.get("content-type")?.startsWith("application/json") && m.methode !== "HEAD")
        r.json = JSON.parse(tout.subarray(fin + 4).toString("utf8"));
      resoudre(r);
    });
    const entetes = { Host: "t", ...m.entetes };
    const lignes = Object.entries(entetes)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    socket.write(
      Buffer.from(
        `${m.methode} ${m.cible} HTTP/1.1\r\n${lignes}Connection: close\r\nContent-Length: 0\r\n\r\n`,
        "latin1",
      ),
    );
  });
}

let t: BaseDeTest;
let dossier: string;
const manifesteAvant = process.env["APP_MCP_MANIFEST"];
const apps: Partial<Record<ModeApp, { app: FastifyInstance; port: number }>> = {};

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-routage-"));
  process.env["APP_MCP_MANIFEST"] = join(dossier, "absent.json");
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  const dep: DependancesAuth & DependancesJetons = {
    base: t.base,
    config: () => ({}),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => "secret-de-test",
    jetonService: () => "",
    maintenant: () => 1_791_331_200,
  };
  for (const mode of ["main", "admin"] as const) {
    const c = await composer(mode, t.base, journalMuet, dep, dossier);
    const app = await appTest({ ...c, mode });
    await app.listen({ port: 0, host: "127.0.0.1" });
    apps[mode] = { app, port: (app.server.address() as AddressInfo).port };
  }
});

afterAll(async () => {
  for (const a of Object.values(apps)) await a.app.close();
  await t.fermer();
  if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
  else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
  rmSync(dossier, { recursive: true, force: true });
});

describe("routage comme Starlette : apps main et admin contre les vraies apps Python", () => {
  it.each(["main", "admin"] as const)(
    "%s : statut, Location, Allow et corps identiques, sauf écarts admis",
    async (mode) => {
      const ecarts: unknown[] = [];
      const vus = new Set<string>();
      const { port } = apps[mode] as { port: number };
      for (const m of V[mode]) {
        const { id, methode: _m, cible: _c, entetes: _e, ...python } = m;
        const obtenu = await requeteBrute(port, m);
        const cle = `${mode}:${id}`;
        const admis = ECARTS[cle];
        let attendu: Reponse = python;
        if (admis) {
          vus.add(cle);
          const { raison: _r, ...reponse } = admis;
          expect(python, `${cle} : l'écart admis existe encore`).not.toEqual(reponse);
          attendu = reponse;
        }
        if (!isDeepStrictEqual(obtenu, attendu)) ecarts.push({ cle, attendu, obtenu });
      }
      expect(ecarts).toEqual([]);
      expect([...vus].sort()).toEqual(
        Object.keys(ECARTS)
          .filter((c) => c.startsWith(`${mode}:`))
          .sort(),
      );
    },
  );
});

describe("motifs Fastify traduits pour le routeur Starlette", () => {
  const MOTIFS = [
    "/a",
    "/a/:x",
    "/a/:x/b",
    "/c/:id([0-9]+)",
    "/r/:n([a-z\\-]+)",
    "/p/*",
    "/d/:a-:b",
    "/e::f",
    "/g/:file.:ext",
    "/h.json",
    "/k/:id(^\\d+$)",
    "/l/:n(^[a-z]+)/:m([0-9]+$)",
  ];
  const CHEMINS = [
    "/a",
    "/a/",
    "/a/x",
    "/a/x/",
    "/a/x/b",
    "/a//b",
    "/c/12",
    "/c/1a",
    "/c/",
    "/r/a-b",
    "/r/A",
    "/p",
    "/p/",
    "/p/a/b",
    "/d/x-y",
    "/d/x",
    "/e:f",
    "/e::f",
    "/g/a.b",
    "/g/ab",
    "/h.json",
    "/hxjson",
    "/a/%C3%A9",
    "/a/%0A",
    "/k/12",
    "/k/1a",
    "/k/",
    "/l/ab/12",
    "/l/AB/12",
    "/l/ab/1x",
  ];

  it("même verdict que find-my-way (paramètre nommé vide exclu, comme `[^/]+`)", async () => {
    const app = Fastify();
    for (const url of MOTIFS) app.get(url, () => null);
    await app.ready();
    const ecarts: string[] = [];
    for (const brut of CHEMINS) {
      const trouvee = app.findRoute({ method: "GET", url: urlCommeUvicorn(brut) });
      const vide =
        trouvee !== null &&
        Object.entries(trouvee.params as Record<string, string>).some(([nom, v]) => nom !== "*" && v === "");
      const fastify = trouvee !== null && !vide;
      const decode = decodeURIComponent(brut);
      const regex = MOTIFS.some((m) => motifVersRegex(m).test(decode));
      if (fastify !== regex) ecarts.push(`${brut} : find-my-way ${fastify}, regex ${regex}`);
    }
    await app.close();
    expect(ecarts).toEqual([]);
  });
});
