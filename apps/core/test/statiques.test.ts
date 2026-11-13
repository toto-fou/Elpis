// SPDX-License-Identifier: MIT
/** apps/core/test/statiques.test.ts — `/static/*` : types, cache, revalidation, build Vite, chemins refusés. */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { cacheStatique, empreinteFichier, servirStatique, typeStatique } from "../src/interface/statiques";
import { appTest } from "./aides";

const racine = mkdtempSync(join(tmpdir(), "elpis-statiques-"));
const frontend = join(racine, "frontend");
let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync(join(frontend, "js"), { recursive: true });
  mkdirSync(join(frontend, "vendor"), { recursive: true });
  writeFileSync(join(frontend, "js/app.js"), "console.log('é');");
  writeFileSync(join(frontend, "js/a b%.js"), "1");
  writeFileSync(join(frontend, "vendor/vue.js"), "vue");
  mkdirSync(join(frontend, "dist/assets"), { recursive: true });
  mkdirSync(join(frontend, "dist/.vite"), { recursive: true });
  writeFileSync(join(frontend, "dist/assets/main-Ab1.js"), "export {};");
  writeFileSync(join(frontend, "dist/.vite/manifest.json"), "{}");
  mkdirSync(join(frontend, "src/app"), { recursive: true });
  writeFileSync(join(frontend, "src/app/pont.ts"), "export {};");
  writeFileSync(join(frontend, "package.json"), "{}");
  writeFileSync(join(frontend, "vite.config.mts"), "export {};");
  writeFileSync(join(frontend, "logo.png"), Buffer.from([0x89, 0x50]));
  writeFileSync(join(frontend, "notes.map"), "{}");
  writeFileSync(join(racine, "secret.txt"), "non");
  app = await appTest({
    familles: [
      {
        nom: "statiques",
        routes: [
          {
            methode: ["GET", "HEAD"],
            chemin: "/static/*",
            processus: ["main"],
            acces: "public",
            montage: true,
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

describe("règles de cache et de type", () => {
  it("types de Python, charset sur JS/CSS/HTML et text/*", () => {
    expect(typeStatique("js/app.js")).toBe("application/javascript; charset=utf-8");
    expect(typeStatique("x.MJS")).toBe("text/javascript; charset=utf-8");
    expect(typeStatique("logo.png")).toBe("image/png");
    expect(typeStatique("notes.map")).toBe("text/plain; charset=utf-8");
  });

  it("URL à la version du fichier immuable ; autre version ou aucune : JS/CSS/HTML revalidés, images sans règle", () => {
    const st = { mtimeMs: 1_731_500_000_123.456, size: 42 };
    const v = empreinteFichier(st);
    expect(v).toMatch(/^[0-9a-f]{10}$/);
    for (const chemin of ["vendor/vue.js", "css/style.css", "css/skins/elpis/skin.css", "logo.png"])
      expect(cacheStatique(chemin, v, st), chemin).toBe("public, max-age=31536000, immutable");
    expect(cacheStatique("css/style.css", null, st)).toBe("no-cache, must-revalidate");
    expect(cacheStatique("css/style.css", "1", st)).toBe("no-cache, must-revalidate");
    expect(cacheStatique("css/style.css", v, { ...st, size: 43 })).toBe("no-cache, must-revalidate");
    expect(cacheStatique("js/app.js", "1", st)).toBe("no-cache, must-revalidate");
    expect(cacheStatique("logo.png", "1", st)).toBeUndefined();
    expect(cacheStatique("js/APP.JS", null, st)).toBeUndefined();
  });

  it("build Vite haché : immuable sans paramètre de version", () => {
    const st = { mtimeMs: 1, size: 1 };
    expect(cacheStatique("dist/assets/main-Ab1.js", null, st)).toBe("public, max-age=31536000, immutable");
    expect(cacheStatique("dist/assets/police-Ab1.woff2", null, st)).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});

describe("service des fichiers", () => {
  it("sert un JS avec ses en-têtes et revalide par ETag", async () => {
    const r = await app.inject({ method: "GET", url: "/static/js/app.js?v=B" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("console.log('é');");
    expect(r.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-cache, must-revalidate");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const etag = r.headers["etag"];
    expect(etag).toBeTruthy();
    const r304 = await app.inject({
      method: "GET",
      url: "/static/js/app.js",
      headers: { "if-none-match": String(etag) },
    });
    expect(r304.statusCode).toBe(304);
  });

  it("version du fichier : immuable, 304 compris ; fichier modifié : son ancienne URL est revalidée", async () => {
    const fichier = join(frontend, "vendor/vue.js");
    const v = empreinteFichier(statSync(fichier));
    const r = await app.inject({ method: "GET", url: `/static/vendor/vue.js?v=${v}` });
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const r304 = await app.inject({
      method: "GET",
      url: `/static/vendor/vue.js?v=${v}`,
      headers: { "if-none-match": String(r.headers["etag"]) },
    });
    expect([r304.statusCode, r304.headers["cache-control"]]).toEqual([
      304,
      "public, max-age=31536000, immutable",
    ]);
    expect(
      (await app.inject({ method: "GET", url: "/static/vendor/vue.js?v=123" })).headers["cache-control"],
    ).toBe("no-cache, must-revalidate");
    writeFileSync(fichier, "vue 2");
    const apres = await app.inject({ method: "GET", url: `/static/vendor/vue.js?v=${v}` });
    expect([apres.body, apres.headers["cache-control"]]).toEqual(["vue 2", "no-cache, must-revalidate"]);
    expect(empreinteFichier(statSync(fichier))).not.toBe(v);
  });

  it("build Vite : asset immuable ; manifeste, sources et outillage jamais servis", async () => {
    const r = await app.inject({ method: "GET", url: "/static/dist/assets/main-Ab1.js" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    for (const url of [
      "/static/dist/.vite/manifest.json",
      "/static/dist/%2evite/manifest.json",
      "/static/src/app/pont.ts",
      "/static/package.json",
      "/static/vite.config.mts",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });

  it("nom encodé décodé une seule fois", async () => {
    const r = await app.inject({ method: "GET", url: "/static/js/a%20b%25.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("1");
  });

  it("HEAD sans corps ; autre méthode : 405 sans Allow, comme StaticFiles", async () => {
    const r = await app.inject({ method: "HEAD", url: "/static/logo.png" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.body).toBe("");
    for (const method of ["POST", "TRACE", "PROPFIND", "DELETE"]) {
      const p = await app.inject({
        method: method as "POST",
        url: "/static/logo.png",
        payload: "x".repeat(64),
      });
      expect([method, p.statusCode, p.headers["allow"], p.json()]).toEqual([
        method,
        405,
        undefined,
        { detail: "Method Not Allowed" },
      ]);
    }
  });

  it("absent, dossier, sortie du dossier : 404 au format detail", async () => {
    for (const url of [
      "/static/absent.js",
      "/static/js",
      "/static/js/",
      "/static/../secret.txt",
      "/static/%2e%2e/secret.txt",
    ]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json(), url).toEqual({ detail: "Not Found" });
    }
  });
});
