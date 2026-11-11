// SPDX-License-Identifier: MIT
/** apps/core/test/interface-durcissement.test.ts — liens sortants, types, cache normalisé, redirection encodée, vendor chargés à la demande. */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { creerApp } from "../src/app";
import { Pages } from "../src/interface/pages";
import { servirStatique, typeStatique } from "../src/interface/statiques";
import { VENDOR_NPM } from "../../../frontend/vendor.config.mjs";
import { appTest, journalMuet } from "./aides";

/** Sources et outillage de `@elpis/web` (dossiers, et fichiers .ts/.mts/.json de la racine), refusés par servirStatique. */
const NON_SERVIS_WEB = new Set(["src", "test", "node_modules"]);
const racine = mkdtempSync(join(tmpdir(), "elpis-durci-"));
const frontend = join(racine, "frontend");
let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync(join(frontend, "vendor"), { recursive: true });
  mkdirSync(join(frontend, "js"), { recursive: true });
  writeFileSync(join(racine, "secret.txt"), "SECRET");
  writeFileSync(join(frontend, "js", "app.js"), "a");
  symlinkSync(join(racine, "secret.txt"), join(frontend, "lien-sortant.txt"));
  symlinkSync("../secret.txt", join(frontend, "lien-relatif.txt"));
  symlinkSync(join(racine, "secret.txt"), join(frontend, "vendor", "lien.js"));
  symlinkSync(join(frontend, "js", "app.js"), join(frontend, "lien-interne.js"));
  app = await appTest({
    familles: [
      {
        nom: "s",
        routes: [
          {
            methode: "GET",
            chemin: "/static/*",
            processus: ["main"],
            acces: "public",
            traiter: servirStatique(frontend),
          },
        ],
      },
    ],
  });
});

afterAll(async () => {
  await app.close();
  rmSync(racine, { recursive: true, force: true });
});

describe("fichiers statiques", () => {
  it("un lien qui sort de frontend/ est refusé, un lien interne est servi", async () => {
    for (const url of [
      "/static/lien-sortant.txt",
      "/static/lien-relatif.txt",
      "/static/vendor/lien.js?v=1",
    ]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain("SECRET");
    }
    expect((await app.inject({ method: "GET", url: "/static/lien-interne.js" })).statusCode).toBe(200);
  });

  it("règle de cache sur le chemin normalisé", async () => {
    const r = await app.inject({ method: "GET", url: "/static/vendor/../js/app.js?v=1" });
    expect(r.headers["cache-control"]).toBe("no-cache, must-revalidate");
  });

  it("types : extension intérieure des fichiers compressés, table complète pour frontend/", () => {
    expect(typeStatique("x.js.gz")).toBe("application/javascript; charset=utf-8");
    expect(typeStatique("x.avif")).toBe("image/avif");
    const reel = join(process.cwd(), "frontend");
    const extensions = new Set<string>();
    const parcourir = (d: string): void => {
      for (const nom of readdirSync(d)) {
        if (d === reel && (NON_SERVIS_WEB.has(nom) || /\.(?:ts|mts|json)$/.test(nom))) continue;
        const p = join(d, nom);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (extname(nom)) extensions.add(extname(nom).toLowerCase());
      }
    };
    parcourir(reel);
    const inconnues = [...extensions].filter(
      (e) => typeStatique(`f${e}`) === "text/plain; charset=utf-8" && e !== ".txt" && e !== ".map",
    );
    expect(inconnues).toEqual([]);
  });
});

describe("pages", () => {
  it("BUILD_ID sûr pris littéralement ; CRLF lu comme Python", () => {
    writeFileSync(join(frontend, "p.html"), '<head></head>\r\n<script src="x.js?v=1"></script>\r');
    const html = new Pages(frontend, "B-1.2_x").rendre("p.html");
    expect(html).toContain('x.js?v=B-1.2_x"');
    expect(html).not.toContain("\r");
  });

  it("BUILD_ID hors forme sûre jamais injecté : identifiant neuf (écart voulu au Python de référence)", () => {
    mkdirSync(join(frontend, "pire"), { recursive: true });
    writeFileSync(
      join(frontend, "pire", "p.html"),
      '<head></head><script src="x.js?v=1"></script><link href="static/vendor/absent.css">',
    );
    for (const mauvais of ['1"><script>alert(1)</script>', "B$$'", "\\g<0>", "a b", "é"]) {
      const html = new Pages(frontend, mauvais).rendre("pire/p.html");
      expect(html, mauvais).toMatch(/x\.js\?v=\d+-[0-9a-f]{6}"/);
      expect(html, mauvais).toMatch(/absent\.css\?v=\d+-[0-9a-f]{6}"/);
      expect(html, mauvais).not.toContain(mauvais);
      expect(html.match(/<script/g)?.length, mauvais).toBe(1);
    }
  });

  it("bundles chargés à la demande : exactement les groupes de frontend/src/platform/vendor.ts", () => {
    const ts = readFileSync(join(process.cwd(), "frontend", "src", "platform", "vendor.ts"), "utf-8");
    const debut = ts.indexOf("const GROUPES");
    const fin = ts.indexOf("const enAttente", debut);
    const dansTs = new Set([...ts.slice(debut, fin).matchAll(/"(vendor\/[^"]+)"/g)].map((m) => m[1]));
    expect(dansTs).toEqual(new Set(Object.keys(VENDOR_NPM)));
  });
});

describe("redirection de main vers la console", () => {
  it("URL encodée comme RedirectResponse (quote)", async () => {
    const avant = process.env["ADMIN_PUBLIC_URL"];
    process.env["ADMIN_PUBLIC_URL"] = "http://elpis.lan:8002/админ é";
    try {
      const main = await creerApp({ mode: "main", journal: journalMuet });
      const r = await main.inject({ method: "GET", url: "/admin" });
      expect(r.statusCode).toBe(302);
      expect(r.headers["location"]).toBe("http://elpis.lan:8002/%D0%B0%D0%B4%D0%BC%D0%B8%D0%BD%20%C3%A9");
      await main.close();
    } finally {
      if (avant === undefined) delete process.env["ADMIN_PUBLIC_URL"];
      else process.env["ADMIN_PUBLIC_URL"] = avant;
    }
  });
});
