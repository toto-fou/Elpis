// SPDX-License-Identifier: MIT
/** apps/toolhost/test/mandataire-apercu.test.ts — mandataire d'aperçu de l'hôte : cible comme httpx, en-têtes filtrés, Location, pages 409/502, CORS de pvs, corps borné, flux coupé, aucune connexion laissée. */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerAppToolhost } from "../src/app";
import {
  cibleAmont,
  CORPS_MAX,
  creerFamilleMandataireApercu,
  requeteStarlette,
} from "../src/mandataire-apercu";
import type { IpConteneurApercu } from "@elpis/bac";
import { configTest, entetes, journalMuet } from "./aides";

describe("cible amont construite comme httpx", () => {
  it("requête de Starlette ; encodage du chemin et de la requête, `?` et `#` du chemin décodé, segments `.`/`..`, `%` gardé", () => {
    for (const [chemin, requete, cible] of [
      ["", "", "/"],
      ["a b/c", "", "/a%20b/c"],
      ["x?y", "q=1", "/x?y?q=1"],
      ["a#frag", "q=1", "/a"],
      ["./a/../b", "", "/b"],
      ["../../etc", "", "/etc"],
      ['é`{}"<>', "", "/%C3%A9%60%7B%7D%22%3C%3E"],
      ["a|b^c\\d[e]@f:g", "", "/a|b^c\\d[e]@f:g"],
      ["%41%zz", "a=%20&b=<'>", "/%41%zz?a=%20&b=%3C'%3E"],
      ["x", "a=é", "/x?a=%C3%A9"],
    ] as const)
      expect(cibleAmont(chemin, requete), `${chemin} ? ${requete}`).toBe(cible);
    expect(requeteStarlette("/p/a?b", "q=1")).toBe("b?q=1");
    expect(requeteStarlette("/p/a#b", "q=1")).toBe("");
    expect(requeteStarlette("/p/a", "q=%C3%A9\u00c3\u00a9")).toBe("q=%C3%A9é");
    expect(() => cibleAmont("a\tb", "")).toThrow("non-printable");
    expect(() => cibleAmont("a\x7f", "")).toThrow("non-printable");
  });
});

