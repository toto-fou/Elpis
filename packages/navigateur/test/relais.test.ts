// SPDX-License-Identifier: MIT
/** packages/navigateur/test/relais.test.ts — relais des secrets du navigateur du bac : substitution seulement dans la fenêtre et vers l'origine du secret, purge des réponses, Basic et Digest résolus par le relais, TLS terminé avec l'autorité de l'instance pour les seules origines d'un secret, tunnel intact ailleurs, refus du juge et du jeton ; juge des destinations d'un bac. */
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createServerHttps } from "node:https";
import { connect as connexionNet, createServer as createServerNet } from "node:net";
import type { AddressInfo, Server as ServeurNet, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { connect as connexionTls } from "node:tls";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chargerAutorite, Feuilles } from "../src/autorite";
import type { Autorite } from "../src/autorite";
import {
  defisAuth,
  formesValeur,
  connecterAdresses,
  ouvrirSocketATous,
  Purgeur,
  reglagesRelaisNavigateur,
  RelaisNavigateur,
  remplacerOctets,
  reponseDigest,
  valeurPourCorps,
} from "../src/relais";
import type { LiaisonRelais } from "../src/relais";
import { jugeRelaisBac, reglagesJugeBac } from "../src/url";

const SECRET = "p@ss w&rd=1";
const SUB = "Ep.0123456789abcdef-X";
const JETON = "jeton-du-relais";
const CLE = "c1e".repeat(16);
const AVEC_CLE = `X-Elpis-Binding: ${CLE}\r\n`;

describe("formes, encodages, purge en flux, Digest", () => {
  it("valeur encodée selon le corps, formes de la valeur", () => {
    expect(valeurPourCorps(SECRET, "application/x-www-form-urlencoded; charset=UTF-8")).toBe(
      "p%40ss+w%26rd%3D1",
    );
    expect(valeurPourCorps('a"b', "application/json")).toBe('a\\"b');
    expect(valeurPourCorps(SECRET, "multipart/form-data; boundary=x")).toBe(SECRET);
    const f = formesValeur(SECRET);
    for (const x of [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString("base64")])
      expect(f).toContain(x);
    expect(formesValeur("ab")).toEqual([]);
  });

  it("remplacement d'octets et purge à cheval sur deux morceaux", async () => {
    expect(remplacerOctets(Buffer.from("xSECy SEC"), Buffer.from("SEC"), Buffer.from("*")).toString()).toBe(
      "x*y *",
    );
    const p = new Purgeur([Buffer.from("motdepasse")], Buffer.from(SUB));
    const morceaux: Buffer[] = [];
    p.on("data", (d: Buffer) => morceaux.push(d));
    const fin = new Promise((ok) => p.on("end", ok));
    for (const m of ["avant mot", "de", "passe après motdepas", "se!"]) p.write(Buffer.from(m));
    p.end();
    await fin;
    expect(Buffer.concat(morceaux).toString()).toBe(`avant ${SUB} après ${SUB}!`);
  });

  it("Digest : vecteur de la RFC 2617, défis multiples analysés", () => {
    const d = {
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      opaque: "5ccc069c403ebaf9f0171e9517f40e41",
      qop: "auth",
      algorithme: "MD5",
    };
    const h = reponseDigest(
      d,
      { username: "Mufasa", secret: "Circle Of Life" },
      "GET",
      "/dir/index.html",
      1,
      "0a4f113b",
    );
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain("nc=00000001");
    const defis = defisAuth([
      "WWW-Authenticate",
      'Digest realm="r", qop="auth,auth-int", nonce="n1", algorithm=SHA-256',
      "www-authenticate",
      'Basic realm="b"',
    ]);
    expect(defis.map((x) => [x.schema, x.params["realm"]])).toEqual([
      ["digest", "r"],
      ["basic", "b"],
    ]);
    expect(defis[0]?.params["algorithm"]).toBe("SHA-256");
  });
});

// ── Relais réel sur un socket unix ────────────────────────────────────

let dossier = "";
let ac: Autorite;
let acAmont: Autorite;
let relais: RelaisNavigateur;
let http: Server;
let https: Server;
let echo: ServeurNet;
const recus: { url: string; corps: string; auth: string }[] = [];
let resolutions = 0;

let dernier = "";

/** Encodages d'une valeur qu'un amont peut renvoyer, écrits ici indépendamment de formesValeur. */
function encodages(v: string): string[] {
  const u = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  return [
    encodeURIComponent(v).replace(/%[0-9A-F]{2}/gu, (x) => x.toLowerCase()),
    [...Buffer.from(v)].map((o) => `%${o.toString(16).padStart(2, "0")}`).join(""),
    [...v].map((c) => `&#${c.codePointAt(0) ?? 0};`).join(""),
    [...v].map((c) => `&#x${(c.codePointAt(0) ?? 0).toString(16)};`).join(""),
    JSON.stringify(v).slice(1, -1).replaceAll("/", "\\/"),
    JSON.stringify(v)
      .slice(1, -1)
      .replace(/[^\p{ASCII}]/gu, (c) => c.split("").map(u).join("")),
    v.split("").map(u).join(""),
    JSON.stringify(v).slice(1, -1).replace(/[<>&]/gu, u),
  ];
}

