// SPDX-License-Identifier: MIT
/** apps/core/test/routeur-starlette.test.ts — route introuvable comme Starlette : décision avant le corps, sous `inject`, cibles hors forme origine, CORS hors preflight, motifs refusés. */
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { DefinitionRoute, Famille } from "../src/routes";
import { appTest } from "./aides";
import { motifVersRegex } from "@elpis/http";

const route = (
  methode: DefinitionRoute["methode"],
  chemin: string,
  extra: Partial<DefinitionRoute> = {},
) => ({
  methode,
  chemin,
  processus: ["main"] as const,
  acces: "public" as const,
  traiter: () => ({ ok: chemin }),
  ...extra,
});

const FAMILLE: Famille = {
  nom: "routeur",
  routes: [
    route("GET", "/x"),
    route(["GET", "HEAD"], "/montage/*", { montage: true }),
    route("GET", "/m/*", { motifsStarlette: [/^\/m\/[^\n]*\/fin$/] }),
    route(["POST", "PUT"], "/bloque", { motifsStarlette: [] }),
    route("GET", "/bloque"),
  ],
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Requête brute (cible et corps octet pour octet) ; première ligne, en-têtes et corps de la réponse. */
function brute(
  port: number,
  tete: string,
  corps = "",
): Promise<{ ligne: string; entetes: string; corps: string }> {
  return new Promise((fin, echec) => {
    const s = connect(port, "127.0.0.1");
    let recu = "";
    s.on("data", (d) => (recu += d.toString("latin1")));
    s.on("error", echec);
    s.on("close", () => {
      const [entete = "", reste = ""] = recu.split("\r\n\r\n");
      fin({ ligne: entete.split("\r\n")[0] ?? "", entetes: entete.toLowerCase(), corps: reste });
    });
    s.write(`${tete}\r\nConnection: close\r\nContent-Length: ${corps.length}\r\n\r\n${corps}`);
  });
}

describe("routeur Starlette dans le socle", () => {
  it("sous app.inject : 307, schéma d'un mandataire local, et 405 + Allow", async () => {
    app = await appTest({ familles: [FAMILLE] });
    const r = await app.inject({ method: "GET", url: "/x/?a=1", headers: { host: "h" } });
    expect([r.statusCode, r.headers.location]).toEqual([307, "http://h/x?a=1"]);
    const p = await app.inject({
      method: "GET",
      url: "/x/",
      headers: { host: "h", "x-forwarded-proto": "https" },
    });
    expect([p.statusCode, p.headers.location]).toEqual([307, "https://h/x"]);
    const m = await app.inject({ method: "DELETE", url: "/x" });
    expect([m.statusCode, m.headers.allow, m.json()]).toEqual([405, "GET", { detail: "Method Not Allowed" }]);
  });

  it("chemin inconnu à longue suite de barres internes : 404 en temps linéaire, sans authentification", async () => {
    app = await appTest({ familles: [FAMILLE] });
    const debut = performance.now();
    const r = await app.inject({ method: "GET", url: `/a${"/".repeat(60_000)}b/` });
    expect(performance.now() - debut).toBeLessThan(1000);
    expect([r.statusCode, r.json()]).toEqual([404, { detail: "Not Found" }]);
  });

  it("décision prise avant la lecture du corps : jamais de 413 pour un 404, un 405 ou un 307", async () => {
    app = await appTest({ familles: [FAMILLE], limiteCorps: 16 });
    const gros = "x".repeat(4096);
    const cas: [string, string, number][] = [
      ["POST", "/inconnu", 404],
      ["POST", "/x", 405],
      ["POST", "/x/", 307],
      ["POST", "/montage/a", 405],
      ["POST", "/bloque", 405],
      ["PUT", "/m/a", 404],
      ["GET", "/m/a/fin/", 307],
    ];
    for (const [method, url, statut] of cas) {
      const r = await app.inject({
        method: method as "POST",
        url,
        payload: gros,
        headers: { "content-type": "text/plain" },
      });
      expect([method, url, r.statusCode]).toEqual([method, url, statut]);
    }
    const bloque = await app.inject({ method: "PUT", url: "/bloque", payload: gros });
    expect([bloque.headers.allow, bloque.json()]).toEqual(["GET", { detail: "Method Not Allowed" }]);
    const montage = await app.inject({ method: "POST", url: "/montage/a" });
    expect(montage.headers.allow).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/m/a/b/fin" })).json()).toEqual({ ok: "/m/*" });
    expect((await app.inject({ method: "GET", url: "/m/a" })).statusCode).toBe(404);
  });

  it("paramètre de chemin vide : gestionnaire global du socle, réponse du routeur Starlette inchangée (307, 404 JSON)", async () => {
    const vide: Famille = {
      nom: "vide",
      routes: [route("GET", "/p/:id"), route("GET", "/p"), route("GET", "/q/:id")],
    };
    app = await appTest({ familles: [vide] });
    const p = await app.inject({ method: "GET", url: "/p/?a=1", headers: { host: "h" } });
    expect([p.statusCode, p.headers.location]).toEqual([307, "http://h/p?a=1"]);
    const q = await app.inject({ method: "GET", url: "/q/" });
    expect([q.statusCode, q.headers["content-type"], q.json()]).toEqual([
      404,
      "application/json; charset=utf-8",
      { detail: "Not Found" },
    ]);
    expect((await app.inject({ method: "GET", url: "/q/1" })).json()).toEqual({ ok: "/q/:id" });
  });

  it("HEAD sans corps comme uvicorn, même sous app.inject : 405, 404, 307 et route déclarée ; longueur du corps gardée", async () => {
    app = await appTest({ familles: [FAMILLE] });
    const cas: [string, number, string | undefined, string][] = [
      ["/x", 405, "GET", "31"],
      ["/inconnu", 404, undefined, "22"],
      ["/x/", 307, undefined, "0"],
      ["/montage/a", 200, undefined, "19"],
    ];
    for (const [url, statut, allow, longueur] of cas) {
      const r = await app.inject({ method: "HEAD", url, headers: { host: "h" } });
      expect([url, r.statusCode, r.headers.allow, r.headers["content-length"], r.body]).toEqual([
        url,
        statut,
        allow,
        longueur,
        "",
      ]);
    }
    await app.listen({ port: 0, host: "127.0.0.1" });
    const brut = await brute((app.server.address() as AddressInfo).port, "HEAD /x HTTP/1.1\r\nHost: t");
    expect([brut.ligne, brut.entetes.includes("content-length: 31\r\n"), brut.corps]).toEqual([
      "HTTP/1.1 405 Method Not Allowed",
      true,
      "",
    ]);
  });

  it("cible hors forme origine (`*`, forme absolue sans chemin) : 404, jamais de 307", async () => {
    app = await appTest({ familles: [FAMILLE] });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    for (const tete of ["OPTIONS * HTTP/1.1\r\nHost: t", "GET http://t HTTP/1.1\r\nHost: t"]) {
      const r = await brute(port, tete);
      expect([tete, r.ligne, r.entetes.includes("location:")]).toEqual([
        tete,
        "HTTP/1.1 404 Not Found",
        false,
      ]);
    }
    const absolue = await brute(port, "GET http://autre/x/ HTTP/1.1\r\nHost: t");
    expect(absolue.ligne).toBe("HTTP/1.1 307 Temporary Redirect");
    expect(absolue.entetes).toContain("location: http://t/x\r\n");
  });

  it("CORS : seul un OPTIONS avec Origin et Access-Control-Request-Method est un preflight, le reste est routé", async () => {
    app = await appTest({ familles: [FAMILLE], corsOrigines: ["http://a"] });
    const nu = await app.inject({ method: "OPTIONS", url: "/x" });
    expect([nu.statusCode, nu.headers.allow]).toEqual([405, "GET"]);
    const origine = await app.inject({ method: "OPTIONS", url: "/x", headers: { origin: "http://a" } });
    expect([origine.statusCode, origine.headers["access-control-allow-origin"]]).toEqual([405, "http://a"]);
    const methode = await app.inject({
      method: "OPTIONS",
      url: "/x",
      headers: { "access-control-request-method": "GET" },
    });
    expect(methode.statusCode).toBe(405);
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/x",
      headers: { origin: "http://a", "access-control-request-method": "GET" },
    });
    expect([preflight.statusCode, preflight.body, preflight.headers["access-control-allow-origin"]]).toEqual([
      200,
      "OK",
      "http://a",
    ]);
    const inconnu = await app.inject({ method: "OPTIONS", url: "/inconnu/" });
    expect(inconnu.statusCode).toBe(404);
  });

  it("motif à paramètre facultatif refusé au montage ; ancres d'un paramètre regex retirées comme find-my-way", async () => {
    await expect(appTest({ familles: [{ nom: "f", routes: [route("GET", "/a/:x?")] }] })).rejects.toThrow(
      /paramètre facultatif/,
    );
    expect(motifVersRegex("/c/:id(^\\d+$)").test("/c/12")).toBe(true);
    expect(motifVersRegex("/c/:id(^\\d+$)").test("/c/1a")).toBe(false);
  });
});
