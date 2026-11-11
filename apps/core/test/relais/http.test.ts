// SPDX-License-Identifier: MIT
/** apps/core/test/relais/http.test.ts — relais HTTP de bout en bout : identité, refus, chemins, flux, contre-pression, fuites. */
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as requeteHttp } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import { creerIdentite, IDENTITY_HEADER, sign } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkPreviewToken, makePreviewToken } from "../../src/relais/apercu";
import { urlAmont } from "../../src/relais/chemins";
import { attendre, attendreQue, FauxToolhost, JETON, lignes, monterBanc } from "./aides";
import type { Banc } from "./aides";

interface Reponse {
  statut: number;
  entetes: IncomingHttpHeaders;
  brutes: string[];
  corps: Buffer;
}

/** Requête au chemin exact (aucune normalisation du client), connexion neuve. */
function brut(
  url: string,
  chemin: string,
  options: { methode?: string; entetes?: Record<string, string>; corps?: Buffer } = {},
): Promise<Reponse> {
  const entetes = { ...options.entetes };
  if (options.corps && !("transfer-encoding" in entetes))
    entetes["content-length"] ??= String(options.corps.length);
  return new Promise((fin, echec) => {
    const u = new URL(url);
    const r = requeteHttp(
      {
        host: u.hostname,
        port: u.port,
        method: options.methode ?? "GET",
        path: chemin,
        headers: entetes,
        agent: false,
      },
      (res) => {
        const morceaux: Buffer[] = [];
        res.on("data", (d: Buffer) => morceaux.push(d));
        res.on("end", () =>
          fin({
            statut: res.statusCode ?? 0,
            entetes: res.headers,
            brutes: res.rawHeaders,
            corps: Buffer.concat(morceaux),
          }),
        );
        res.on("error", echec);
      },
    );
    r.on("error", echec);
    r.end(options.corps);
  });
}

/** Requête dont on garde la réponse ouverte (lecture pilotée par le test). */
function ouvrir(url: string, chemin: string, entetes: Record<string, string>): Promise<IncomingMessage> {
  return new Promise((fin, echec) => {
    const u = new URL(url);
    const r = requeteHttp(
      { host: u.hostname, port: u.port, path: chemin, headers: entetes, agent: false },
      fin,
    );
    r.on("error", echec);
    r.end();
  });
}

const CORPS_400 = '{"detail": "chemin refus\\u00e9"}';

let banc: Banc;
let hote: FauxToolhost;
let cookie: string;

beforeEach(async () => {
  lignes.length = 0;
  hote = await new FauxToolhost().demarrer();
  banc = await monterBanc();
  banc.manifeste(
    { main: { url: hote.url, token: JETON, relay: true } },
    { strategy: "single", host: "main" },
  );
  cookie = await banc.connecter(1);
});

afterEach(async () => {
  await banc.fermer();
  await hote.arreter();
});

describe("relais HTTP : identité et en-têtes", () => {
  it("GET relayé : requête brute, enveloppe de la session, jeton de service, en-têtes du navigateur filtrés", async () => {
    const forgee = sign(creerIdentite({ user_id: 3, username: "chef", is_admin: true }), JETON);
    const direct = await brut(banc.url, "/api/terminal/sessions", { entetes: { cookie } });
    expect(direct.statut).toBe(200);
    expect(hote.requetes[0]?.entetes["x-forwarded-for"]).toBe("127.0.0.1");
    hote.requetes.length = 0;
    const r = await brut(banc.url, "/api/sandbox/tree?path=/work&x=%2e%2e", {
      entetes: {
        cookie,
        accept: "application/json",
        authorization: "Bearer navigateur",
        [IDENTITY_HEADER]: forgee,
        "x-forwarded-for": "6.6.6.6",
        origin: "http://elpis.lan",
        "accept-encoding": "gzip",
      },
    });
    expect(r.statut).toBe(200);
    expect(JSON.parse(r.corps.toString())).toMatchObject({
      url: "/api/sandbox/tree?path=/work&x=%2e%2e",
      uid: 1,
      nom: "alice",
      admin: false,
      profil: "bridge",
    });
    const vue = hote.requetes[0];
    expect(vue?.entetes.authorization).toBe(`Bearer ${JETON}`);
    expect(vue?.entetes.accept).toBe("application/json");
    expect(vue?.entetes["x-forwarded-for"]).toBe("6.6.6.6");
    for (const absent of ["cookie", "origin", "accept-encoding", "user-agent"])
      expect(vue?.entetes[absent]).toBeUndefined();
    expect(r.entetes["x-accel-buffering"]).toBe("no");
    expect(r.entetes["x-content-type-options"]).toBe("nosniff");
  });

  it("enveloppe : nom exact, admin plein seulement, profil forcé et son imposition, réglages illisibles → isolated", async () => {
    const attendus = [
      [3, { nom: "chef", admin: true, profil: "lan", impose: "lan" }],
      [5, { nom: "modo", admin: false, profil: "isolated", impose: "" }],
      [2, { nom: "bob", admin: false, profil: "isolated", impose: "" }],
      [1, { nom: "alice", admin: false, profil: "bridge", impose: "" }],
    ] as const;
    for (const [uid, attendu] of attendus) {
      const c = await banc.connecter(uid);
      const r = await brut(banc.url, "/api/terminal/sessions", { entetes: { cookie: c } });
      expect(JSON.parse(r.corps.toString())).toMatchObject({ uid, ...attendu });
    }
  });

  it("en-têtes de réponse : hop-by-hop retirés, Set-Cookie de l'hôte et de la session, Vary fusionné, sécurité si absente", async () => {
    banc.config["security"] = { session: { idle_timeout_sec: 600 } };
    hote.traitements.set("/api/sandbox/entetes", (_req, res) => {
      res.writeHead(201, [
        ["Set-Cookie", "a=1"],
        ["Set-Cookie", "b=2"],
        ["Vary", "Accept"],
        ["X-Frame-Options", "DENY"],
        ["X-Accel-Buffering", "yes"],
        ["Keep-Alive", "timeout=5"],
        ["Content-Type", "text/plain"],
        ["Content-Length", "2"],
      ]);
      res.end("ok");
    });
    const r = await brut(banc.url, "/api/sandbox/entetes", { entetes: { cookie } });
    expect(r.statut).toBe(201);
    expect(r.corps.toString()).toBe("ok");
    const cookies = r.entetes["set-cookie"] ?? [];
    expect(cookies.slice(0, 2)).toEqual(["a=1", "b=2"]);
    expect(cookies[2]).toMatch(/^mcpwebui_session=/u);
    expect(r.entetes.vary).toBe("Accept, Cookie");
    expect(r.entetes["x-frame-options"]).toBe("DENY");
    expect(r.entetes["x-content-type-options"]).toBe("nosniff");
    expect(r.entetes["x-accel-buffering"]).toBe("yes, no");
    expect(r.entetes["content-length"]).toBeUndefined();
    expect(r.entetes["transfer-encoding"]).toBe("chunked");
    expect(r.brutes.join("\n")).not.toContain("timeout=5");
  });

  it("statuts de l'hôte transmis tels quels ; HEAD sans corps", async () => {
    for (const statut of [204, 304, 404, 418, 500]) {
      hote.traitements.set("/api/sandbox/statut", (_req, res) => {
        res.writeHead(statut, { "content-type": "text/plain" });
        res.end(statut === 204 || statut === 304 ? undefined : `statut ${statut}`);
      });
      const r = await brut(banc.url, "/api/sandbox/statut", { entetes: { cookie } });
      expect(r.statut).toBe(statut);
    }
    const tete = await brut(banc.url, "/api/sandbox/tree", { methode: "HEAD", entetes: { cookie } });
    expect(tete.statut).toBe(200);
    expect(tete.corps.length).toBe(0);
    expect(hote.requetes.at(-1)?.methode).toBe("HEAD");
  });

  it("méthodes relayées ; corps transmis pour POST, PUT, PATCH, DELETE seulement", async () => {
    for (const methode of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await brut(banc.url, "/api/sandbox/save", {
        methode,
        corps: Buffer.from("abc"),
        entetes: { cookie, "content-type": "text/plain" },
      });
      const vu = JSON.parse(r.corps.toString()) as { methode: string; taille: number };
      expect([vu.methode, vu.taille]).toEqual([methode, methode === "OPTIONS" ? 0 : 3]);
    }
  });
});

