// SPDX-License-Identifier: MIT
/** apps/core/test/http/cors.test.ts — CORS optionnel (`app.cors_origins`) rejoué contre le CORSMiddleware de Starlette réglé comme server/app.py : statut, corps et en-têtes CORS exacts. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { composer } from "../../src/composition";
import { installerCrochetJournal } from "../../src/journal";
import { installerRelaisModeles } from "../../src/llm/cache-modeles";
import { installerDiffusion } from "../../src/llm/ports";
import type { DefinitionRoute } from "../../src/routes";
import { appTest, journalMuet } from "../aides";
import { dependancesAuth } from "../exploitation/aides";

const V = JSON.parse(readFileSync(new URL("../vecteurs/http_cors.json", import.meta.url), "utf-8")) as {
  requetes: [string, string, string, [string, string][]][];
  configs: Record<
    string,
    { origines: string[]; reponses: { statut: number; corps: string; entetes: [string, string][] }[] }
  >;
};

/** En-têtes du contrat CORS ; `content-type` seulement sur les réponses du middleware (préflights). */
const CONTRAT = (nom: string, preflight: boolean): boolean =>
  nom.startsWith("access-control-") ||
  nom === "vary" ||
  nom === "allow" ||
  (preflight && nom === "content-type");

const essai = (): DefinitionRoute[] => {
  const r = (
    methode: "GET" | "POST",
    chemin: string,
    traiter: DefinitionRoute["traiter"],
  ): DefinitionRoute => ({
    methode,
    chemin,
    processus: ["main"],
    acces: "public",
    traiter,
  });
  return [
    r("GET", "/api/x", async () => ({ ok: true })),
    r("POST", "/api/x", async () => ({ ok: true })),
    r("GET", "/api/vary", async (_req, rep) => rep.header("vary", "Accept-Encoding").send({})),
    r("GET", "/api/vary2", async (_req, rep) => rep.header("vary", ["Accept-Encoding", "Cookie"]).send({})),
    r("GET", "/api/panne", async () => {
      throw new Error("panne");
    }),
    r("GET", "/api/refus", async () => {
      throw new HttpError(401, "not logged in");
    }),
  ];
};

/** Requête HTTP/1.1 écrite à la main (doublons d'en-têtes gardés, que `inject` fusionne) ; statut, en-têtes et corps. */
function brut(
  port: number,
  methode: string,
  chemin: string,
  paires: [string, string][],
): Promise<{ statut: number; entetes: [string, string][]; corps: string }> {
  return new Promise((fini, echec) => {
    const s = connect(port, "127.0.0.1", () => {
      const lignes = [
        `${methode} ${chemin} HTTP/1.1`,
        "Host: lan.test",
        ...paires.map(([k, v]) => `${k}: ${v}`),
      ];
      s.end(`${lignes.join("\r\n")}\r\nConnection: close\r\n\r\n`);
    });
    const morceaux: Buffer[] = [];
    s.on("data", (m: Buffer) => morceaux.push(m));
    s.on("error", echec);
    s.on("close", () => {
      const texte = Buffer.concat(morceaux).toString("latin1");
      const fin = texte.indexOf("\r\n\r\n");
      const [ligne = "", ...autres] = texte.slice(0, fin).split("\r\n");
      const entetes = autres.map((l) => {
        const deux = l.indexOf(":");
        return [l.slice(0, deux).toLowerCase(), l.slice(deux + 1).trim()] as [string, string];
      });
      fini({ statut: Number(ligne.split(" ")[1]), entetes, corps: texte.slice(fin + 4) });
    });
  });
}

describe.each(Object.entries(V.configs))("CORS %s", (_nom, config) => {
  let app: FastifyInstance | undefined;
  let port = 0;
  beforeAll(async () => {
    app = await appTest({ familles: [{ nom: "essai", routes: essai() }], corsOrigines: config.origines });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(V.requetes.map((r, i) => [r[0], i] as const))("%s", async (_n, i) => {
    const [, method, url, paires] = V.requetes[i] as [string, string, string, [string, string][]];
    const attendue = config.reponses[i] as (typeof config.reponses)[number];
    const rep = await brut(port, method, url, paires);
    const preflight = method === "OPTIONS" && paires.some(([k]) => k === "access-control-request-method");
    expect({
      statut: rep.statut,
      corps: preflight ? rep.corps : "",
      entetes: rep.entetes.filter(([k]) => CONTRAT(k, preflight)).sort(),
    }).toEqual({
      statut: attendue.statut,
      corps: preflight ? attendue.corps : "",
      entetes: attendue.entetes.filter(([k]) => CONTRAT(k, preflight)),
    });
  });

  it("poignée de main WebSocket avec Origin : hors CORS (Starlette ignore les scopes websocket)", async () => {
    const rep = await (app as FastifyInstance).inject({
      method: "GET",
      url: "/api/x",
      headers: {
        origin: "http://outil.lan:3000",
        connection: "Upgrade",
        upgrade: "WebSocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(Object.keys(rep.headers).filter((k) => k.startsWith("access-control-") || k === "vary")).toEqual(
      [],
    );
  });
});

describe("CORS dans la composition de main (ordre des middlewares de server/app.py : CORS au plus près des routes)", () => {
  let dossier: string;
  let app: FastifyInstance | undefined;
  let fermer: (() => Promise<void>) | undefined;
  let restaurer: (() => void) | undefined;

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-cors-"));
    writeFileSync(join(dossier, "config.json"), "{}");
    vi.stubEnv("ELPIS_AUDIT_DIR", join(dossier, "audit"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    const t = ouvrirBaseDeTest("sqlite");
    fermer = () => t.fermer();
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mot-de-passe-cors-1");
    const c = await composer("main", t.base, journalMuet, dependancesAuth(t.base), dossier);
    fermer = async () => {
      c.evenements.systemEvents.fermer({ type: "fin" });
      await t.fermer();
    };
    app = await appTest({ ...c, mode: "main", corsOrigines: ["http://outil.lan:3000"] });
  });

  afterAll(async () => {
    await app?.close();
    await fermer?.();
    restaurer?.();
    vi.unstubAllEnvs();
    oublierConfigurationAudit();
    installerCrochetJournal(null);
    installerDiffusion(null);
    installerRelaisModeles(null);
    rmSync(dossier, { recursive: true, force: true });
  });

  it("refus CSRF sans en-tête CORS (CsrfGuard au-dessus) ; route lisant la session : Vary « Origin, Cookie »", async () => {
    const a = app as FastifyInstance;
    const origine = "http://outil.lan:3000";
    const connexion = await a.inject({
      method: "POST",
      url: "/api/login-lite",
      headers: { host: "lan.test", origin: "http://lan.test" },
      payload: { username: "alice", password: "mot-de-passe-cors-1" },
    });
    const cookie = String(connexion.headers["set-cookie"]).split(";")[0] ?? "";
    const lue = await a.inject({ method: "GET", url: "/api/me-lite", headers: { origin: origine, cookie } });
    expect([lue.statusCode, lue.headers["access-control-allow-origin"], lue.headers.vary]).toEqual([
      200,
      origine,
      "Origin, Cookie",
    ]);
    const refus = await a.inject({
      method: "POST",
      url: "/api/logout-lite",
      headers: { host: "lan.test", origin: origine, cookie },
    });
    expect(refus.statusCode).toBe(403);
    expect(Object.keys(refus.headers).filter((k) => k.startsWith("access-control-") || k === "vary")).toEqual(
      [],
    );
  });
});
