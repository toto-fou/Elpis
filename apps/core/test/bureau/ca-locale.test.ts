// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/ca-locale.test.ts — `GET /api/desktop/ca.crt`, seconde source de la CA des installeurs de l'agent : servie comme la FileResponse de Starlette (ETag, plages d'octets, 400 et 416, jamais de 304), publique, 404 sans CA ; `security.https.ca_file` pris sans `ELPIS_CA_FILE`. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependancesParDefaut } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleBureau } from "../../src/familles/bureau";
import { appTest } from "../aides";

const PEM = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n";
const URL_CA = "/api/desktop/ca.crt";

describe("CA locale servie par le bureau", () => {
  let app: FastifyInstance;
  let t: BaseDeTest;
  let dossier: string;
  let restaurer: () => void;
  const avant = process.env["ELPIS_CA_FILE"];

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-ca-locale-"));
    writeFileSync(path.join(dossier, "ca.crt"), PEM);
    writeFileSync(path.join(dossier, "config.json"), "{}");
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    app = await appTest({
      familles: [creerFamilleBureau({ base: t.base, auth: dependancesParDefaut(t.base) })],
      gardes: {
        session: () => {
          throw new HttpError(401, "not logged in");
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
    if (avant === undefined) delete process.env["ELPIS_CA_FILE"];
    else process.env["ELPIS_CA_FILE"] = avant;
    restaurer();
    invalidateConfigCache();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("sans session : ETag, plages d'octets, 400 et 416, jamais de 304", async () => {
    process.env["ELPIS_CA_FILE"] = path.join(dossier, "ca.crt");
    const complet = await app.inject({ method: "GET", url: URL_CA });
    const etag = complet.headers["etag"] as string;
    expect([complet.statusCode, complet.body, complet.headers["content-type"]]).toEqual([
      200,
      PEM,
      "application/x-pem-file",
    ]);
    expect(complet.headers["content-disposition"]).toBe('attachment; filename="ca.crt"');
    expect(complet.headers["accept-ranges"]).toBe("bytes");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(complet.headers["last-modified"]).toMatch(/GMT$/);
    const sous = await app.inject({ method: "GET", url: URL_CA, headers: { range: "bytes=2-6" } });
    expect([sous.statusCode, sous.body, sous.headers["content-range"]]).toEqual([
      206,
      PEM.slice(2, 7),
      `bytes 2-6/${PEM.length}`,
    ]);
    const meme = await app.inject({
      method: "GET",
      url: URL_CA,
      headers: { "if-none-match": etag, "if-modified-since": complet.headers["last-modified"] as string },
    });
    expect([meme.statusCode, meme.body]).toEqual([200, PEM]);
    const mal = await app.inject({ method: "GET", url: URL_CA, headers: { range: "bytes" } });
    expect([mal.statusCode, mal.body]).toEqual([400, "Malformed range header."]);
    const unite = await app.inject({ method: "GET", url: URL_CA, headers: { range: "octets=1" } });
    expect([unite.statusCode, unite.body]).toEqual([400, "Only support bytes range"]);
    const hors = await app.inject({
      method: "GET",
      url: URL_CA,
      headers: { range: `bytes=${PEM.length + 5}-` },
    });
    expect([hors.statusCode, hors.headers["content-range"]]).toEqual([416, `bytes */${PEM.length}`]);
  });

  it("CA absente : 404 dit ; sans ELPIS_CA_FILE, security.https.ca_file désigne la CA", async () => {
    process.env["ELPIS_CA_FILE"] = path.join(dossier, "absente.crt");
    const absente = await app.inject({ method: "GET", url: URL_CA });
    expect([absente.statusCode, absente.json()]).toEqual([
      404,
      { detail: "Aucune CA locale (HTTPS non déployé sur cette instance)." },
    ]);
    delete process.env["ELPIS_CA_FILE"];
    writeFileSync(
      path.join(dossier, "config.json"),
      JSON.stringify({ security: { https: { ca_file: path.join(dossier, "ca.crt") } } }),
    );
    invalidateConfigCache();
    const configuree = await app.inject({ method: "GET", url: URL_CA });
    expect([configuree.statusCode, configuree.body]).toEqual([200, PEM]);
  });
});