describe("relais HTTP : refus au format du Python", () => {
  it("sans session, session révoquée, mot de passe à changer : 401 « not logged in »", async () => {
    await banc.base.base.run("INSERT INTO revoked_sessions(sid, revoked_at, user_id) VALUES ('sid-2', 0, 2)");
    const revoque = await banc.connecter(2);
    const neuf = await banc.connecter(4);
    const cas: Record<string, string>[] = [
      {},
      { cookie: revoque },
      { cookie: neuf },
      { cookie: "mcpwebui_session=forge.forge" },
    ];
    for (const entetes of cas) {
      const r = await brut(banc.url, "/api/sandbox/tree", { entetes });
      expect(r.statut).toBe(401);
      expect(r.corps.toString()).toBe('{"detail": "not logged in"}');
      expect(r.entetes["content-type"]).toBe("application/json; charset=utf-8");
    }
    expect(hote.requetes).toHaveLength(0);
  });

  it("CSRF : requête mutante cross-site portant le cookie → 403 de la garde, jamais convertie", async () => {
    const r = await brut(banc.url, "/api/sandbox/save", {
      methode: "POST",
      corps: Buffer.from("x"),
      entetes: { cookie, origin: "http://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(r.statut).toBe(403);
    expect(JSON.parse(r.corps.toString())).toEqual({ detail: "Requête cross-site refusée." });
    expect(hote.requetes).toHaveLength(0);
  });

  it("hôte absent, sans jeton, injoignable : 503, 503, 502 avec les messages du relais", async () => {
    banc.manifeste({});
    let r = await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie } });
    expect([r.statut, JSON.parse(r.corps.toString())]).toEqual([
      503,
      { detail: "aucun hôte d'outils déclaré : mcp.json › sandboxHosts" },
    ]);
    banc.manifeste({ main: { url: hote.url, relay: true } });
    r = await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie } });
    expect([r.statut, r.corps.toString()]).toEqual([
      503,
      '{"detail": "h\\u00f4te d\'outils sans jeton de service"}',
    ]);
    banc.manifeste({ main: { url: "http://127.0.0.1:1", token: JETON } });
    r = await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie } });
    expect(r.statut).toBe(502);
    expect(JSON.parse(r.corps.toString())).toEqual({
      detail: "L'hôte d'outils ne répond pas. Vérifiez qu'il tourne et que mcp.json pointe dessus.",
    });
    expect(lignes.some((l) => l.includes("[sandbox-relay] hôte main injoignable"))).toBe(true);
  });

  it("CORS de l'app (cors_origins) : jamais sur les chemins relayés, préflight laissé au relais comme en Python", async () => {
    await banc.fermer();
    banc = await monterBanc({}, { corsOrigines: ["http://outil.lan:3000"] });
    banc.manifeste({ main: { url: hote.url, token: JETON } });
    cookie = await banc.connecter(1);
    const origine = "http://outil.lan:3000";
    let r = await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie, origin: origine } });
    expect(r.statut).toBe(200);
    expect(Object.keys(r.entetes).filter((n) => n.startsWith("access-control-"))).toEqual([]);
    expect(String(r.entetes.vary)).not.toMatch(/origin/iu);
    const preflight = { origin: origine, "access-control-request-method": "POST" };
    r = await brut(banc.url, "/api/sandbox/save", { methode: "OPTIONS", entetes: preflight });
    expect([r.statut, r.corps.toString()]).toEqual([401, '{"detail": "not logged in"}']);
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const [jeton] = makePreviewToken(2);
      r = await brut(banc.url, `/api/sandbox/pvs/${jeton}/8000/`, { methode: "OPTIONS", entetes: preflight });
      expect([r.statut, hote.requetes.at(-1)?.methode]).toEqual([200, "OPTIONS"]);
    } finally {
      restaurer();
    }
    r = await brut(banc.url, "/test/connexion/1", { methode: "OPTIONS", entetes: preflight });
    expect([r.statut, r.corps.toString(), r.entetes["access-control-allow-origin"]]).toEqual([
      200,
      "OK",
      origine,
    ]);
    r = await brut(banc.url, "/api/sandbox/preview-token", { methode: "OPTIONS", entetes: preflight });
    expect([r.statut, r.entetes["access-control-allow-origin"]]).toEqual([200, origine]);
    r = await brut(banc.url, "/api/sandbox/preview-token", { entetes: { cookie, origin: origine } });
    expect([r.statut, r.entetes["access-control-allow-origin"]]).toEqual([200, origine]);
  });

  it("préfixes non relayés : 404 du core, rien ne part vers l'hôte", async () => {
    for (const chemin of [
      "/api/sandbox",
      "/api/sandboxx/a",
      "//api/sandbox/x",
      "/api/memory/ax/x",
      "/API/sandbox/x",
      "/internal/file-history/session",
    ]) {
      expect((await brut(banc.url, chemin, { entetes: { cookie } })).statut, chemin).toBe(404);
    }
    expect(hote.requetes).toHaveLength(0);
  });
});

