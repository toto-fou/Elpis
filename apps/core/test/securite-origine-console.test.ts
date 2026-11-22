// SPDX-License-Identifier: MIT
/** apps/core/test/securite-origine-console.test.ts — aucun document actif sur l'origine de la console : avatar servi seulement s'il est une image reconnue à sa signature, sous son type et en bac à sable (main et console) ; aucune origine CORS admise par la console. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { creerGardes } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleComptes } from "../src/familles/comptes";
import type { Famille } from "../src/routes";
import { appTest, journalMuet } from "./aides";
import { dependancesAuth } from "./exploitation/aides";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(24, 7)]);
const GIF = Buffer.from(`GIF89a${"\x01".repeat(24)}`, "latin1");
const POLITIQUE = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const ORIGINE = "http://outil.lan:3000";

describe.each(["main", "admin"] as const)("avatars servis par %s", (mode) => {
  let t: BaseDeTest;
  let racine: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    racine = mkdtempSync(join(tmpdir(), "elpis-avatars-"));
    const dossier = join(racine, "user_db", "avatars");
    mkdirSync(dossier, { recursive: true });
    const fichiers: Record<string, Buffer | string> = {
      "1_1.png": PNG,
      "2_1.html": GIF,
      "page.html": "<!doctype html><script>alert(1)</script>",
      "dessin.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "faux.png": "<!doctype html><script>alert(1)</script>",
      "court.webp": "RIFF",
      "vide.png": "",
    };
    for (const [nom, contenu] of Object.entries(fichiers)) writeFileSync(join(dossier, nom), contenu);
    const dep = dependancesAuth(t.base);
    app = await appTest({
      mode,
      familles: [creerFamilleComptes({ auth: dep, racine, mandataires: [], journal: journalMuet, mode })],
      gardes: creerGardes(dep),
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
    rmSync(racine, { recursive: true, force: true });
  });

  it("une image reconnue à sa signature : son type, quel que soit le nom, sans script et en bac à sable", async () => {
    for (const [nom, type, octets] of [
      ["1_1.png", "image/png", PNG],
      ["2_1.html", "image/gif", GIF],
    ] as const) {
      const r = await app.inject({ method: "GET", url: `/avatars/${nom}` });
      expect([r.statusCode, r.headers["content-type"], r.headers["content-security-policy"]], nom).toEqual([
        200,
        type,
        POLITIQUE,
      ]);
      expect(r.headers["x-content-type-options"], nom).toBe("nosniff");
      expect(r.rawPayload.equals(octets), nom).toBe(true);
    }
  });

  it("tout autre fichier du dossier répond 404, comme un avatar absent : page, SVG, faux PNG, signature tronquée, fichier vide", async () => {
    for (const nom of ["page.html", "dessin.svg", "faux.png", "court.webp", "vide.png", "absent.png"]) {
      const r = await app.inject({ method: "GET", url: `/avatars/${nom}` });
      expect([r.statusCode, r.json()], nom).toEqual([404, { detail: "Avatar not found" }]);
    }
  });
});

describe("CORS : app.cors_origins ne vaut que pour main", () => {
  const famille: Famille = {
    nom: "essai",
    routes: [
      {
        methode: "GET",
        chemin: "/api/essai",
        processus: ["main", "admin"],
        acces: "public",
        traiter: () => ({}),
      },
    ],
  };
  const apps: Partial<Record<"main" | "admin", FastifyInstance>> = {};

  beforeAll(async () => {
    for (const mode of ["main", "admin"] as const)
      apps[mode] = await appTest({ mode, familles: [famille], corsOrigines: [ORIGINE] });
  });

  afterAll(async () => {
    for (const app of Object.values(apps)) await app.close();
  });

  it("main renvoie l'origine admise ; la console, réglée pareil, ne pose aucun en-tête CORS, préflight compris", async () => {
    const simple = (mode: "main" | "admin") =>
      (apps[mode] as FastifyInstance).inject({
        method: "GET",
        url: "/api/essai",
        headers: { origin: ORIGINE },
      });
    expect((await simple("main")).headers["access-control-allow-origin"]).toBe(ORIGINE);
    const console_ = await simple("admin");
    expect(console_.statusCode).toBe(200);
    expect(Object.keys(console_.headers).filter((n) => n.startsWith("access-control-"))).toEqual([]);
    const preflight = await (apps.admin as FastifyInstance).inject({
      method: "OPTIONS",
      url: "/api/essai",
      headers: { origin: ORIGINE, "access-control-request-method": "GET" },
    });
    expect(Object.keys(preflight.headers).filter((n) => n.startsWith("access-control-"))).toEqual([]);
  });
});
