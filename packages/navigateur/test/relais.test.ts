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
  ouvrirSocketATous,
  Purgeur,
  RelaisNavigateur,
  remplacerOctets,
  reponseDigest,
  valeurPourCorps,
} from "../src/relais";
import type { LiaisonRelais } from "../src/relais";
import { jugeRelaisBac } from "../src/url";

const SECRET = "p@ss w&rd=1";
const SUB = "Ep.0123456789abcdef-X";
const JETON = "jeton-du-relais";

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
      .replace(/[^\u0000-\u007e]/gu, (c) => c.split("").map(u).join("")),
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
  h.endsWith(".test") ? { ok: true, adresse: "127.0.0.1" } : { ok: false, motif: `${h} is not allowed` };

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
    // JSON : valeur échappée en JSON.
    await viaRelais(`${origine}/api`, { methode: "POST", corps: `{"p":"${SUB}"}`, type: "application/json" });
    expect(JSON.parse(recus.at(-1)?.corps ?? "{}")).toEqual({ p: SECRET });
    const bilan = relais.desarmer("l1");
    expect(bilan).toEqual({ substitutions: 2, refus: 2 });
    expect(resolutions).toBe(1);
    // Fenêtre fermée : de nouveau refusé, et la réponse reste purgée (valeur connue).
    await viaRelais(`${origine}/session`, { methode: "POST", corps: `p=${SUB}` });
    expect(recus.at(-1)?.corps).toBe(`p=${SUB}`);
    relais.oublier("l1");
  });

  it("http-auth : défis Basic et Digest résolus par le relais, le navigateur ne voit que la réponse", async () => {
    const origine = `http://auth.test:${port(http)}`;
    relais.lier(liaison({ id: "a1", kind: "http-auth", origines: [origine] }));
    const b = await viaRelais(`${origine}/basic`);
    expect([b.statut, b.corps]).toEqual([200, "basic ok"]);
    const b2 = await viaRelais(`${origine}/basic`);
    expect(b2.corps).toBe("basic ok");
    expect(recus.at(-1)?.auth).toMatch(/^Basic /u);
    const d = await viaRelais(`${origine}/digest`);
    expect([d.statut, d.corps]).toEqual([200, "digest ok"]);
    expect(recus.at(-1)?.auth).toMatch(/^Digest .*nc=00000001/u);
    const d2 = await viaRelais(`${origine}/digest`);
    expect(d2.corps).toBe("digest ok");
    expect(recus.at(-1)?.auth).toMatch(/nc=00000002/u);
    // Sans liaison : le 401 revient au navigateur.
    expect((await viaRelais(`http://autre.test:${port(http)}/basic`)).statut).toBe(401);
    relais.oublier("a1");
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
    relais.lier(liaison({ id: "b1", kind: "http-auth", origines: [basic] }));
    const e = await viaRelais(`${basic}/echo-auth`);
    expect(e.statut).toBe(200);
    expect(recus.at(-1)?.auth).toBe("Basic " + Buffer.from(`alice:${SECRET}`).toString("base64"));
    expect(JSON.stringify(e)).not.toMatch(
      new RegExp(`${Buffer.from(`alice:${SECRET}`).toString("base64").slice(0, 12)}|alice:`, "u"),
    );
    relais.oublier("b1");
  });

  it("formes du relais et du service identiques", async () => {
    const service = (await import(
      new URL("../../../browser-service/secret_util.js", import.meta.url).href
    )) as {
      formesSecret: (v: string) => string[];
    };
    for (const v of [SECRET, "Pa/ss&<é>\u{1F600}x", "x'y\"z\u00a0q"])
      expect(formesValeur(v)).toEqual(service.formesSecret(v));
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
    expect(await j("example.org", 443)).toEqual({ ok: true, adresse: "93.184.216.34" });
    expect(await j("127.0.0.1", 80)).toMatchObject({ ok: false });
    expect(await j("169.254.169.254", 80)).toMatchObject({ ok: false });
  });

  it("liste blanche IP du profil : adresses, domaines et ports", async () => {
    const j = jugeRelaisBac(
      () => ({ id: "lan", mode: "allowlist_ip", ips: ["192.168.1.0/24"], domains: [], ports: [443] }),
      { hote, resoudre, allowlist: [] },
    );
    expect(await j("nas.lan", 443)).toEqual({ ok: true, adresse: "192.168.1.10" });
    expect(await j("nas.lan", 80)).toMatchObject({ ok: false, motif: expect.stringContaining("port 80") });
    expect(await j("example.org", 443)).toMatchObject({
      ok: false,
      motif: expect.stringContaining("not allowed"),
    });
  });
});