describe("relais HTTP : chemins (traversée refusée)", () => {
  it.each([
    "/api/sandbox/..%2F..%2Fmcp",
    "/api/sandbox/..%2f..%2fmcp",
    "/api/sandbox/%2e%2e/%2e%2e/mcp",
    "/api/sandbox/%2E%2E/%2E%2E/manifest",
    "/api/sandbox/.%2e/x",
    "/api/sandbox/%2e./x",
    "/api/sandbox/%2e/x",
    "/api/sandbox/../mcp",
    "/api/sandbox/tree/..",
    "/api/sandbox/./tree",
    "/api/sandbox/tree/..%5C..%5Cmcp",
    "/api/sandbox/tree/..%5c..%5cmcp",
    "/api/sandbox/a\\b",
    "/api/sandbox/%2e%2e%2f",
    "/api/terminal/%2E%2E/sandbox/tree",
    "/ws/terminal/..",
    "/ws/terminal/%2e%2e?x=1",
    "/api/desktop/frame/../../manifest",
    "/api/playwright/screenshot/..%2Fx",
  ])("%s → 400, rien vers l'hôte", async (chemin) => {
    const r = await brut(banc.url, chemin, { entetes: { cookie } });
    expect([r.statut, r.corps.toString()]).toEqual([400, CORPS_400]);
    expect(hote.requetes).toHaveLength(0);
  });

  it("aperçu : traversée refusée aussi sans session", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const [jeton] = makePreviewToken(1);
      const r = await brut(banc.url, `/api/sandbox/pv/${jeton}/%2e%2e/%2e%2e/%2e%2e/manifest`);
      expect([r.statut, r.corps.toString()]).toEqual([400, CORPS_400]);
      expect(hote.requetes).toHaveLength(0);
    } finally {
      restaurer();
    }
  });

  it("aperçu : le chemin normalisé par URL garde le même préfixe et le même jeton", () => {
    const base = "http://hote:1";
    expect(urlAmont(base, "/api/sandbox/pv/1-2-ab/site/index.html", "x=1", true)?.href).toBe(
      "http://hote:1/api/sandbox/pv/1-2-ab/site/index.html?x=1",
    );
    expect(urlAmont(base, "/api/sandbox/pvs/1-2-ab", "", true)?.pathname).toBe("/api/sandbox/pvs/1-2-ab");
    for (const chemin of [
      "/api/sandbox/pv/1-2-ab/.\t./.\t./tree",
      "/api/sandbox/pv/1-2-ab/.\n./autre/x",
      "/api/sandbox/pvs/1-2-ab/.\r./.\r./pv/1-2-ab/x",
    ]) {
      expect(urlAmont(base, chemin, "", true)).toBeNull();
    }
    expect(urlAmont(base, "/api/sandbox/tree", "", true)).toBeNull();
  });

  it.each([
    ["/api/sandbox/serve/a%20b/c.txt", "/api/sandbox/serve/a%20b/c.txt"],
    ["/api/sandb%6Fx/tree", "/api/sandb%6Fx/tree"],
    ["/api/sandbox/%252e%252e/mcp", "/api/sandbox/%252e%252e/mcp"],
    ["/api/sandbox/%25%32%65%25%32%65/x", "/api/sandbox/%25%32%65%25%32%65/x"],
    ["/api/sandbox/a;b=c", "/api/sandbox/a;b=c"],
    ["/api/sandbox/..;/x", "/api/sandbox/..;/x"],
    ["/api/sandbox/%3F?q=%3F", "/api/sandbox/%3F?q=%3F"],
    ["/api/sandbox/%23x#frag", "/api/sandbox/%23x"],
    ["/api/sandbox/a?b=1#c", "/api/sandbox/a?b=1"],
    ["/api/sandbox/x?a=../b&c=%2F", "/api/sandbox/x?a=../b&c=%2F"],
    ["/api/sandbox/a%22b|c", "/api/sandbox/a%22b|c"],
    ['/api/sandbox/a"b', "/api/sandbox/a%22b"],
    ["/ws/terminalfoo", "/ws/terminalfoo"],
  ])("%s relayé tel quel : %s", async (chemin, attendu) => {
    const r = await brut(banc.url, chemin, { entetes: { cookie } });
    expect(r.statut).toBe(200);
    expect(hote.requetes.at(-1)?.url).toBe(attendu);
  });
});