function site(req: IncomingMessage, res: ServerResponse): void {
  const m: Buffer[] = [];
  req.on("data", (d: Buffer) => m.push(d));
  req.on("end", () => {
    const corps = Buffer.concat(m).toString();
    const auth = String(req.headers["authorization"] ?? "");
    recus.push({ url: req.url ?? "", corps, auth });
    if (req.url === "/formes") {
      dernier = new URLSearchParams(corps).get("p") ?? "";
      return void res.writeHead(200, { "content-type": "text/plain" }).end(encodages(dernier).join("\n"));
    }
    if (req.url === "/gzip")
      return void res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(`x ${dernier} y`));
    if (req.url === "/relit") return void res.end(`valeur: ${dernier}`);
    if (req.url === "/zstd") return void res.writeHead(200, { "content-encoding": "zstd" }).end("zz");
    if (req.url === "/empile") return void res.writeHead(200, { "content-encoding": "gzip, br" }).end("zz");
    if (req.url === "/plage") return void res.end(`range=${String(req.headers["range"] ?? "none")}`);
    if (req.url === "/echo-auth") {
      if (!auth) return void res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end("no");
      return void res
        .writeHead(200, { "x-auth": auth })
        .end(`${auth} ${Buffer.from(auth.slice(6), "base64").toString()}`);
    }
    if (req.url === "/basic") {
      if (auth !== "Basic " + Buffer.from(`alice:${SECRET}`).toString("base64"))
        return void res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end("no");
      return void res.end("basic ok");
    }
    if (req.url === "/digest") {
      const p = defisAuth(["www-authenticate", auth])[0]?.params ?? {};
      const attendu = reponseDigest(
        { realm: "zone", nonce: "n0nce", opaque: "op", qop: "auth", algorithme: "MD5" },
        { username: "alice", secret: SECRET },
        req.method ?? "GET",
        req.url,
        Number.parseInt(p["nc"] ?? "0", 16),
        p["cnonce"] ?? "",
      );
      if (!auth.startsWith("Digest") || !attendu.includes(`response="${p["response"]}"`))
        return void res
          .writeHead(401, {
            "www-authenticate": 'Digest realm="zone", qop="auth", nonce="n0nce", opaque="op"',
          })
          .end("no");
      return void res.end("digest ok");
    }
    // Réponse qui réaffiche le corps reçu, et la valeur dans un en-tête.
    res.writeHead(200, {
      "content-type": "text/plain",
      "x-echo": new URLSearchParams(corps).get("p") === SECRET ? SECRET : "-",
    });
    res.end(`recu: ${new URLSearchParams(corps).get("p") ?? corps}`);
  });
}

const juge = async (h: string): Promise<{ ok: true; adresse: string } | { ok: false; motif: string }> =>
  h.endsWith(".test") || h === "127.0.0.1"
    ? { ok: true, adresse: "127.0.0.1" }
    : { ok: false, motif: `${h} is not allowed` };

function liaison(o: Partial<LiaisonRelais> & { id: string; origines: string[] }): LiaisonRelais {
  return {
    nom: "intranet",
    kind: "web-login",
    tls: "strict",
    substitut: null,
    resoudre: async () => {
      resolutions++;
      return { username: "alice", secret: SECRET };
    },
    ...o,
  };
}

/** Requête http en forme absolue au relais. */
function viaRelais(
  url: string,
  o: { methode?: string; corps?: string; type?: string; jeton?: string; entetes?: string } = {},
): Promise<{ statut: number; corps: string; entetes: Record<string, unknown> }> {
  return new Promise((ok, ko) => {
    const u = new URL(url);
    const r = connexionNet(path.join(dossier, "relais.sock"));
    r.on("error", ko);
    const corps = o.corps ?? "";
    r.write(
      `${o.methode ?? "GET"} ${url} HTTP/1.1\r\nHost: ${u.host}\r\nProxy-Authorization: Bearer ${o.jeton ?? JETON}\r\n${o.entetes ?? ""}` +
        `Content-Type: ${o.type ?? "application/x-www-form-urlencoded"}\r\nContent-Length: ${Buffer.byteLength(corps)}\r\nConnection: close\r\n\r\n${corps}`,
    );
    lireReponse(r).then(ok, ko);
  });
}

