// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/requetes.test.ts — client d'annotation sur le fil : corps et en-têtes de requests, pannes nommées comme requests, TLS, Stop, pools fermés. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  corpsJsonRequests,
  detect,
  encodageReponse,
  ErreurRequests,
  jsonReponse,
  multipartRequests,
  readText,
  texteReponse,
  validerEntetes,
  validerUrl,
  verifierSchema,
} from "../../src/bureau";
import { CancelledError } from "../../src/llm/client-http";
import { FauxMoteur } from "../images/faux-moteur";
import { CA_TEST, CERT_SERVEUR, CLE_SERVEUR } from "../llm/pki-test";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const moteurs: FauxMoteur[] = [];

async function moteur(options: { cert?: string; cle?: string } = {}): Promise<FauxMoteur> {
  const m = await FauxMoteur.demarrer(options);
  moteurs.push(m);
  return m;
}

afterEach(async () => {
  for (const m of moteurs.splice(0)) await m.arreter();
  delete process.env["REQUESTS_CA_BUNDLE"];
});

const chat = (contenu: string): string => JSON.stringify({ choices: [{ message: { content: contenu } }] });

async function portFerme(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

describe("requêtes sur le fil", () => {
  it("LLM multimodal : corps JSON de requests, en-têtes, deux passes, pool fermé", async () => {
    const m = await moteur();
    m.file("POST /v1/chat/completions", [
      {
        texte: chat('[{"label": "Été", "box": [0.1, 0.1, 0.9, 0.9]}]'),
        entetes: { "content-type": "application/json" },
      },
      { texte: chat("[]"), entetes: { "content-type": "application/json" } },
    ]);
    const r = await detect(PNG_1x1, {
      endpoint: m.url,
      fmt: "llm-chat",
      model: "vl",
      authToken: "Bearer s3cret",
      timeout: 5,
      nativeW: 100,
      nativeH: 100,
    });
    expect(r).toEqual({
      elements: [{ label: "Été", box: [10, 10, 90, 90], center: [50, 50], confidence: 0, source: "vision" }],
      erreur: "",
    });
    const [premiere] = m.sur("/v1/chat/completions");
    expect(premiere?.entetes["content-type"]).toBe("application/json");
    expect(premiere?.entetes["authorization"]).toBe("Bearer s3cret");
    expect(premiere?.entetes["user-agent"]).toBe("elpis-core");
    const corps = JSON.parse(premiere?.corps.toString("utf-8") ?? "{}") as Record<string, unknown>;
    expect(premiere?.corps.equals(corpsJsonRequests(corps))).toBe(true);
    expect(premiere?.corps.toString("utf-8")).toContain('"stream": false, "model": "vl"}');
    expect(m.sur("/v1/chat/completions")).toHaveLength(2);
    await new Promise((ok) => setTimeout(ok, 50));
    expect((m as unknown as { sockets: Set<unknown> }).sockets.size).toBe(0);
  });

  it("détecteur en multipart : fichier et prompt au format de requests (frontière réelle)", async () => {
    const m = await moteur();
    m.file("POST /parse", [{ texte: JSON.stringify({ elements: [{ bbox: [0, 0, 1, 1], label: "x" }] }) }]);
    const r = await detect(PNG_1x1, {
      endpoint: `${m.url}/parse`,
      prompt: 'é"',
      responseMap: { request_mode: "multipart", file_field: "img" },
      nativeW: 1,
      nativeH: 1,
    });
    expect(r.elements).toHaveLength(1);
    const req = m.sur("/parse")[0];
    const type = String(req?.entetes["content-type"]);
    const frontiere = /boundary=([0-9a-f]{32})$/.exec(type)?.[1] ?? "";
    expect(frontiere).toHaveLength(32);
    const attendu = multipartRequests(
      [["prompt", 'é"']],
      [{ champ: "img", nom: "screenshot.png", type: "image/png", data: PNG_1x1 }],
      frontiere,
    );
    expect(req?.corps.equals(attendu.corps)).toBe(true);
  });

  it("pannes nommées comme requests : port fermé, délai de lecture, corps tronqué, réponse non JSON", async () => {
    const ferme = await portFerme();
    expect(
      (await detect(PNG_1x1, { endpoint: `http://127.0.0.1:${ferme}/x`, nativeW: 1, nativeH: 1 })).erreur,
    ).toBe("endpoint injoignable (ConnectionError)");
    const m = await moteur();
    m.file("POST /v1/chat/completions", [{ delai: true }]);
    const lent = await readText(PNG_1x1, { endpoint: m.url, timeout: 0.2 });
    expect(lent).toEqual({ texte: null, erreur: "endpoint LLM injoignable (ReadTimeout)" });
    m.route("POST /tronque", (_req, rep) => {
      rep.writeHead(200, { "content-length": "100", "content-type": "application/json" });
      rep.write('{"elements"');
      setTimeout(() => rep.socket?.destroy(), 20);
    });
    expect(
      (await detect(PNG_1x1, { endpoint: `${m.url}/tronque`, nativeW: 1, nativeH: 1, timeout: 5 })).erreur,
    ).toBe("endpoint injoignable (ChunkedEncodingError)");
    m.file("POST /html", [{ texte: "<html>", entetes: { "content-type": "text/html" } }]);
    expect((await detect(PNG_1x1, { endpoint: `${m.url}/html`, nativeW: 1, nativeH: 1 })).erreur).toBe(
      "réponse non-JSON de l'endpoint",
    );
  });

  it("redirections suivies comme requests : 307 rejoue le POST et son corps, 303 passe en GET sans corps", async () => {
    const m = await moteur();
    const trouve = JSON.stringify({ elements: [{ bbox: [0, 0, 1, 1], label: "ok" }] });
    m.file("POST /detect", [{ statut: 307, entetes: { location: "/detect/" } }]);
    m.file("POST /detect/", [{ texte: trouve }]);
    const r = await detect(PNG_1x1, {
      endpoint: `${m.url}/detect`,
      authToken: "Bearer t",
      nativeW: 1,
      nativeH: 1,
    });
    expect([r.erreur, r.elements.length]).toEqual(["", 1]);
    const [avant, apres] = [m.sur("/detect")[0], m.sur("/detect/")[0]];
    expect([apres?.methode, apres?.entetes["authorization"], apres?.entetes["content-type"]]).toEqual([
      "POST",
      "Bearer t",
      "application/json",
    ]);
    expect(apres?.corps.equals(avant?.corps ?? Buffer.alloc(0))).toBe(true);
    m.file("POST /file", [{ statut: 303, entetes: { location: `${m.url}/resultat` } }]);
    m.file("GET /resultat", [{ texte: trouve }]);
    const r2 = await detect(PNG_1x1, {
      endpoint: `${m.url}/file`,
      authToken: "Bearer t",
      nativeW: 1,
      nativeH: 1,
    });
    expect([r2.erreur, r2.elements.length]).toEqual(["", 1]);
    const get = m.sur("/resultat")[0];
    expect([
      get?.methode,
      get?.corps.length,
      get?.entetes["content-type"],
      get?.entetes["authorization"],
    ]).toEqual(["GET", 0, undefined, "Bearer t"]);
    await new Promise((ok) => setTimeout(ok, 50));
    expect((m as unknown as { sockets: Set<unknown> }).sockets.size).toBe(0);
  });

  it("TLS : CA de REQUESTS_CA_BUNDLE acceptée, certificat inconnu refusé (SSLError)", async () => {
    const m = await moteur({ cert: CERT_SERVEUR, cle: CLE_SERVEUR });
    m.file("POST /v1/chat/completions", [
      { texte: chat("lu"), entetes: { "content-type": "application/json" } },
    ]);
    expect((await readText(PNG_1x1, { endpoint: m.url })).erreur).toBe("endpoint LLM injoignable (SSLError)");
    const dossier = mkdtempSync(join(tmpdir(), "elpis-ca-"));
    onTestFinished(() => rmSync(dossier, { recursive: true, force: true }));
    writeFileSync(join(dossier, "ca.pem"), CA_TEST);
    process.env["REQUESTS_CA_BUNDLE"] = join(dossier, "ca.pem");
    expect(await readText(PNG_1x1, { endpoint: m.url })).toEqual({ texte: "lu", erreur: "" });
  });

  it("Stop : la requête en cours est abandonnée (CancelledError), aucune connexion ne reste", async () => {
    const m = await moteur();
    m.file("POST /v1/chat/completions", [{ delai: true }]);
    const controleur = new AbortController();
    m.surRequete = () => controleur.abort();
    await expect(readText(PNG_1x1, { endpoint: m.url, signal: controleur.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
    await new Promise((ok) => setTimeout(ok, 50));
    expect((m as unknown as { sockets: Set<unknown> }).sockets.size).toBe(0);
    await expect(
      detect(PNG_1x1, { endpoint: m.url, signal: controleur.signal, fmt: "llm" }),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("préparation et lecture comme requests", () => {
  it("adresses : schéma absent, sans hôte, sans transport", () => {
    const nom = (f: () => unknown): string | null => {
      try {
        f();
        return null;
      } catch (e) {
        return e instanceof ErreurRequests ? e.name : "autre";
      }
    };
    expect(nom(() => validerUrl("det/x"))).toBe("MissingSchema");
    expect(nom(() => validerUrl("/x"))).toBe("MissingSchema");
    expect(nom(() => validerUrl("http://"))).toBe("InvalidURL");
    expect(nom(() => validerUrl("http:x"))).toBe("InvalidURL");
    expect(nom(() => validerUrl("http://h:99999/"))).toBe("InvalidURL");
    expect(validerUrl("  http://h/x")).toBe("http://h/x");
    expect(nom(() => verifierSchema(validerUrl("llm:8080/v1")))).toBe("InvalidSchema");
    expect(nom(() => verifierSchema("ftp://h/x"))).toBe("InvalidSchema");
    expect(nom(() => verifierSchema("HTTPS://h/x"))).toBeNull();
  });

  it("en-têtes : blanc de tête ou retour à la ligne refusés", () => {
    expect(() => validerEntetes({ Authorization: " Bearer x" })).toThrow(ErreurRequests);
    expect(() => validerEntetes({ Authorization: "a\rb" })).toThrow(ErreurRequests);
    expect(() => validerEntetes({ " X": "v" })).toThrow(ErreurRequests);
    expect(() => validerEntetes({ Authorization: "Bearer x", "X-Vide": "" })).not.toThrow();
  });

  it("encodage de la réponse : charset, texte en latin-1, JSON en UTF-8, sinon deviné", () => {
    expect(encodageReponse("application/json")).toBe("utf-8");
    expect(encodageReponse("text/plain")).toBe("ISO-8859-1");
    expect(encodageReponse('application/json; Charset="UTF-16"')).toBe("UTF-16");
    expect(encodageReponse("Text/Plain")).toBeNull();
    expect(encodageReponse(null)).toBeNull();
    expect(encodageReponse(`text/html; " Charset" = "'UTF-8'"`)).toBe("UTF-8");
    const debut = performance.now();
    expect(encodageReponse(`text/plain; a${"'".repeat(60_000)}b`)).toBe("ISO-8859-1");
    expect(encodageReponse(`text/plain; charset=a${" ".repeat(60_000)}b`)).toBe(`a${" ".repeat(60_000)}b`);
    expect(performance.now() - debut).toBeLessThan(1000);
    const r = (corps: Buffer, type: string | null) => ({ statut: 200, corps, typeContenu: type });
    expect(texteReponse(r(Buffer.from("é", "utf-8"), "text/plain"))).toBe("Ã©");
    expect(texteReponse(r(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "application/json"))).toBe("﻿a");
    expect(texteReponse(r(Buffer.from([0x61, 0xe9]), "text/x; charset=ascii"))).toBe("a�");
    expect(jsonReponse(r(Buffer.from('{"a": 1}', "utf16le"), null))).toEqual({ a: 1 });
    expect(
      jsonReponse(r(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[1, 2]", "utf16le")]), null)),
    ).toEqual([1, 2]);
    expect(jsonReponse(r(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("[3]")]), null))).toEqual([3]);
    expect(() =>
      jsonReponse(r(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("[3]")]), "application/json")),
    ).toThrow();
  });

  it("multipart : seuls guillemet, CR et LF des noms sont encodés", () => {
    const m = multipartRequests(
      [['a"b', "v\r\n"]],
      [{ champ: "f\n", nom: 'n"', type: "image/png", data: Buffer.from("x") }],
      "b".repeat(32),
    );
    expect(m.corps.toString("utf-8")).toBe(
      `--${"b".repeat(32)}\r\nContent-Disposition: form-data; name="a%22b"\r\n\r\nv\r\n\r\n` +
        `--${"b".repeat(32)}\r\nContent-Disposition: form-data; name="f%0A"; filename="n%22"\r\nContent-Type: image/png\r\n\r\nx\r\n` +
        `--${"b".repeat(32)}--\r\n`,
    );
  });
});