describe("relais HTTP : corps et réponses en flux", () => {
  it("POST de 6 Mio : octets exacts, Content-Type et Content-Length relayés", async () => {
    const corps = randomBytes(6 * 1024 * 1024);
    const r = await brut(banc.url, "/api/sandbox/save", {
      methode: "POST",
      corps,
      entetes: { cookie, "content-type": "application/octet-stream", "content-length": String(corps.length) },
    });
    const vu = JSON.parse(r.corps.toString()) as { taille: number; empreinte: string };
    expect(vu).toMatchObject({
      taille: corps.length,
      empreinte: createHash("sha256").update(corps).digest("hex"),
    });
    expect(hote.requetes[0]?.entetes["content-type"]).toBe("application/octet-stream");
    expect(hote.requetes[0]?.entetes["content-length"]).toBe(String(corps.length));
  });

  it("corps jamais lu par le socle : relayé au-delà de la limite de corps de l'app", async () => {
    await banc.fermer();
    banc = await monterBanc({}, { limiteCorps: 1024 });
    banc.manifeste({ main: { url: hote.url, token: JETON } });
    cookie = await banc.connecter(1);
    const corps = randomBytes(256 * 1024);
    const r = await brut(banc.url, "/api/sandbox/upload", {
      methode: "PUT",
      corps,
      entetes: { cookie, "content-type": "application/json" },
    });
    expect(r.statut).toBe(200);
    expect(JSON.parse(r.corps.toString())).toMatchObject({ taille: corps.length });
  });

  it("corps envoyé en flux : l'hôte reçoit le début avant que le navigateur ait fini", async () => {
    let recuAvantFin = 0;
    let fini = false;
    hote.traitements.set("/api/sandbox/flux-entrant", async (req, res) => {
      for await (const m of req) {
        if (!fini) recuAvantFin += (m as Buffer).length;
      }
      res.end("ok");
    });
    const u = new URL(banc.url);
    const reponse = new Promise<number>((fin, echec) => {
      const r = requeteHttp(
        {
          host: u.hostname,
          port: u.port,
          method: "POST",
          path: "/api/sandbox/flux-entrant",
          headers: { cookie, "transfer-encoding": "chunked", "content-type": "application/octet-stream" },
          agent: false,
        },
        (res) => {
          res.resume();
          res.on("end", () => fin(res.statusCode ?? 0));
        },
      );
      r.on("error", echec);
      r.write(Buffer.alloc(64 * 1024, 1));
      void attendreQue(() => recuAvantFin > 0).then(() => {
        fini = true;
        r.end(Buffer.alloc(1024, 2));
      }, echec);
    });
    expect(await reponse).toBe(200);
    expect(recuAvantFin).toBeGreaterThan(0);
  });

  it("réponse en flux : en-têtes et premier événement reçus avant la fin de l'hôte", async () => {
    let terminer: () => void = () => undefined;
    hote.traitements.set("/api/sandbox/sse", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      terminer = () => res.end("data: 2\n\n");
    });
    const res = await ouvrir(banc.url, "/api/sandbox/sse", { cookie });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const premier = await new Promise<string>((fin) => res.once("data", (d: Buffer) => fin(d.toString())));
    expect(premier).toBe("data: 1\n\n");
    terminer();
    const reste: Buffer[] = [];
    for await (const m of res) reste.push(m as Buffer);
    expect(Buffer.concat(reste).toString()).toBe("data: 2\n\n");
  });

  it("contre-pression : un navigateur qui ne lit pas freine l'hôte (aucun tampon intégral)", async () => {
    const total = 48 * 1024 * 1024;
    let ecrit = 0;
    hote.traitements.set("/api/sandbox/gros", async (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const morceau = Buffer.alloc(64 * 1024, 7);
      while (ecrit < total && !res.destroyed) {
        ecrit += morceau.length;
        if (!res.write(morceau)) await new Promise((fin) => res.once("drain", fin));
      }
      res.end();
    });
    const res = await ouvrir(banc.url, "/api/sandbox/gros", { cookie });
    res.pause();
    await attendre(600);
    const ecritEnPause = ecrit;
    expect(ecritEnPause).toBeLessThan(total / 2);
    let lu = 0;
    for await (const m of res) lu += (m as Buffer).length;
    expect(lu).toBe(total);
  });

  it("navigateur parti en plein flux : la requête vers l'hôte est abandonnée", async () => {
    hote.traitements.set("/api/sandbox/sse", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
    });
    const res = await ouvrir(banc.url, "/api/sandbox/sse", { cookie });
    await new Promise((fin) => res.once("data", fin));
    res.destroy();
    await attendreQue(() => hote.requetes[0]?.fermee === true);
  });

  it("hôte coupé en plein flux : réponse coupée sans bloc final (le navigateur voit l'échec), journalisée", async () => {
    hote.traitements.set("/api/sandbox/coupe", (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write("debut", () => setTimeout(() => res.socket?.destroy(), 50));
    });
    const res = await ouvrir(banc.url, "/api/sandbox/coupe", { cookie });
    const recu: Buffer[] = [];
    res.on("data", (d: Buffer) => recu.push(d));
    res.on("error", () => undefined);
    await new Promise((fin) => res.on("close", fin));
    expect([res.statusCode, Buffer.concat(recu).toString(), res.complete]).toEqual([200, "debut", false]);
    await attendreQue(() => lignes.some((l) => l.includes("flux amont interrompu")));
  });

  it("navigateur parti pendant les lectures en base : rien ne part vers l'hôte", async () => {
    const base = banc.base.base as unknown as { get: (...a: unknown[]) => Promise<unknown> };
    const lire = base.get.bind(base);
    let liberer = (): void => undefined;
    const parti = new Promise<void>((ok) => (liberer = ok));
    base.get = async (...a) => {
      await parti;
      return lire(...a);
    };
    hote.traitements.set("/api/sandbox/muet", () => undefined);
    const u = new URL(banc.url);
    const r = requeteHttp({
      host: u.hostname,
      port: u.port,
      path: "/api/sandbox/muet",
      headers: { cookie },
      agent: false,
    });
    r.on("error", () => undefined);
    r.end();
    await attendre(100);
    r.destroy();
    await attendre(50);
    liberer();
    await attendre(400);
    expect(hote.requetes).toHaveLength(0);
    expect(hote.sockets.size).toBe(0);
  });

  it("arrêt du process : les flux SSE relayés se terminent proprement, l'hôte est libéré", async () => {
    hote.traitements.set("/api/sandbox/sse", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write("data: 1\n\n");
    });
    const res = await ouvrir(banc.url, "/api/sandbox/sse", { cookie });
    const fin = new Promise<string>((ok) => {
      const morceaux: Buffer[] = [];
      res.on("data", (d: Buffer) => morceaux.push(d));
      res.on("end", () => ok(Buffer.concat(morceaux).toString()));
    });
    await attendreQue(() => hote.requetes.length === 1);
    banc.arret.abort();
    expect(await fin).toBe("data: 1\n\n");
    await attendreQue(() => hote.requetes[0]?.fermee === true);
  });

  it("413 de l'hôte avant la fin de l'envoi (hôte qui vide le corps, comme uvicorn) : statut et corps relayés", async () => {
    hote.traitements.set("/api/sandbox/trop-gros", (req, res) => {
      res.writeHead(413, { "content-type": "application/json" });
      res.end('{"detail":"trop gros"}');
      req.resume();
    });
    const corps = randomBytes(8 * 1024 * 1024);
    const r = await brut(banc.url, "/api/sandbox/trop-gros", {
      methode: "POST",
      corps,
      entetes: { cookie, "content-type": "application/octet-stream" },
    });
    expect([r.statut, r.corps.toString()]).toEqual([413, '{"detail":"trop gros"}']);
  });

  it("type de média invalide ou vide : corps relayé tel quel, aucun 415 du core", async () => {
    for (const type of ["foo", ";", "a/b/c", ""]) {
      const r = await brut(banc.url, "/api/sandbox/upload", {
        methode: "POST",
        corps: Buffer.from("abc"),
        entetes: { cookie, "content-type": type },
      });
      expect([type, r.statut, JSON.parse(r.corps.toString()).taille]).toEqual([type, 200, 3]);
      expect(hote.requetes.at(-1)?.entetes["content-type"]).toBe(type);
    }
  });
});