function lireReponse(
  s: Socket | ReturnType<typeof connexionTls>,
): Promise<{ statut: number; corps: string; entetes: Record<string, unknown> }> {
  return new Promise((ok) => {
    const m: Buffer[] = [];
    s.on("data", (d: Buffer) => m.push(d));
    s.on("close", () => {
      const t = Buffer.concat(m).toString();
      const [tete = "", ...reste] = t.split("\r\n\r\n");
      const lignes = tete.split("\r\n");
      const entetes: Record<string, unknown> = {};
      for (const l of lignes.slice(1))
        entetes[l.slice(0, l.indexOf(":")).toLowerCase()] = l.slice(l.indexOf(":") + 1).trim();
      let corps = reste.join("\r\n\r\n");
      if (String(entetes["transfer-encoding"] ?? "").includes("chunked")) {
        let sortie = "";
        for (let i = 0; i < corps.length;) {
          const fin = corps.indexOf("\r\n", i);
          const n = Number.parseInt(corps.slice(i, fin), 16);
          if (!n) break;
          sortie += corps.slice(fin + 2, fin + 2 + n);
          i = fin + 2 + n + 2;
        }
        corps = sortie;
      }
      ok({ statut: Number(lignes[0]?.split(" ")[1] ?? 0), corps, entetes });
    });
  });
}

/** Tunnel CONNECT : réponse du relais, et le socket si établi. */
function tunnel(cible: string): Promise<{ ligne: string; s: Socket }> {
  return new Promise((ok, ko) => {
    const s = connexionNet(path.join(dossier, "relais.sock"));
    s.on("error", ko);
    s.write(`CONNECT ${cible} HTTP/1.1\r\nHost: ${cible}\r\nProxy-Authorization: Bearer ${JETON}\r\n\r\n`);
    let t = "";
    const lire = (d: Buffer): void => {
      t += d.toString("latin1");
      if (!t.includes("\r\n\r\n")) return;
      s.off("data", lire);
      ok({ ligne: t.split("\r\n")[0] ?? "", s });
    };
    s.on("data", lire);
  });
}

beforeAll(async () => {
  dossier = mkdtempSync(path.join(tmpdir(), "relais-nav-"));
  ac = chargerAutorite(path.join(dossier, "ca"));
  acAmont = chargerAutorite(path.join(dossier, "ca-amont"));
  http = createServer(site);
  const feuillesAmont = new Feuilles(acAmont);
  https = createServerHttps({ SNICallback: (h, cb) => cb(null, feuillesAmont.contexte(h)) }, site);
  echo = createServerNet((s) => s.pipe(s));
  for (const srv of [http, https, echo])
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  relais = new RelaisNavigateur({
    socket: path.join(dossier, "relais.sock"),
    jeton: JETON,
    juger: juge,
    autorite: ac,
    caAmont: [acAmont.certPem],
  });
  await relais.ouvrir();
});

afterAll(async () => {
  await relais.fermer();
  for (const srv of [http, https, echo]) srv.close();
  rmSync(dossier, { recursive: true, force: true });
});

const port = (s: Server | ServeurNet): number => (s.address() as AddressInfo).port;

