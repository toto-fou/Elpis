// SPDX-License-Identifier: MIT
/** apps/core/test/llm/client-http.test.ts — transport du moteur : vecteurs httpx, délais, pool, coupures, annulation et TLS de la PKI interne. */
import { DOSSIER_MOTEUR } from "./environnement-fournisseurs";

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as serveurTls } from "node:https";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import * as tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { lireVecteurs } from "../vecteurs-moteur";
import { attendre, FauxServeur, portFerme } from "./faux-serveur";
import { moteurFrais } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";
import { CA_TEST, CERT_SERVEUR, CLE_SERVEUR } from "./pki-test";

interface VecteursTransport {
  llama_timeout_sec: number;
  delais_flux: { ctx: number | null; connect: number; read: number; write: number; pool: number }[];
  libelles: Record<string, string>;
  messages: { code: number; location: boolean; message: string }[];
  corps_json: { valeur: unknown; octets: string }[];
  params: { params: Record<string, string | number>; url: string }[];
  lignes: { morceaux: string[]; lignes: string[] }[];
}

const V = lireVecteurs<VecteursTransport>("moteur-transport");
let m: Moteur;
const serveurs: FauxServeur[] = [];

async function serveur(): Promise<FauxServeur> {
  const s = await FauxServeur.demarrer();
  serveurs.push(s);
  return s;
}

beforeAll(async () => {
  m = await moteurFrais();
});

afterEach(async () => {
  for (const s of serveurs.splice(0)) await s.arreter();
});

afterAll(async () => {
  await m.fermer();
});

function corpsDe(morceaux: string[]): AsyncIterable<Uint8Array> & { destroy(): void } {
  return {
    async *[Symbol.asyncIterator]() {
      for (const x of morceaux) yield new TextEncoder().encode(x);
    },
    destroy() {},
  };
}

describe("vecteurs httpx", () => {
  it("délais d'un flux selon la fenêtre (lecture élargie, plafond 1 h)", () => {
    expect(V.llama_timeout_sec).toBe(600);
    for (const c of V.delais_flux) {
      const d = m.client.streamTimeoutForCtx(c.ctx);
      expect(d, String(c.ctx)).toEqual({ connect: c.connect, read: c.read, write: c.write, pool: c.pool });
    }
  });

  it("libellés de statut de httpx, à l'identique", () => {
    for (let code = 100; code < 600; code++)
      expect(m.client.getReasonPhrase(code)).toBe(V.libelles[String(code)] ?? "");
  });

  it("message de raise_for_status (redirection comprise)", () => {
    for (const c of V.messages) {
      const r = new m.client.ReponseHttp({
        statusCode: c.code,
        request: { method: "POST", url: "http://h:1/v1/chat/completions" },
        headers: c.location ? { location: "/ailleurs" } : undefined,
      });
      let message = "";
      try {
        r.raiseForStatus();
      } catch (e) {
        expect(e).toBeInstanceOf(m.client.HTTPStatusError);
        message = (e as Error).message;
      }
      expect(message, `${c.code}`).toBe(c.message);
    }
  });

  it("corps json= : compact, UTF-8, octets identiques", () => {
    for (const c of V.corps_json) {
      const attendu = Buffer.from(c.octets, "base64").toString("utf-8");
      if (c.valeur === null) expect(attendu).toBe("");
      else expect(m.client.corpsJson(c.valeur).toString("utf-8")).toBe(attendu);
    }
  });

  it("paramètres d'URL encodés comme httpx (quote_plus)", () => {
    for (const c of V.params) expect(m.client.avecParametres("http://h:1/v1/stream", c.params)).toBe(c.url);
  });

  it("découpe des lignes d'un flux en morceaux arbitraires", async () => {
    for (const c of V.lignes) {
      const r = new m.client.ReponseFlux({
        statusCode: 200,
        headers: new Headers(),
        request: { method: "GET", url: "http://x/" },
        reasonPhrase: "OK",
        corps: corpsDe(c.morceaux),
        liberer: () => undefined,
        traduire: (e) => e,
      });
      const lignes: string[] = [];
      for await (const l of r.aiterLines()) lignes.push(l);
      expect(lignes, JSON.stringify(c.morceaux)).toEqual(c.lignes);
    }
  });

  it("U+2028, U+2029 et U+0085 ne coupent pas une ligne (écart voulu : httpx y perdait un morceau JSON)", async () => {
    const r = new m.client.ReponseFlux({
      statusCode: 200,
      headers: new Headers(),
      request: { method: "GET", url: "http://x/" },
      reasonPhrase: "OK",
      corps: corpsDe(['data: {"t": "a b c\u0085d"}\n']),
      liberer: () => undefined,
      traduire: (e) => e,
    });
    const lignes: string[] = [];
    for await (const l of r.aiterLines()) lignes.push(l);
    expect(lignes).toEqual(['data: {"t": "a b c\u0085d"}']);
  });
});