describe("jeton d'aperçu signé par main", () => {
  it("GET /api/sandbox/preview-token : servi par main avec SON secret, jamais relayé, anti-cache", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-de-main" });
    try {
      for (const chemin of ["/api/sandbox/preview-token", "/api/sandbox/preview%2Dtoken?x=1"]) {
        const r = await brut(banc.url, chemin, { entetes: { cookie } });
        expect(r.statut, chemin).toBe(200);
        const corps = JSON.parse(r.corps.toString()) as { token: string; expires: number };
        expect(Object.keys(corps)).toEqual(["token", "expires"]);
        expect(checkPreviewToken(corps.token)).toBe(1);
        expect(checkPreviewToken(corps.token, { secret: "secret-de-l-hote" })).toBeNull();
        expect(corps.expires - Date.now() / 1000).toBeGreaterThan(3590);
        expect(r.entetes["cache-control"]).toBe("no-cache, no-store, must-revalidate");
        expect([r.entetes.pragma, r.entetes.expires]).toEqual(["no-cache", "0"]);
      }
      const tete = await brut(banc.url, "/api/sandbox/preview-token", {
        methode: "HEAD",
        entetes: { cookie },
      });
      expect([tete.statut, tete.entetes["allow"], tete.corps.length]).toEqual([405, "GET", 0]);
      expect(hote.requetes).toHaveLength(0);
    } finally {
      restaurer();
    }
  });

  it("jeton de main accepté sur pv/pvs (vérifié par main, identité relayée dans l'enveloppe)", async () => {
    const r = await brut(banc.url, "/api/sandbox/preview-token", { entetes: { cookie } });
    const { token } = JSON.parse(r.corps.toString()) as { token: string };
    const p = await brut(banc.url, `/api/sandbox/pvs/${token}/3000/index.html`);
    expect(JSON.parse(p.corps.toString())).toMatchObject({ uid: 1, nom: "alice" });
    expect(hote.requetes.map((v) => v.url)).toEqual([`/api/sandbox/pvs/${token}/3000/index.html`]);
  });

  it("refus de la garde de session tels quels (pas ceux du relais) ; autres méthodes : 405 de Starlette, rien vers l'hôte", async () => {
    let r = await brut(banc.url, "/api/sandbox/preview-token");
    expect([r.statut, r.corps.toString()]).toEqual([401, '{"detail":"not logged in"}']);
    r = await brut(banc.url, "/api/sandbox/preview-token", { entetes: { cookie: await banc.connecter(4) } });
    expect([r.statut, r.corps.toString()]).toEqual([403, '{"detail":"must_change_password"}']);
    for (const methode of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const entetes of [{}, { cookie }] as Record<string, string>[]) {
        r = await brut(banc.url, "/api/sandbox/preview-token", { methode, entetes, corps: Buffer.from("x") });
        expect([methode, r.statut, r.entetes["allow"], r.corps.toString()]).toEqual([
          methode,
          405,
          "GET",
          '{"detail":"Method Not Allowed"}',
        ]);
      }
    }
    expect(hote.requetes).toHaveLength(0);
  });
});