describe("mandataire d'aperçu", () => {
  let amont: Server;
  let portAmont = 0;
  const recues: { methode: string; cible: string; entetes: IncomingMessage["headers"]; corps: number }[] = [];
  let ip: string | null = "127.0.0.1";
  const oublis: number[] = [];
  const port: IpConteneurApercu = {
    ip: () => Promise.resolve(ip),
    oublier: (uid) => void oublis.push(uid),
  };
  let app: FastifyInstance;

  function servir(req: IncomingMessage, rep: ServerResponse): void {
    const cible = req.url ?? "";
    if (cible.startsWith("/redirige")) {
      rep.writeHead(302, { location: `http://127.0.0.1:${portAmont}/ailleurs?x=1` }).end();
      return;
    }
    if (cible.startsWith("/relatif")) {
      rep.writeHead(301, { location: "/autre" }).end();
      return;
    }
    if (cible.startsWith("/statut999")) {
      rep.writeHead(999, { "content-type": "text/plain" });
      rep.write("début sans fin");
      return;
    }
    if (cible.startsWith("/flux")) {
      rep.writeHead(200, { "content-type": "text/event-stream" });
      rep.write("data: 1\n\n");
      setTimeout(() => rep.destroy(), 50);
      return;
    }
    rep.writeHead(201, [
      "content-type",
      "text/html",
      "set-cookie",
      "session=vole; Path=/",
      "content-security-policy",
      "default-src *",
      "access-control-allow-origin",
      "https://ailleurs",
      "cache-control",
      "max-age=60",
      "x-propre",
      "a",
      "x-propre",
      "b",
      "alt-svc",
      'h2=":443"',
      "accept-ch",
      "Sec-CH-UA",
      "critical-ch",
      "Sec-CH-UA",
      "set-login",
      "logged-in",
      "nel",
      '{"report_to":"x"}',
    ]);
    rep.end("<p>ok</p>");
  }

  beforeAll(async () => {
    amont = createServer((req, rep) => {
      let corps = 0;
      req.on("data", (m: Buffer) => (corps += m.length));
      req.on("end", () => {
        recues.push({ methode: req.method ?? "", cible: req.url ?? "", entetes: req.headers, corps });
        servir(req, rep);
      });
    });
    await new Promise<void>((fin) => amont.listen(0, "127.0.0.1", fin));
    portAmont = (amont.address() as AddressInfo).port;
    app = await creerAppToolhost({
      tc: configTest(),
      familles: [creerFamilleMandataireApercu({ journal: journalMuet, ipConteneur: port })],
      journal: journalMuet,
    });
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((fin) => amont.close(() => fin()));
  });

  const pvs = (reste: string): string =>
    `/api/sandbox/pvs/7-1-0123456789abcdef0123456789abcdef/${portAmont}/${reste}`;

  it("pvs : statut et corps relayés, en-têtes réseau retirés, origine opaque imposée, seuls les en-têtes sûrs transmis", async () => {
    recues.length = 0;
    const r = await app.inject({
      url: pvs("dossier/page%201.html?a=1&b=%2F"),
      headers: {
        ...entetes(),
        cookie: "session=secrete",
        accept: "text/html",
        "accept-language": "fr",
        "x-autre": "non",
        range: "bytes=0-3",
      },
    });
    expect([r.statusCode, r.body]).toEqual([201, "<p>ok</p>"]);
    expect(r.headers).toMatchObject({
      "content-type": "text/html",
      "content-security-policy": "sandbox allow-scripts allow-forms",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "access-control-allow-origin": "*",
      "x-propre": "a, b",
    });
    for (const retire of ["set-cookie", "alt-svc", "accept-ch", "critical-ch", "set-login", "nel"])
      expect(r.headers[retire], retire).toBeUndefined();
    expect(recues).toHaveLength(1);
    const [vue] = recues;
    expect(vue?.cible).toBe("/dossier/page%201.html?a=1&b=%2F");
    expect(vue?.entetes).toMatchObject({
      accept: "text/html",
      "accept-language": "fr",
      range: "bytes=0-3",
      "accept-encoding": "gzip, deflate",
    });
    for (const absent of ["cookie", "authorization", "x-autre", "x-elpis-identity"])
      expect(vue?.entetes[absent], absent).toBeUndefined();
  });

  it("preview : sans CORS ; Location absolue de l'amont ou absolue-chemin ramenée sous le préfixe", async () => {
    const a = await app.inject({ url: `/api/sandbox/preview/0${portAmont}/redirige`, headers: entetes() });
    expect([a.statusCode, a.headers.location]).toEqual([
      302,
      `/api/sandbox/preview/${portAmont}/ailleurs?x=1`,
    ]);
    expect(a.headers["access-control-allow-origin"]).toBeUndefined();
    const b = await app.inject({ url: pvs("relatif"), headers: entetes() });
    expect([b.statusCode, b.headers.location]).toEqual([
      301,
      `/api/sandbox/pvs/7-1-0123456789abcdef0123456789abcdef/${portAmont}/autre`,
    ]);
  });

  it("port : 422 s'il n'est pas entier, 400 hors 1..65535 ; OPTIONS de pvs : 204 et CORS sans contrôle de plage", async () => {
    const e = await app.inject({ url: "/api/sandbox/preview/abc/x", headers: entetes() });
    expect([
      e.statusCode,
      (e.json() as { detail: { type: string; loc: string[] }[] }).detail[0],
    ]).toMatchObject([422, { type: "int_parsing", loc: ["path", "port"] }]);
    for (const p of ["0", "65536", "99999999999999999999"]) {
      const r = await app.inject({ url: `/api/sandbox/preview/${p}/`, headers: entetes() });
      expect([p, r.statusCode, r.json()]).toEqual([p, 400, { detail: "Port invalide" }]);
    }
    const o = await app.inject({
      method: "OPTIONS",
      url: "/api/sandbox/pvs/9-2-ffffffffffffffffffffffffffffffff/0/x",
      headers: { ...entetes(), "access-control-request-headers": "x-a, x-b" },
    });
    expect([o.statusCode, o.body]).toEqual([204, ""]);
    expect(o.headers).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, POST",
      "access-control-allow-headers": "x-a, x-b",
      "access-control-max-age": "600",
    });
    const oe = await app.inject({
      method: "OPTIONS",
      url: "/api/sandbox/pvs/9-2-ffffffffffffffffffffffffffffffff/x/y",
      headers: entetes(),
    });
    expect(oe.statusCode).toBe(422);
    for (const methode of ["GET", "OPTIONS"] as const) {
      const j = await app.inject({
        method: methode,
        url: `/api/sandbox/pvs/t/${portAmont}/x`,
        headers: entetes(),
      });
      expect([methode, j.statusCode, j.json()]).toEqual([
        methode,
        403,
        { detail: "Aperçu expiré : rechargez-le" },
      ]);
    }
  });

  it("IP absente : page 409 (CORS sur pvs), décidée avant le corps ; amont muet : page 502 et IP oubliée", async () => {
    ip = null;
    try {
      const r = await app.inject({
        method: "POST",
        url: pvs("x"),
        headers: { ...entetes(), "content-type": "text/plain" },
        payload: "x".repeat(CORPS_MAX + 1),
      });
      expect([r.statusCode, r.headers["content-type"], r.headers["cache-control"]]).toEqual([
        409,
        "text/html; charset=utf-8",
        "no-store",
      ]);
      expect(r.headers["access-control-allow-origin"]).toBe("*");
      expect(r.body).toContain("Sandbox injoignable");
    } finally {
      ip = "127.0.0.1";
    }
    oublis.length = 0;
    const m = await app.inject({ url: "/api/sandbox/preview/1/", headers: entetes(9, "zoe") });
    expect([m.statusCode, m.headers["access-control-allow-origin"]]).toEqual([502, undefined]);
    expect(m.body).toContain("Aucun serveur sur le port 1");
    expect(oublis).toEqual([9]);
  });

  it("POST : corps relayé ; au-delà de 10 Mio : 413 sans appel à l'amont", async () => {
    recues.length = 0;
    const formulaire = "--x\r\ncontent-disposition: form-data; name=a\r\n\r\n1\r\n--x--\r\n";
    const r = await app.inject({
      method: "POST",
      url: pvs("formulaire"),
      headers: { ...entetes(), "content-type": "multipart/form-data; boundary=x" },
      payload: formulaire,
    });
    expect(r.statusCode).toBe(201);
    expect(recues.map((v) => [v.methode, v.corps, v.entetes["content-type"]])).toEqual([
      ["POST", formulaire.length, "multipart/form-data; boundary=x"],
    ]);
    const t = await app.inject({
      method: "POST",
      url: pvs("formulaire"),
      headers: entetes(),
      payload: Buffer.alloc(CORPS_MAX + 1),
    });
    expect([t.statusCode, t.json()]).toEqual([413, { detail: "Corps de requête trop volumineux" }]);
    expect(recues).toHaveLength(1);
  });

  it("flux SSE sans tampon ; amont coupé en route : réponse terminée ; statut hors 100–599 : 500 ; aucune connexion laissée", async () => {
    const r = await app.inject({ url: pvs("flux"), headers: entetes() });
    expect([r.statusCode, r.headers["x-accel-buffering"], r.body]).toEqual([200, "no", "data: 1\n\n"]);
    const h = await app.inject({ method: "HEAD", url: pvs("page"), headers: entetes() });
    expect([h.statusCode, h.body]).toEqual([201, ""]);
    const s = await app.inject({ url: pvs("statut999"), headers: entetes() });
    expect(s.statusCode).toBe(500);
    await new Promise((fin) => setTimeout(fin, 100));
    const ouvertes = await new Promise<number>((fin, echec) =>
      amont.getConnections((e, n) => (e ? echec(e) : fin(n))),
    );
    expect(ouvertes).toBe(0);
  });

  it("chemin hors motif Starlette ou paramètre vide : 404 texte du montage, JSON si saut de ligne intérieur ; sans enveloppe : 401", async () => {
    for (const url of [`/api/sandbox/preview/80`, `/api/sandbox/preview//x`]) {
      const r = await app.inject({ url, headers: entetes() });
      expect([url, r.statusCode, r.body]).toEqual([url, 404, "Not Found"]);
    }
    const n = await app.inject({ url: "/api/sandbox/preview/80/a%0Ab", headers: entetes() });
    expect([n.statusCode, n.json()]).toEqual([404, { detail: "Not Found" }]);
    expect((await app.inject({ url: pvs("x") })).statusCode).toBe(401);
  });
});