describe("requêtes réelles sur un faux serveur", () => {
  it("GET JSON, en-têtes, libellé du serveur", async () => {
    const s = await serveur();
    s.json("GET /props", { a: 1 }, 200, { "x-test": "oui" });
    const c = new m.client.ClientHttp();
    const r = await c.get(`${s.url}/props`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ a: 1 });
    expect(r.headers.get("X-Test")).toBe("oui");
    expect(r.reasonPhrase).toBe("OK");
    expect(s.sur("/props")[0]?.entetes["user-agent"]).toBe(m.client.AGENT_UTILISATEUR);
    expect(s.sur("/props")[0]?.entetes["accept"]).toBe("*/*");
    await c.aclose();
  });

  it("libellé vide du serveur gardé tel quel (comme httpx) ; .text garde le BOM, json() le saute et lit NaN", async () => {
    const corps = Buffer.from('\ufeff{"a": NaN}', "utf-8");
    const tete = `HTTP/1.1 418 \r\ncontent-type: application/json\r\ncontent-length: ${corps.length}\r\n\r\n`;
    const brut = createServer((sock) => {
      sock.on("data", () => sock.end(Buffer.concat([Buffer.from(tete), corps])));
    });
    await new Promise<void>((ok) => brut.listen(0, "127.0.0.1", () => ok()));
    const c = new m.client.ClientHttp();
    try {
      const r = await c.get(`http://127.0.0.1:${(brut.address() as AddressInfo).port}/x`);
      expect(r.reasonPhrase).toBe("");
      expect(r.text).toBe('\ufeff{"a": NaN}');
      expect(r.json()).toEqual({ a: Number.NaN });
      expect(() => r.raiseForStatus()).toThrow(/^Client error '418 ' for url/);
    } finally {
      await c.aclose();
      await new Promise<void>((ok) => brut.close(() => ok()));
    }
  });

  it("client fermé : RuntimeError de httpx ; un flux en cours coupé par aclose() du client = ReadError", async () => {
    const s = await serveur();
    s.sse("GET /f", ["data: 1"], { ouvert: true });
    const c = new m.client.ClientHttp();
    const flux = await c.stream("GET", `${s.url}/f`);
    const lecture = (async () => {
      for await (const _ of flux.aiterLines()) void _;
    })();
    await attendre(30);
    await c.aclose();
    await expect(lecture).rejects.toMatchObject({ name: "ReadError", message: "" });
    await expect(c.get(`${s.url}/f`)).rejects.toMatchObject({
      name: "RuntimeError",
      message: "Cannot send a request, as the client has been closed.",
    });
  });

  it("traduction des erreurs undici : familles et messages de httpx (connexion, DNS, TLS, coupure, délais)", () => {
    const erreur = (code: string, message = "x") => Object.assign(new Error(message), { code });
    const cas: [Error, boolean, string, string][] = [
      [erreur("ECONNREFUSED"), false, "ConnectError", "All connection attempts failed"],
      [erreur("EHOSTUNREACH"), false, "ConnectError", "All connection attempts failed"],
      [erreur("ENOTFOUND"), false, "ConnectError", "[Errno -2] Name or service not known"],
      [erreur("EAI_AGAIN"), false, "ConnectError", "[Errno -3] Temporary failure in name resolution"],
      [erreur("UND_ERR_CONNECT_TIMEOUT"), false, "ConnectTimeout", ""],
      [erreur("UND_ERR_HEADERS_TIMEOUT"), false, "ReadTimeout", ""],
      [erreur("ECONNRESET"), true, "ReadError", ""],
      [erreur("ETIMEDOUT"), false, "ConnectError", "All connection attempts failed"],
      [erreur("ETIMEDOUT"), true, "ReadError", ""],
      [
        erreur("UND_ERR_SOCKET"),
        false,
        "RemoteProtocolError",
        "Server disconnected without sending a response.",
      ],
      [erreur("UND_ERR_DESTROYED"), true, "ReadError", ""],
      [
        erreur("UND_ERR_DESTROYED"),
        false,
        "RuntimeError",
        "Cannot send a request, as the client has been closed.",
      ],
      [
        erreur("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"),
        false,
        "ConnectError",
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain",
      ],
    ];
    for (const [e, entetes, nom, message] of cas) {
      const t = m.client.traduireErreur(e, entetes) as Error;
      expect([t.name, t.message], `${(e as { code?: string }).code} ${String(entetes)}`).toEqual([
        nom,
        message,
      ]);
    }
    expect(new m.client.RemoteProtocolError("")).toBeInstanceOf(m.client.ProtocolError);
    expect(new m.client.ConnectError("")).toBeInstanceOf(m.client.RequestError);
  });

  it("POST json= compact avec content-type ; json nul = aucun corps", async () => {
    const s = await serveur();
    s.json("POST /x", {});
    const c = new m.client.ClientHttp();
    await c.post(`${s.url}/x`, { json: { a: "é", b: [1, 2.5] }, headers: { Authorization: "Bearer k" } });
    await c.post(`${s.url}/x`, { json: null });
    const [premiere, seconde] = s.sur("/x");
    expect(premiere?.corps).toBe('{"a":"é","b":[1,2.5]}');
    expect(premiere?.entetes["content-type"]).toBe("application/json");
    expect(premiere?.entetes["authorization"]).toBe("Bearer k");
    expect(seconde?.corps).toBe("");
    expect(seconde?.entetes["content-type"]).toBeUndefined();
    await c.aclose();
  });

  it("ConnectError « All connection attempts failed » sur un port fermé", async () => {
    const c = new m.client.ClientHttp();
    const p = await portFerme();
    await expect(c.get(`http://127.0.0.1:${p}/`, { timeout: 2 })).rejects.toMatchObject({
      name: "ConnectError",
      message: "All connection attempts failed",
    });
    await c.aclose();
  });

  it("ReadTimeout quand le serveur se tait (avant les en-têtes, puis dans le corps)", async () => {
    const s = await serveur();
    s.route("GET /muet", () => new Promise(() => undefined));
    s.sse("GET /flux", ["data: 1"], { ouvert: true });
    const c = new m.client.ClientHttp();
    await expect(c.get(`${s.url}/muet`, { timeout: 0.2 })).rejects.toMatchObject({
      name: "ReadTimeout",
      message: "",
    });
    const r = await c.stream("GET", `${s.url}/flux`, { timeout: 0.3 });
    const lignes: string[] = [];
    await expect(
      (async () => {
        for await (const l of r.aiterLines()) lignes.push(l);
      })(),
    ).rejects.toBeInstanceOf(m.client.ReadTimeout);
    expect(lignes).toEqual(["data: 1", ""]);
    await c.aclose();
  });

  it("RemoteProtocolError : connexion coupée sans réponse, puis en plein corps", async () => {
    const s = await serveur();
    s.route("GET /coupe", (_r, rep) => void rep.socket?.destroy());
    s.route("GET /mi", async (_r, rep) => {
      rep.writeHead(200, { "content-type": "text/event-stream" });
      rep.write("data: a\n\n");
      await attendre(30);
      rep.socket?.destroy();
    });
    const c = new m.client.ClientHttp();
    await expect(c.get(`${s.url}/coupe`)).rejects.toMatchObject({
      name: "RemoteProtocolError",
      message: "Server disconnected without sending a response.",
    });
    const r = await c.stream("GET", `${s.url}/mi`);
    await expect(
      (async () => {
        for await (const _ of r.aiterLines()) void _;
      })(),
    ).rejects.toMatchObject({ name: "RemoteProtocolError" });
    await c.aclose();
  });

  it("PoolTimeout : plus de connexion libre pendant `pool` secondes", async () => {
    const s = await serveur();
    s.route("GET /long", () => new Promise(() => undefined));
    const c = new m.client.ClientHttp({ limites: { maxConnections: 1 } });
    const occupe = c.get(`${s.url}/long`, { timeout: 2 }).catch((e: unknown) => e);
    await attendre(50);
    await expect(
      c.get(`${s.url}/long`, { timeout: m.client.delais(2, { pool: 0.15 }) }),
    ).rejects.toMatchObject({
      name: "PoolTimeout",
    });
    await c.aclose();
    await occupe;
  });

  it("annulation : un signal ferme le flux, le serveur voit la déconnexion ; aucune tentative après coup", async () => {
    const s = await serveur();
    s.sse("POST /v1/chat/completions", ["data: 1", "data: 2", "data: 3", "data: 4"], {
      delaiMs: 80,
      ouvert: true,
    });
    const c = new m.client.ClientHttp();
    const ctl = new AbortController();
    const r = await c.stream("POST", `${s.url}/v1/chat/completions`, { json: {}, signal: ctl.signal });
    const lignes: string[] = [];
    const lecture = (async () => {
      for await (const l of r.aiterLines()) {
        lignes.push(l);
        if (l === "data: 2") ctl.abort();
      }
    })();
    await expect(lecture).rejects.toBeInstanceOf(m.client.CancelledError);
    await attendre(50);
    expect(s.deconnexions).toBe(1);
    expect(lignes).toContain("data: 2");
    expect(lignes).not.toContain("data: 4");
    await expect(c.get(`${s.url}/x`, { signal: ctl.signal })).rejects.toBeInstanceOf(m.client.CancelledError);
    await c.aclose();
  });

  it("aclose() avant la fin coupe la connexion (stop par `is_cancelled`)", async () => {
    const s = await serveur();
    s.sse("GET /f", ["data: 1", "data: 2"], { delaiMs: 100, ouvert: true });
    const c = new m.client.ClientHttp();
    await m.client.avecFlux(c, "GET", `${s.url}/f`, {}, async (r) => {
      for await (const l of r.aiterLines()) if (l === "data: 1") break;
    });
    await attendre(50);
    expect(s.deconnexions).toBe(1);
    await c.aclose();
  });

  it("flux fermé ou annulé AVANT toute lecture : aucune exception non rattrapée, l'annulation reste visible au lecteur", async () => {
    const s = await serveur();
    s.sse("GET /f", ["data: 1"], { delaiMs: 50, ouvert: true });
    const c = new m.client.ClientHttp();
    const r1 = await c.stream("GET", `${s.url}/f`);
    await r1.aclose();
    const ctl = new AbortController();
    const r2 = await c.stream("GET", `${s.url}/f`, { signal: ctl.signal });
    ctl.abort();
    await attendre(50);
    await expect(
      (async () => {
        for await (const _ of r2.aiterLines()) void _;
      })(),
    ).rejects.toBeInstanceOf(m.client.CancelledError);
    expect(s.deconnexions).toBe(2);
    await c.aclose();
  });

  it("un signal abandonné en attente d'une connexion du pool sort sans en prendre", async () => {
    const s = await serveur();
    s.route("GET /long", () => new Promise(() => undefined));
    const c = new m.client.ClientHttp({ limites: { maxConnections: 1 } });
    const occupe = c.get(`${s.url}/long`, { timeout: 2 }).catch((e: unknown) => e);
    await attendre(30);
    const ctl = new AbortController();
    const attente = c.get(`${s.url}/long`, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    await expect(attente).rejects.toBeInstanceOf(m.client.CancelledError);
    await c.aclose();
    await occupe;
  });

  it("corps d'erreur lisible après aread() ; texte d'un flux non lu = ResponseNotRead", async () => {
    const s = await serveur();
    s.json("POST /e", { error: { message: "trop long" } }, 400);
    const c = new m.client.ClientHttp();
    const r = await c.stream("POST", `${s.url}/e`, { json: {} });
    expect(() => r.text).toThrow(m.client.ResponseNotRead);
    await r.aread();
    expect(r.text).toContain("trop long");
    expect(() => r.raiseForStatus()).toThrow(/Client error '400 Bad Request' for url/);
    await r.aclose();
    await c.aclose();
  });

  it("clients LLM : partagé sans base, un dédié par base (barres finales ignorées), LRU de 16 qui FERME l'évincé", async () => {
    const partage = m.client.getLlmClient();
    expect(m.client.getLlmClient(null)).toBe(partage);
    const a = m.client.getLlmClient("http://a/");
    expect(m.client.getLlmClient(" http://a ")).toBe(a);
    for (let i = 0; i < 16; i++) m.client.getLlmClient(`http://b${i}`);
    expect(a.isClosed).toBe(true);
    expect(m.client.dedicatedClientKeys()).toHaveLength(16);
    await m.client.closeLlmClient();
    expect(partage.isClosed).toBe(true);
    expect(m.client.dedicatedClientKeys()).toHaveLength(0);
  });
});