describe("relais HTTP : aperçus et placement", () => {
  it("pv/pvs : identité du jeton du chemin, cookie d'un autre compte ignoré ; jeton invalide → 403", async () => {
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const [jeton] = makePreviewToken(2);
      const r = await brut(banc.url, `/api/sandbox/pv/${jeton}/site/index.html`, { entetes: { cookie } });
      expect(JSON.parse(r.corps.toString())).toMatchObject({
        uid: 2,
        nom: "bob",
        url: `/api/sandbox/pv/${jeton}/site/index.html`,
      });
      const p = await brut(banc.url, `/api/sandbox/pvs/${jeton}/3000/api`, {
        methode: "POST",
        corps: Buffer.from("x"),
      });
      expect(JSON.parse(p.corps.toString())).toMatchObject({ uid: 2, methode: "POST", taille: 1 });
      const o = await brut(banc.url, `/api/sandbox/pvs/${jeton}/3000/`, { methode: "OPTIONS" });
      expect(JSON.parse(o.corps.toString())).toMatchObject({ uid: 2, methode: "OPTIONS" });
      for (const faux of ["7-1-faux", `${jeton}x`, "", "a-b-c"]) {
        const x = await brut(banc.url, `/api/sandbox/pv/${faux}/a.css`, { entetes: { cookie } });
        expect([x.statut, x.corps.toString()], faux).toEqual([
          403,
          '{"detail": "Aper\\u00e7u expir\\u00e9 : rechargez-le"}',
        ]);
      }
      const nonAscii = await brut(banc.url, `/api/sandbox/pv/${jeton.slice(0, -1)}%C3%A9/a`);
      expect(nonAscii.statut).toBe(500);
      expect(hote.requetes).toHaveLength(3);
    } finally {
      restaurer();
    }
  });

  it("placement by_user : premier passage affecté au moins chargé et enregistré, puis conservé", async () => {
    const autre = await new FauxToolhost().demarrer();
    try {
      await banc.base.base.run(
        "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (40, 'a', 0, 0), (41, 'a', 0, 0)",
      );
      banc.manifeste(
        { a: { url: hote.url, token: JETON }, b: { url: autre.url, token: JETON } },
        { strategy: "by_user", host: "a" },
      );
      await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie } });
      expect(autre.requetes).toHaveLength(1);
      expect(await banc.base.base.get("SELECT host_id FROM sandbox_placements WHERE user_id = 1")).toEqual({
        host_id: "b",
      });
      await banc.base.base.run(
        "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (42, 'b', 0, 0), (43, 'b', 0, 0)",
      );
      await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie } });
      expect([autre.requetes.length, hote.requetes.length]).toEqual([2, 0]);
    } finally {
      await autre.arreter();
    }
  });
});

describe("relais HTTP : ressources", () => {
  it("aucune connexion vers l'hôte ne survit à la fermeture de l'app", async () => {
    for (let i = 0; i < 5; i++) await brut(banc.url, "/api/sandbox/tree", { entetes: { cookie } });
    await banc.fermer();
    await attendreQue(() => hote.sockets.size === 0);
    banc = await monterBanc();
  });
});

describe("relais HTTP : session revalidée sur les flux SSE", () => {
  /** Hôte qui émet un événement toutes les 25 ms jusqu'à ce que le relais coupe. */
  const emettre =
    (type: string) =>
    (_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(200, { "content-type": type });
      const minuterie = setInterval(() => res.write("data: x\n\n"), 25);
      res.on("close", () => clearInterval(minuterie));
    };

  beforeEach(async () => {
    await banc.fermer();
    banc = await monterBanc({ revalidationMs: 100 });
    banc.manifeste({ main: { url: hote.url, token: JETON } });
    cookie = await banc.connecter(1);
    hote.traitements.set("/api/terminal/stream", emettre("text/event-stream"));
    hote.traitements.set("/api/sandbox/evenements", emettre("text/event-stream; charset=utf-8"));
    hote.traitements.set("/api/terminal/brut", emettre("application/octet-stream"));
  });

  const revoquer = (): Promise<unknown> =>
    banc.base.base.run("INSERT INTO revoked_sessions(sid, user_id, revoked_at) VALUES ('sid-1', 1, 0)");

  /** Ouvre le flux, lance `pendant` une fois les en-têtes reçus, puis lit jusqu'à la fin ou au délai (flux alors coupé). */
  async function lire(
    chemin: string,
    entetes: Record<string, string>,
    delaiMs: number,
    pendant: () => Promise<unknown> = async () => undefined,
  ) {
    const res = await ouvrir(banc.url, chemin, entetes);
    const morceaux: Buffer[] = [];
    res.on("data", (d: Buffer) => morceaux.push(d));
    const fin = new Promise<boolean>((ok) => res.on("end", () => ok(true)));
    await pendant();
    const fini = await Promise.race([fin, attendre(delaiMs).then(() => false)]);
    if (!fini) res.destroy();
    return { fini, complet: res.complete, corps: Buffer.concat(morceaux).toString() };
  }

  it("terminal : session révoquée → [SESSION_EXPIRED] puis fin propre, la requête vers l'hôte est close", async () => {
    const r = await lire("/api/terminal/stream", { cookie }, 3_000, revoquer);
    expect([r.fini, r.complet]).toEqual([true, true]);
    expect(r.corps.startsWith("data: x\n\n")).toBe(true);
    expect(r.corps.endsWith("data: x\n\ndata: [SESSION_EXPIRED]\n\n")).toBe(true);
    await attendreQue(() => hote.requetes[0]?.fermee === true);
  });

  it("autre flux SSE relayé : fin propre sans marqueur", async () => {
    const r = await lire("/api/sandbox/evenements", { cookie }, 3_000, revoquer);
    expect([r.fini, r.complet]).toEqual([true, true]);
    expect(r.corps).toMatch(/^(data: x\n\n)+$/u);
  });

  it("session valide, aperçu et réponse qui n'est pas un flux SSE : jamais coupés par la revalidation", async () => {
    let r = await lire("/api/terminal/stream", { cookie }, 450);
    expect([r.fini, r.corps.split("data: x").length > 8]).toEqual([false, true]);
    r = await lire("/api/terminal/brut", { cookie }, 450, revoquer);
    expect([r.fini, r.corps.includes("SESSION_EXPIRED"), r.corps.split("data: x").length > 8]).toEqual([
      false,
      false,
      true,
    ]);
    const restaurer = surchargerConfig({ SESSION_SECRET: "secret-apercu" });
    try {
      const [jeton] = makePreviewToken(2);
      hote.traitements.set(`/api/sandbox/pvs/${jeton}/3000/sse`, emettre("text/event-stream"));
      r = await lire(`/api/sandbox/pvs/${jeton}/3000/sse`, {}, 450);
      expect([r.fini, r.corps.split("data: x").length > 8]).toEqual([false, true]);
    } finally {
      restaurer();
    }
  });
});