describe("relais des secrets (socket unix réel)", () => {
  it("autorité : clé 0600, certificat CA réutilisé au rechargement", () => {
    expect(statSync(path.join(dossier, "ca", "ca.key")).mode & 0o777).toBe(0o600);
    expect(new X509Certificate(ac.certPem).ca).toBe(true);
    expect(chargerAutorite(path.join(dossier, "ca")).empreinte).toBe(ac.empreinte);
  });

  it("jeton exigé, destination refusée par le juge avec son motif", async () => {
    expect((await viaRelais(`http://a.test:${port(http)}/`, { jeton: "faux" })).statut).toBe(407);
    const r = await viaRelais("http://interdit.example/");
    expect(r.statut).toBe(403);
    expect(r.corps).toContain("interdit.example is not allowed");
    expect((await tunnel("interdit.example:443")).ligne).toMatch(/^HTTP\/1\.1 403/u);
  });

  it("substitution : dans la fenêtre, vers l'origine du secret, corps de POST seulement ; réponse purgée ; refus comptés ailleurs", async () => {
    const origine = `http://login.test:${port(http)}`;
    relais.lier(liaison({ id: "l1", origines: [origine], substitut: SUB }));
    resolutions = 0;
    // Hors fenêtre : le substitut part tel quel.
    await viaRelais(`${origine}/session`, { methode: "POST", corps: `u=alice&p=${SUB}` });
    expect(recus.at(-1)?.corps).toBe(`u=alice&p=${SUB}`);
    expect(resolutions).toBe(0);
    relais.armer("l1", 10_000);
    // Autre origine, dans la fenêtre : jamais substitué.
    await viaRelais(`http://ailleurs.test:${port(http)}/x`, { methode: "POST", corps: `p=${SUB}` });
    expect(recus.at(-1)?.corps).toBe(`p=${SUB}`);
    // Dans l'URL : jamais substitué.
    await viaRelais(`${origine}/q?p=${SUB}`, { methode: "POST", corps: "a=1" });
    expect(recus.at(-1)?.url).toBe(`/q?p=${SUB}`);
    // Dans la fenêtre, vers l'origine, en POST : la valeur (encodée en formulaire) arrive à l'amont, la réponse est purgée.
    const r = await viaRelais(`${origine}/session`, { methode: "POST", corps: `u=alice&p=${SUB}` });
    expect(recus.at(-1)?.corps).toBe(`u=alice&p=${encodeURIComponent(SECRET).replaceAll("%20", "+")}`);
    expect(r.statut).toBe(200);
    expect(r.corps).toBe(`recu: ${SUB}`);
    expect(r.entetes["x-echo"]).toBe(SUB);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // Une seule substitution par fenêtre : la deuxième soumission part avec le substitut.
    await viaRelais(`${origine}/api`, { methode: "POST", corps: `{"p":"${SUB}"}`, type: "application/json" });
    expect(recus.at(-1)?.corps).toBe(`{"p":"${SUB}"}`);
    expect(relais.desarmer("l1")).toEqual({ substitutions: 1, refus: 3 });
    // JSON, dans une nouvelle fenêtre : valeur échappée en JSON.
    relais.armer("l1", 10_000);
    await viaRelais(`${origine}/api`, { methode: "POST", corps: `{"p":"${SUB}"}`, type: "application/json" });
    expect(JSON.parse(recus.at(-1)?.corps ?? "{}")).toEqual({ p: SECRET });
    expect(relais.desarmer("l1")).toEqual({ substitutions: 1, refus: 0 });
    expect(resolutions).toBe(1);
    // Fenêtre fermée : de nouveau refusé, et la réponse reste purgée (valeur connue).
    await viaRelais(`${origine}/session`, { methode: "POST", corps: `p=${SUB}` });
    expect(recus.at(-1)?.corps).toBe(`p=${SUB}`);
    relais.oublier("l1");
  });

  it("http-auth : défis Basic et Digest résolus par le relais, le navigateur ne voit que la réponse", async () => {
    const origine = `http://auth.test:${port(http)}`;
    relais.lier(liaison({ id: "a1", kind: "http-auth", origines: [origine], cle: CLE }));
    const b = await viaRelais(`${origine}/basic`, { entetes: AVEC_CLE });
    expect([b.statut, b.corps]).toEqual([200, "basic ok"]);
    const b2 = await viaRelais(`${origine}/basic`, { entetes: AVEC_CLE });
    expect(b2.corps).toBe("basic ok");
    expect(recus.at(-1)?.auth).toMatch(/^Basic /u);
    const d = await viaRelais(`${origine}/digest`, { entetes: AVEC_CLE });
    expect([d.statut, d.corps]).toEqual([200, "digest ok"]);
    expect(recus.at(-1)?.auth).toMatch(/^Digest .*nc=00000001/u);
    const d2 = await viaRelais(`${origine}/digest`, { entetes: AVEC_CLE });
    expect(d2.corps).toBe("digest ok");
    expect(recus.at(-1)?.auth).toMatch(/nc=00000002/u);
    // Sans liaison : le 401 revient au navigateur.
    expect((await viaRelais(`http://autre.test:${port(http)}/basic`)).statut).toBe(401);
    relais.oublier("a1");
  });

  it("http-auth lié à la session qui l'a demandé : sans sa clé (autre processus du bac), aucun Authorization ; clé jamais transmise à l'amont ; liaison échue sans prolongation", async () => {
    const origine = `http://session.test:${port(http)}`;
    relais.lier(liaison({ id: "k1", kind: "http-auth", origines: [origine], cle: CLE }));
    for (const entetes of ["", `X-Elpis-Binding: ${"0".repeat(48)}\r\n`]) {
      const r = await viaRelais(`${origine}/basic`, { entetes });
      expect(r.statut).toBe(401);
      expect(recus.at(-1)?.auth).toBe("");
    }
    expect((await viaRelais(`${origine}/basic`, { entetes: AVEC_CLE })).statut).toBe(200);
    const vus: string[] = [];
    const ecoute = (q: IncomingMessage): void => void vus.push(String(q.headers["x-elpis-binding"] ?? "-"));
    http.on("request", ecoute);
    await viaRelais(`${origine}/basic`, { entetes: AVEC_CLE });
    http.off("request", ecoute);
    expect(vus).toEqual(["-"]);
    relais.oublier("k1");
    // Échéance : prolongée à chaque appel du compte, sinon la liaison est oubliée.
    relais.lier(liaison({ id: "k2", kind: "http-auth", origines: [origine], cle: CLE, dureeMs: 200 }));
    relais.prolonger(500);
    await new Promise((ok) => setTimeout(ok, 300));
    expect(relais.ids()).toContain("k2");
    await new Promise((ok) => setTimeout(ok, 350));
    expect(relais.ids()).not.toContain("k2");
    expect((await viaRelais(`${origine}/basic`, { entetes: AVEC_CLE })).statut).toBe(401);
  });

  it("HTTPS : tunnel intact hors secret ; TLS terminé par l'autorité de l'instance pour l'origine d'un secret, amont vérifié", async () => {
    const intact = await tunnel(`echo.test:${port(echo)}`);
    expect(intact.ligne).toBe("HTTP/1.1 200 Connection Established");
    const recu = new Promise<string>((ok) => intact.s.once("data", (d: Buffer) => ok(d.toString())));
    intact.s.write("octets bruts");
    expect(await recu).toBe("octets bruts");
    intact.s.destroy();
    const origine = `https://secure.test:${port(https)}`;
    relais.lier(liaison({ id: "s1", origines: [origine], substitut: SUB }));
    relais.armer("s1", 10_000);
    const t = await tunnel(`secure.test:${port(https)}`);
    expect(t.ligne).toBe("HTTP/1.1 200 Connection Established");
    const tls = connexionTls({ socket: t.s, servername: "secure.test", ca: ac.certPem });
    await new Promise<void>((ok, ko) => {
      tls.once("secureConnect", () => ok());
      tls.once("error", ko);
    });
    expect(tls.authorized).toBe(true);
    const corps = `p=${SUB}`;
    tls.write(
      `POST /session HTTP/1.1\r\nHost: secure.test:${port(https)}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${corps.length}\r\nConnection: close\r\n\r\n${corps}`,
    );
    const r = await lireReponse(tls);
    expect(recus.at(-1)?.corps).toBe(`p=${encodeURIComponent(SECRET).replaceAll("%20", "+")}`);
    expect(r.corps).toBe(`recu: ${SUB}`);
    expect(relais.desarmer("s1").substitutions).toBe(1);
    relais.oublier("s1");
    // Autorité inconnue du client : la poignée de main échoue (le relais ne passe jamais pour l'amont).
    relais.lier(liaison({ id: "s2", origines: [origine] }));
    const t2 = await tunnel(`secure.test:${port(https)}`);
    const refuse = connexionTls({ socket: t2.s, servername: "secure.test", ca: acAmont.certPem });
    await expect(
      new Promise((ok, ko) => {
        refuse.once("secureConnect", ok);
        refuse.once("error", ko);
      }),
    ).rejects.toThrow();
    relais.oublier("s2");
  });

  it("purge : %xx en minuscules, entités numériques, JSON \\/ et \\uXXXX, Basic renvoyé par l'amont ; TRACE, CONNECT dans le flux déchiffré, codage inconnu ou empilé refusés ; plage retirée", async () => {
    const riche = "Pa/ss&<é>\u{1F600}x";
    const origine = `http://formes.test:${port(http)}`;
    relais.lier(
      liaison({
        id: "f1",
        origines: [origine, `https://formes.test:${port(https)}`],
        substitut: SUB,
        resoudre: async () => ({ username: "alice", secret: riche }),
      }),
    );
    relais.armer("f1", 10_000);
    const r = await viaRelais(`${origine}/formes`, { methode: "POST", corps: `p=${SUB}` });
    expect(dernier).toBe(riche);
    expect(r.statut).toBe(200);
    expect(r.corps.split("\n")).toEqual(encodages(riche).map(() => SUB));
    const z = await viaRelais(`${origine}/gzip`);
    expect([z.statut, z.corps, z.entetes["content-encoding"]]).toEqual([200, `x ${SUB} y`, undefined]);
    for (const c of ["/zstd", "/empile"]) expect((await viaRelais(`${origine}${c}`)).statut).toBe(502);
    expect((await viaRelais(`${origine}/x`, { methode: "TRACE" })).statut).toBe(405);
    expect((await viaRelais(`${origine}/plage`, { entetes: "Range: bytes=0-3\r\n" })).corps).toBe(
      "range=none",
    );
    const t = await tunnel(`formes.test:${port(https)}`);
    const tls = connexionTls({ socket: t.s, servername: "formes.test", ca: ac.certPem });
    await new Promise<void>((ok) => tls.once("secureConnect", () => ok()));
    tls.write("CONNECT ailleurs.test:443 HTTP/1.1\r\nHost: ailleurs.test:443\r\n\r\n");
    expect((await lireReponse(tls)).statut).toBe(405);
    relais.oublier("f1");
    const basic = `http://echo.test:${port(http)}`;
    relais.lier(liaison({ id: "b1", kind: "http-auth", origines: [basic], cle: CLE }));
    const e = await viaRelais(`${basic}/echo-auth`, { entetes: AVEC_CLE });
    expect(e.statut).toBe(200);
    expect(recus.at(-1)?.auth).toBe("Basic " + Buffer.from(`alice:${SECRET}`).toString("base64"));
    expect(JSON.stringify(e)).not.toMatch(
      new RegExp(`${Buffer.from(`alice:${SECRET}`).toString("base64").slice(0, 12)}|alice:`, "u"),
    );
    relais.oublier("b1");
  });

  it("interception décidée sur la destination jugée : adresse IP ou point final d'une origine de secret, port d'une origine http par CONNECT (en clair) ; lecture en retour purgée", async () => {
    const claire = `http://cible.test:${port(http)}`;
    relais.lier(
      liaison({ id: "i1", origines: [claire, `https://cible.test:${port(https)}`], substitut: SUB }),
    );
    relais.armer("i1", 10_000);
    await viaRelais(`${claire}/formes`, { methode: "POST", corps: `p=${SUB}` });
    expect(dernier).toBe(SECRET);
    // L'origine a gardé la valeur : relue par son adresse IP ou avec un point final, la réponse est purgée.
    for (const u of [`http://127.0.0.1:${port(http)}/relit`, `http://cible.test.:${port(http)}/relit`])
      expect((await viaRelais(u)).corps).toBe(`valeur: ${SUB}`);
    // CONNECT vers le port de l'origine http : intercepté en clair, purgé.
    const enClair = await tunnel(`127.0.0.1:${port(http)}`);
    expect(enClair.ligne).toBe("HTTP/1.1 200 Connection Established");
    enClair.s.write("GET /relit HTTP/1.1\r\nHost: cible.test\r\nConnection: close\r\n\r\n");
    expect((await lireReponse(enClair.s)).corps).toBe(`valeur: ${SUB}`);
    // CONNECT par l'adresse IP ou le nom à point final : TLS terminé par l'autorité de l'instance, jamais un tunnel intact.
    for (const [cible, sni] of [
      [`127.0.0.1:${port(https)}`, undefined],
      [`cible.test.:${port(https)}`, "cible.test"],
    ] as const) {
      const t = await tunnel(cible);
      const tls = connexionTls({
        socket: t.s,
        ca: ac.certPem,
        ...(sni ? { servername: sni } : { host: "127.0.0.1" }),
      });
      await new Promise<void>((ok, ko) => {
        tls.once("secureConnect", () => ok());
        tls.once("error", ko);
      });
      tls.write("GET /relit HTTP/1.1\r\nHost: cible.test\r\nConnection: close\r\n\r\n");
      const r = await lireReponse(tls);
      expect(r.corps).not.toContain(SECRET);
      if (sni) expect(r.corps).toBe(`valeur: ${SUB}`);
    }
    relais.oublier("i1");
  });

  it("WebSocket chiffré vers une origine de secret : amont vérifié (TLS strict par défaut), relâché seulement par la politique du secret", async () => {
    const autreAc = chargerAutorite(path.join(dossier, "ca-inconnue"));
    const feuilles = new Feuilles(autreAc);
    const ws = createServerHttps({ SNICallback: (h, cb) => cb(null, feuilles.contexte(h)) }, (_q, r) =>
      r.end(),
    );
    ws.on("upgrade", (_q: IncomingMessage, s: Socket) => {
      s.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    await new Promise<void>((ok) => ws.listen(0, "127.0.0.1", () => ok()));
    try {
      const origine = `https://ws.test:${port(ws)}`;
      const essai = async (): Promise<string> => {
        const t = await tunnel(`ws.test:${port(ws)}`);
        const tls = connexionTls({ socket: t.s, servername: "ws.test", ca: ac.certPem });
        tls.on("error", () => undefined);
        await new Promise<void>((ok) => tls.once("secureConnect", () => ok()));
        tls.write(
          "GET /flux HTTP/1.1\r\nHost: ws.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
        const m: Buffer[] = [];
        tls.on("data", (d: Buffer) => m.push(d));
        await new Promise((ok) => tls.once("close", ok));
        return Buffer.concat(m).toString().split("\r\n")[0] ?? "";
      };
      relais.lier(liaison({ id: "w1", origines: [origine] }));
      expect(await essai()).toBe("");
      relais.oublier("w1");
      relais.lier(liaison({ id: "w2", origines: [origine], tls: "insecure" }));
      expect(await essai()).toBe("HTTP/1.1 101 Switching Protocols");
      relais.oublier("w2");
    } finally {
      ws.close();
    }
  });

  it("formes du relais et du service identiques", async () => {
    const service = (await import(
      new URL("../../../browser-service/src/secret_util.ts", import.meta.url).href
    )) as {
      formesSecret: (v: string) => string[];
    };
    for (const v of [SECRET, "Pa/ss&<é>\u{1F600}x", "x'y\"z\u00a0q"])
      expect(formesValeur(v)).toEqual(service.formesSecret(v));
  });

  it("corps bornés : trop gros vers une origine en fenêtre de connexion, 413 aussitôt (connu ou en morceaux) ; budget du relais dépassé, 503 ; ailleurs, relayé en flux", async () => {
    const origine = `http://borne.test:${port(http)}`;
    relais.lier(liaison({ id: "c1", origines: [origine], substitut: SUB }));
    relais.armer("c1", 10_000);
    const avant = { ...reglagesRelaisNavigateur };
    try {
      reglagesRelaisNavigateur.corpsMax = 1024;
      // Longueur annoncée trop grande : refus sans lire le corps (jamais d'attente sans fin).
      const annonce = connexionNet(path.join(dossier, "relais.sock"));
      annonce.on("error", () => undefined);
      annonce.write(
        `POST ${origine}/session HTTP/1.1\r\nHost: borne.test\r\nProxy-Authorization: Bearer ${JETON}\r\nContent-Length: 5000\r\n\r\np=${SUB}`,
      );
      expect((await lireReponse(annonce)).statut).toBe(413);
      // En morceaux : refus dès la borne passée, connexion fermée.
      const morceaux = connexionNet(path.join(dossier, "relais.sock"));
      morceaux.on("error", () => undefined);
      const bloc = "x".repeat(800);
      morceaux.write(
        `POST ${origine}/session HTTP/1.1\r\nHost: borne.test\r\nProxy-Authorization: Bearer ${JETON}\r\nTransfer-Encoding: chunked\r\n\r\n` +
          `${bloc.length.toString(16)}\r\n${bloc}\r\n${bloc.length.toString(16)}\r\n${bloc}\r\n`,
      );
      expect((await lireReponse(morceaux)).statut).toBe(413);
      // Budget du relais épuisé : 503.
      reglagesRelaisNavigateur.tamponsMax = 10;
      expect((await viaRelais(`${origine}/session`, { methode: "POST", corps: `p=${SUB}` })).statut).toBe(
        503,
      );
      reglagesRelaisNavigateur.tamponsMax = avant.tamponsMax;
      // Hors fenêtre et hors secret : un gros corps passe en flux, entier.
      const gros = "y".repeat(50_000);
      expect(
        (await viaRelais(`http://flux.test:${port(http)}/x`, { methode: "POST", corps: gros })).statut,
      ).toBe(200);
      expect(recus.at(-1)?.corps.length).toBe(gros.length);
    } finally {
      Object.assign(reglagesRelaisNavigateur, avant);
      relais.oublier("c1");
    }
  });

  it("client qui abandonne au milieu du corps (fenêtre armée, origine couverte en clair et en TLS) : aucun rejet non traité, le relais sert encore", async () => {
    const rejets: unknown[] = [];
    const surveiller = (e: unknown): void => void rejets.push(e);
    process.on("unhandledRejection", surveiller);
    try {
      const enClair = `http://abandon.test:${port(http)}`;
      const chiffree = `https://abandon.test:${port(https)}`;
      relais.lier(liaison({ id: "ab", origines: [enClair, chiffree], substitut: SUB }));
      relais.armer("ab", 10_000);
      const tete = (hote: string): string =>
        `POST /session HTTP/1.1\r\nHost: ${hote}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100000\r\n`;
      const clair = connexionNet(path.join(dossier, "relais.sock"));
      clair.on("error", () => undefined);
      clair.write(
        `${tete(`abandon.test:${port(http)}`).replace("/session", `${enClair}/session`)}Proxy-Authorization: Bearer ${JETON}\r\n\r\np=${SUB}&u=`,
      );
      await new Promise((ok) => setTimeout(ok, 100));
      clair.destroy();
      const t = await tunnel(`abandon.test:${port(https)}`);
      const tls = connexionTls({ socket: t.s, servername: "abandon.test", ca: ac.certPem });
      tls.on("error", () => undefined);
      await new Promise<void>((ok) => tls.once("secureConnect", () => ok()));
      tls.write(`${tete(`abandon.test:${port(https)}`)}\r\np=${SUB}&u=`);
      await new Promise((ok) => setTimeout(ok, 100));
      tls.destroy();
      await new Promise((ok) => setTimeout(ok, 200));
      expect(rejets).toEqual([]);
      expect((await viaRelais(`${enClair}/ok`)).statut).toBe(200);
    } finally {
      process.off("unhandledRejection", surveiller);
      relais.oublier("ab");
    }
  });

  it("droits du socket posés sans suivre de lien : un lien du bac vers un fichier de l'hôte refusé, le fichier intact", async () => {
    const hote = path.join(dossier, "cle-hote");
    writeFileSync(hote, "x", { mode: 0o600 });
    const lien = path.join(dossier, "lien.sock");
    symlinkSync(hote, lien);
    expect(() => ouvrirSocketATous(lien)).toThrow(/not a socket/u);
    expect(statSync(hote).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dossier, "relais.sock")).mode & 0o777).toBe(0o666);
  });

  it("socket retiré par le bac : détecté, rouvert avec les liaisons", async () => {
    relais.lier(liaison({ id: "k1", origines: ["http://k.test"] }));
    rmSync(path.join(dossier, "relais.sock"));
    expect(relais.ecoute()).toBe(false);
    await relais.rouvrir();
    expect(relais.ecoute()).toBe(true);
    expect(relais.ids()).toContain("k1");
    expect((await viaRelais(`http://ok.test:${port(http)}/`)).statut).toBe(200);
    relais.oublier("k1");
  });
});

describe("juge des destinations d'un bac", () => {
  const hote = { adresses: [], reseaux: [] };
  const resoudre = async (n: string): Promise<string[]> =>
    n === "nas.lan" ? ["192.168.1.10"] : ["93.184.216.34"];

  it("profil sans réseau : tout refusé avec un message clair", async () => {
    const j = jugeRelaisBac(() => ({ id: "isolated", mode: "none", ips: [], domains: [], ports: [] }), {
      hote,
      resoudre,
      allowlist: [],
    });
    const v = await j("example.org", 443);
    expect(v).toEqual({ ok: false, motif: expect.stringContaining("'isolated' has no network access") });
  });

  it("profil ouvert : machine d'Elpis et boucle refusées, le reste joint à l'adresse jugée", async () => {
    const h = { adresses: [], reseaux: [] };
    const j = jugeRelaisBac(() => ({ id: "web", mode: "bridge", ips: [], domains: [], ports: [] }), {
      hote: h,
      resoudre,
      allowlist: [],
    });
    expect(await j("example.org", 443)).toEqual({
      ok: true,
      adresse: "93.184.216.34",
      adresses: ["93.184.216.34"],
    });
    expect(await j("127.0.0.1", 80)).toMatchObject({ ok: false });
    expect(await j("169.254.169.254", 80)).toMatchObject({ ok: false });
  });

  it("verdicts gardés comme ceux du service central : une résolution par nom (appels simultanés compris), refus gardé moins longtemps", async () => {
    const vus: string[] = [];
    const lent = async (n: string): Promise<string[]> => {
      vus.push(n);
      await new Promise((ok) => setTimeout(ok, 20));
      if (n === "absent.example") throw new Error("ENOTFOUND");
      return ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
    };
    const avant = { ...reglagesJugeBac };
    reglagesJugeBac.cacheNegatifMs = 50;
    try {
      const j = jugeRelaisBac(() => ({ id: "web", mode: "bridge", ips: [], domains: [], ports: [] }), {
        hote,
        resoudre: lent,
        allowlist: [],
      });
      const v = await Promise.all([j("example.org", 443), j("example.org", 443), j("EXAMPLE.org", 80)]);
      expect(v[0]).toEqual({
        ok: true,
        adresse: "93.184.216.34",
        adresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      });
      expect(await j("example.org", 8443)).toEqual(v[0]);
      expect(vus).toEqual(["example.org"]);
      expect(await j("absent.example", 443)).toMatchObject({ ok: false });
      expect(await j("absent.example", 443)).toMatchObject({ ok: false });
      expect(vus.filter((n) => n === "absent.example")).toHaveLength(1);
      await new Promise((ok) => setTimeout(ok, 80));
      await j("absent.example", 443);
      expect(vus.filter((n) => n === "absent.example")).toHaveLength(2);
    } finally {
      Object.assign(reglagesJugeBac, avant);
    }
  });

  it("connexion à l'amont : adresse suivante si la première traîne ou échoue, délai total borné", async () => {
    const srv = createServerNet((s) => s.end());
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    const p = (srv.address() as AddressInfo).port;
    const avant = { ...reglagesRelaisNavigateur };
    try {
      reglagesRelaisNavigateur.essaiSuivantMs = 100;
      reglagesRelaisNavigateur.connexionMs = 1500;
      // 192.0.2.1 (TEST-NET-1) ne répond jamais, ::1 sur ce port refuse : 127.0.0.1 est jointe vite.
      const t0 = performance.now();
      const s = await connecterAdresses(["192.0.2.1", "::1", "127.0.0.1"], p);
      expect(s.remoteAddress).toBe("127.0.0.1");
      expect(performance.now() - t0).toBeLessThan(1000);
      s.destroy();
      reglagesRelaisNavigateur.connexionMs = 300;
      await expect(connecterAdresses(["192.0.2.1"], p)).rejects.toThrow();
    } finally {
      Object.assign(reglagesRelaisNavigateur, avant);
      srv.close();
    }
  });

  it("liste blanche IP du profil : adresses, domaines et ports", async () => {
    const j = jugeRelaisBac(
      () => ({ id: "lan", mode: "allowlist_ip", ips: ["192.168.1.0/24"], domains: [], ports: [443] }),
      { hote, resoudre, allowlist: [] },
    );
    expect(await j("nas.lan", 443)).toMatchObject({ ok: true, adresse: "192.168.1.10" });
    expect(await j("nas.lan", 80)).toMatchObject({ ok: false, motif: expect.stringContaining("port 80") });
    expect(await j("example.org", 443)).toMatchObject({
      ok: false,
      motif: expect.stringContaining("not allowed"),
    });
  });
});