/** Magasin par défaut de Node (`--use-system-ca` : système compris) ; l'embarqué seul avant Node 22.15. */
function magasinParDefaut(): string[] {
  const magasin = (tls as { getCACertificates?: (type: "default") => string[] }).getCACertificates;
  return magasin ? magasin("default") : [...tls.rootCertificates];
}

describe("TLS hors ligne : jamais de CA implicite", () => {
  it("SSL_CERT_FILE, sinon SSL_CERT_DIR comme un capath d'OpenSSL, sinon le magasin par défaut de Node", () => {
    const dossier = path.join(DOSSIER_MOTEUR, "ca");
    const vide = path.join(DOSSIER_MOTEUR, "ca-non-hachee");
    mkdirSync(dossier, { recursive: true });
    mkdirSync(vide, { recursive: true });
    const fichier = path.join(dossier, "pki.pem");
    writeFileSync(fichier, CA_TEST);
    writeFileSync(path.join(dossier, "0a1b2c3d.0"), CA_TEST);
    writeFileSync(path.join(dossier, "0a1b2c3d.1"), "pas un certificat");
    writeFileSync(path.join(dossier, "notes.txt"), "pas un certificat");
    writeFileSync(path.join(vide, "interne.pem"), CA_TEST);
    expect(m.client.autoritesTls({})).toEqual(magasinParDefaut());
    expect(m.client.autoritesTls({ SSL_CERT_FILE: fichier })).toEqual([CA_TEST]);
    expect(m.client.autoritesTls({ SSL_CERT_DIR: dossier })).toEqual([CA_TEST]);
    expect(m.client.autoritesTls({ SSL_CERT_DIR: vide })).toEqual([]);
    expect(m.client.autoritesTls({ SSL_CERT_DIR: `/nulle/part${path.delimiter}${dossier}` })).toEqual([
      CA_TEST,
    ]);
    expect(m.client.autoritesTls({ SSL_CERT_DIR: "/nulle/part" })).toEqual([]);
    expect(m.client.autoritesTls({ SSL_CERT_FILE: fichier, SSL_CERT_DIR: "/nulle/part" })).toEqual([CA_TEST]);
    expect(m.client.autoritesTls({ SSL_CERT_DIR: dossier })).toBe(
      m.client.autoritesTls({ SSL_CERT_DIR: dossier }),
    );
    expect(() => m.client.autoritesTls({ SSL_CERT_FILE: "/nulle/part.pem" })).toThrow();
    const sansCa = new m.client.ClientHttp({
      autorites: m.client.autoritesTls({ SSL_CERT_DIR: "/nulle/part" }),
    });
    expect(sansCa.isClosed).toBe(false);
  });

  it("SSL_CERT_DIR en liste : lue pour le moteur, mais signalée (Node n'en lit qu'un dossier)", () => {
    const dossier = path.join(DOSSIER_MOTEUR, "ca-liste");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(path.join(dossier, "0a1b2c3d.0"), CA_TEST);
    const ecrits: string[] = [];
    const espion = vi.spyOn(process.stderr, "write").mockImplementation((t: string | Uint8Array) => {
      ecrits.push(String(t));
      return true;
    });
    try {
      const liste = `/nulle/part-liste${path.delimiter}${dossier}`;
      expect(m.client.autoritesTls({ SSL_CERT_DIR: liste })).toEqual([CA_TEST]);
      expect(m.client.autoritesTls({ SSL_CERT_DIR: liste })).toEqual([CA_TEST]); // relue : pas de second avertissement
      expect(m.client.autoritesTls({ SSL_CERT_DIR: dossier })).toEqual([CA_TEST]);
      expect(ecrits.join("")).toContain(
        `SSL_CERT_DIR=${liste} : liste de dossiers lue pour le moteur d'inférence`,
      );
      expect(ecrits.filter((e) => e.includes("liste de dossiers"))).toHaveLength(1);
    } finally {
      espion.mockRestore();
    }
  });

  it("sans réglage, le magasin du système vaut avec --use-system-ca : serveur de la PKI interne accepté", async () => {
    const srv = serveurTls({ cert: CERT_SERVEUR, key: CLE_SERVEUR }, (_req, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end("{}");
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    const url = `https://127.0.0.1:${(srv.address() as AddressInfo).port}/health`;
    const ca = path.join(DOSSIER_MOTEUR, "ca-systeme.pem");
    writeFileSync(ca, CA_TEST);
    const script = path.join(DOSSIER_MOTEUR, "magasin-systeme.mts");
    const module = path.resolve(import.meta.dirname, "../../src/llm/client-http.ts");
    writeFileSync(
      script,
      `import { autoritesTls, ClientHttp } from ${JSON.stringify(module)};\n` +
        "const c = new ClientHttp({ autorites: autoritesTls({}) });\n" +
        "try { process.stdout.write(String((await c.get(process.argv[2], { timeout: 5 })).statusCode)); }\n" +
        "catch (e) { process.stdout.write((e as Error).name); } finally { await c.aclose(); }\n",
    );
    const lancer = (options: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        const enfant = spawn(process.execPath, [...options, "--import", "tsx", script, url], {
          cwd: path.resolve(import.meta.dirname, "../../../.."),
          env: { ...process.env, SSL_CERT_FILE: ca },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let sortie = "";
        let erreurs = "";
        enfant.stdout.on("data", (morceau: Buffer) => (sortie += morceau.toString()));
        enfant.stderr.on("data", (morceau: Buffer) => (erreurs += morceau.toString()));
        enfant.on("error", reject);
        enfant.on("close", (code) =>
          code === 0 ? resolve(sortie) : reject(new Error(`code ${code} : ${erreurs}`)),
        );
      });
    try {
      expect(await lancer(["--use-system-ca"])).toBe("200");
      expect(await lancer([])).toBe("ConnectError");
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((ok) => srv.close(() => ok()));
    }
  }, 60_000);

  it("un serveur de la PKI interne est refusé sans sa CA, accepté avec (CA collée)", async () => {
    const srv = serveurTls({ cert: CERT_SERVEUR, key: CLE_SERVEUR }, (_req, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end('{"ok": true}');
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    const url = `https://127.0.0.1:${(srv.address() as AddressInfo).port}/health`;
    try {
      const publique = new m.client.ClientHttp();
      await expect(publique.get(url, { timeout: 3 })).rejects.toMatchObject({ name: "ConnectError" });
      await publique.aclose();
      const interne = new m.client.ClientHttp({ autorites: [CA_TEST] });
      const r = await interne.get(url, { timeout: 3 });
      expect(r.json()).toEqual({ ok: true });
      expect((await interne.get(url, { timeout: 3 })).statusCode).toBe(200);
      await interne.aclose();
      const nonHachee = path.join(DOSSIER_MOTEUR, "ca-seule-non-hachee");
      mkdirSync(nonHachee, { recursive: true });
      writeFileSync(path.join(nonHachee, "interne.pem"), CA_TEST);
      const capath = new m.client.ClientHttp({
        autorites: m.client.autoritesTls({ SSL_CERT_DIR: nonHachee }),
      });
      await expect(capath.get(url, { timeout: 3 })).rejects.toMatchObject({ name: "ConnectError" });
      await capath.aclose();
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((ok) => srv.close(() => ok()));
    }
  });
});