describe("relais HTTP : choix du bac à sable enregistré par main", () => {
  let dossier = "";
  let restaurer: () => void = () => undefined;
  let reponseHote: { statut: number; corps: unknown; entetes?: Record<string, string> } = {
    statut: 200,
    corps: {},
  };

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-choix-"));
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({
        executors: {
          network_profiles: [
            { id: "lan", name: "LAN", mode: "allowlist_ip" },
            { id: "bridge", name: "Ouvert", mode: "bridge" },
            { id: "Bad", name: "Ignoré" },
          ],
        },
      }),
    );
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    hote.traitements.set("/api/sandbox/me", repondreMe);
    hote.traitements.set("/api/sandbox/m%65", repondreMe);
  });

  async function repondreMe(
    req: IncomingMessage,
    res: ServerResponse,
    vue: { corps: Buffer },
  ): Promise<void> {
    for await (const m of req) vue.corps = Buffer.concat([vue.corps, m as Buffer]);
    res.writeHead(reponseHote.statut, { "content-type": "application/json", ...reponseHote.entetes });
    res.end(JSON.stringify(reponseHote.corps));
  }

  afterEach(() => {
    restaurer();
    rmSync(dossier, { recursive: true, force: true });
  });

  async function reglages(uid: number): Promise<unknown> {
    const r = await banc.base.base.get<{ settings_json: string | null }>(
      "SELECT settings_json FROM users WHERE id = ?",
      [uid],
    );
    return r?.settings_json ? JSON.parse(r.settings_json) : null;
  }

  function poster(chemin: string, c = cookie): Promise<Reponse> {
    return brut(banc.url, chemin, {
      methode: "POST",
      corps: Buffer.from('{"network_profile_id": "lan"}'),
      entetes: { cookie: c, "content-type": "application/json" },
    });
  }

  it("POST /api/sandbox/me réussi : mode et profil appliqués par l'hôte enregistrés, l'enveloppe suivante les porte", async () => {
    reponseHote = {
      statut: 200,
      corps: { ok: true, mode: "docker", network_profile_id: "lan", bootstrap: {} },
    };
    const r = await poster("/api/sandbox/me");
    expect([r.statut, JSON.parse(r.corps.toString())]).toEqual([200, reponseHote.corps]);
    expect([r.entetes["content-type"], r.entetes["x-accel-buffering"]]).toEqual(["application/json", "no"]);
    expect(hote.requetes[0]?.corps.toString()).toBe('{"network_profile_id": "lan"}');
    expect(await reglages(1)).toEqual({ network_profile_id: "lan", sandbox_mode: "docker" });
    const suivante = await brut(banc.url, "/api/terminal/sessions", { entetes: { cookie } });
    expect(JSON.parse(suivante.corps.toString())).toMatchObject({ uid: 1, profil: "lan" });
    for (const chemin of ["/api/sandbox/m%65?x=1", "/api/sandbox/me?y=2"]) {
      reponseHote.corps = { ok: true, mode: "docker", network_profile_id: "bridge" };
      await poster(chemin);
      expect(await reglages(1), chemin).toMatchObject({ network_profile_id: "bridge" });
      await banc.base.base.run("UPDATE users SET settings_json = ? WHERE id = 1", [
        '{"network_profile_id": "lan"}',
      ]);
    }
  });

  it.each([
    ["profil inconnu de la configuration", 200, { ok: true, mode: "docker", network_profile_id: "inconnu" }],
    ["profil ignoré à la lecture", 200, { ok: true, mode: "docker", network_profile_id: "Bad" }],
    ["échec de l'hôte", 200, { ok: false, mode: "docker", network_profile_id: "lan" }],
    ["refus de l'hôte", 400, { detail: "Profil réseau introuvable" }],
    ["profil qui n'est pas un texte", 200, { ok: true, mode: "docker", network_profile_id: 5 }],
    ["mode autre que docker", 200, { ok: true, mode: "folder", network_profile_id: "lan" }],
    ["corps qui n'est pas un objet", 200, ["ok"]],
  ])("rien n'est enregistré : %s ; réponse relayée telle quelle", async (_nom, statut, corps) => {
    reponseHote = { statut, corps };
    const r = await poster("/api/sandbox/me");
    expect([r.statut, JSON.parse(r.corps.toString())]).toEqual([statut, corps]);
    expect(await reglages(1)).toEqual({ network_profile_id: "bridge" });
  });

  it("profil imposé par l'administrateur : garde la main, sauf s'il n'existe plus dans la configuration", async () => {
    const chef = await banc.connecter(3);
    reponseHote = { statut: 200, corps: { ok: true, mode: "docker", network_profile_id: "bridge" } };
    await poster("/api/sandbox/me", chef);
    expect(await reglages(3)).toEqual({ forced_network_profile_id: "lan", network_profile_id: "bridge" });
    expect(lignes.some((l) => l.includes("profil 'bridge' de l'hôte non enregistré (uid=3)"))).toBe(true);
    await banc.base.base.run("UPDATE users SET settings_json = ? WHERE id = 3", [
      '{"forced_network_profile_id": "disparu", "network_profile_id": "lan"}',
    ]);
    await poster("/api/sandbox/me", chef);
    expect(await reglages(3)).toEqual({
      forced_network_profile_id: "disparu",
      network_profile_id: "bridge",
      sandbox_mode: "docker",
    });
  });

  it("réponse compressée, autre chemin ou autre méthode : rien n'est enregistré", async () => {
    reponseHote = {
      statut: 200,
      corps: { ok: true, mode: "docker", network_profile_id: "lan" },
      entetes: { "content-encoding": "identity" },
    };
    await poster("/api/sandbox/me");
    reponseHote = { statut: 200, corps: { ok: true, mode: "docker", network_profile_id: "lan" } };
    hote.traitements.set("/api/sandbox/me/", repondreMe);
    await poster("/api/sandbox/me/");
    await brut(banc.url, "/api/sandbox/me", {
      methode: "PUT",
      entetes: { cookie },
      corps: Buffer.from("{}"),
    });
    await brut(banc.url, "/api/sandbox/me", { entetes: { cookie } });
    expect(hote.requetes.map((v) => v.methode)).toEqual(["POST", "POST", "PUT", "GET"]);
    expect(await reglages(1)).toEqual({ network_profile_id: "bridge" });
  });

  it("navigateur parti avant la réponse de l'hôte : le choix appliqué est quand même enregistré", async () => {
    let repondre: () => void = () => undefined;
    hote.traitements.set("/api/sandbox/me", (req, res) => {
      req.resume();
      repondre = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok": true, "mode": "docker", "network_profile_id": "lan"}');
      };
    });
    const u = new URL(banc.url);
    const r = requeteHttp({
      host: u.hostname,
      port: u.port,
      method: "POST",
      path: "/api/sandbox/me",
      headers: { cookie, "content-type": "application/json", "content-length": "2" },
      agent: false,
    });
    r.on("error", () => undefined);
    r.end("{}");
    await attendreQue(() => hote.requetes.length === 1);
    r.destroy();
    await attendre(100);
    repondre();
    const limite = Date.now() + 3_000;
    while (Date.now() < limite && !JSON.stringify(await reglages(1)).includes("docker")) await attendre(20);
    expect(await reglages(1)).toEqual({ network_profile_id: "lan", sandbox_mode: "docker" });
  });

  it("réglages trop imbriqués pour le lecteur fidèle : écriture annulée, imposition et autres réglages intacts", async () => {
    const profond = `{"forced_network_profile_id": "lan", "network_profile_id": "lan", "editor_ratio": ${"[".repeat(10_000)}${"]".repeat(10_000)}}`;
    await banc.base.base.run("UPDATE users SET settings_json = ? WHERE id = 3", [profond]);
    const chef = await banc.connecter(3);
    for (const profil of ["lan", "bridge"]) {
      reponseHote = { statut: 200, corps: { ok: true, mode: "docker", network_profile_id: profil } };
      expect((await poster("/api/sandbox/me", chef)).statut).toBe(200);
      const ligne = await banc.base.base.get<{ s: string }>(
        "SELECT settings_json AS s FROM users WHERE id = 3",
      );
      expect(ligne?.s === profond, profil).toBe(true);
    }
    expect(
      lignes.some((l) => l.includes("choix du bac à sable non enregistré (uid=3) : RecursionError(")),
    ).toBe(true);
    const suivante = await brut(banc.url, "/api/terminal/sessions", { entetes: { cookie: chef } });
    expect(JSON.parse(suivante.corps.toString())).toMatchObject({ profil: "lan" });
  });

  it("réglages illisibles : remplacés par le choix, comme merge_user_settings", async () => {
    reponseHote = { statut: 200, corps: { ok: true, mode: "docker", network_profile_id: "lan" } };
    await poster("/api/sandbox/me", await banc.connecter(5));
    expect(await reglages(5)).toEqual({ sandbox_mode: "docker", network_profile_id: "lan" });
  });

  it("réponse autre que 200 et navigateur parti : la requête vers l'hôte est coupée", async () => {
    hote.traitements.set("/api/sandbox/me", (req, res) => {
      req.resume();
      res.writeHead(400, { "content-type": "application/json" });
      res.write('{"detail": ');
    });
    const u = new URL(banc.url);
    const reponse = await new Promise<IncomingMessage>((fin, echec) => {
      const r = requeteHttp(
        {
          host: u.hostname,
          port: u.port,
          method: "POST",
          path: "/api/sandbox/me",
          headers: { cookie, "content-type": "application/json", "content-length": "2" },
          agent: false,
        },
        fin,
      );
      r.on("error", echec);
      r.end("{}");
    });
    expect(reponse.statusCode).toBe(400);
    reponse.destroy();
    await attendreQue(() => hote.requetes[0]?.fermee === true);
  });

  it("hôte coupé pendant la réponse : 502 « n'a pas fini de répondre », rien n'est enregistré", async () => {
    hote.traitements.set("/api/sandbox/me", (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.write('{"ok": true, "mode": "dock', () => setTimeout(() => res.socket?.destroy(), 30));
    });
    const r = await poster("/api/sandbox/me");
    expect([r.statut, JSON.parse(r.corps.toString())]).toEqual([
      502,
      { detail: "L'hôte d'outils n'a pas fini de répondre." },
    ]);
    expect(await reglages(1)).toEqual({ network_profile_id: "bridge" });
    expect(lignes.some((l) => l.includes("réponse amont interrompue"))).toBe(true);
  });
});
