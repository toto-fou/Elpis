// SPDX-License-Identifier: MIT
/** packages/auth/test/oauth-telechargement.test.ts — document CIMD téléchargé en https épinglé : SNI et certificat sur le nom d'origine, statut, taille, chemin encodé. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErreurOAuth, telechargerEpingle } from "../src/oauth";

describe("téléchargement épinglé d'un document de client", () => {
  let dossier: string;
  let serveur: Server;
  let port = 0;
  let caPem = "";
  const vus: { chemin: string; hote: string | undefined }[] = [];
  const parDefaut = getCACertificates("default");

  /** Autorité de test et certificat de « cimd.test » signés par openssl dans un dossier temporaire. */
  function certificats(): { cle: string; cert: string } {
    const o = (args: string[]): void => {
      execFileSync("openssl", args, { cwd: dossier, stdio: "ignore" });
    };
    o(
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        "ca.key",
      ].concat(["-out", "ca.pem", "-subj", "/CN=Elpis test CA", "-days", "2"]),
    );
    o(
      ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "srv.key"].concat([
        "-out",
        "srv.csr",
        "-subj",
        "/CN=cimd.test",
      ]),
    );
    writeFileSync(join(dossier, "ext.cnf"), "subjectAltName=DNS:cimd.test\n");
    o(
      ["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial"].concat([
        "-out",
        "srv.pem",
        "-days",
        "2",
        "-extfile",
        "ext.cnf",
      ]),
    );
    caPem = readFileSync(join(dossier, "ca.pem"), "utf-8");
    return {
      cle: readFileSync(join(dossier, "srv.key"), "utf-8"),
      cert: readFileSync(join(dossier, "srv.pem"), "utf-8"),
    };
  }

  beforeAll(async () => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-cimd-"));
    const { cle, cert } = certificats();
    serveur = createServer({ key: cle, cert }, (req, res) => {
      vus.push({ chemin: req.url ?? "", hote: req.headers.host });
      if (req.url === "/absent") res.writeHead(404).end("non");
      else if (req.url === "/redirige") res.writeHead(302, { location: "/doc.json" }).end();
      else if (req.url === "/gros") res.writeHead(200).end("x".repeat(64 * 1024 + 1));
      else
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(`{"chemin": ${JSON.stringify(req.url)}}`);
    });
    await new Promise<void>((fin) => serveur.listen(0, "127.0.0.1", () => fin()));
    port = (serveur.address() as AddressInfo).port;
  });

  afterAll(async () => {
    setDefaultCACertificates(parDefaut);
    try {
      await new Promise<void>((fin) => (serveur ? serveur.close(() => fin()) : fin()));
    } finally {
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  const refus = async (url: string): Promise<string> => {
    try {
      await telechargerEpingle(url, "127.0.0.1");
      return "accepté";
    } catch (e) {
      return e instanceof ErreurOAuth ? e.description : String(e);
    }
  };

  it("certificat d'une autorité inconnue : injoignable", async () => {
    setDefaultCACertificates(parDefaut);
    expect(await refus(`https://cimd.test:${port}/doc.json`)).toBe(
      "Document de client injoignable depuis ce serveur.",
    );
  });

  it("épinglé sur l'adresse, SNI et Host sur le nom d'origine, chemin encodé comme httpx", async () => {
    setDefaultCACertificates([...parDefaut, caPem]);
    const lu = await telechargerEpingle(`https://cimd.test:${port}/doc.json?v=1`, "127.0.0.1");
    expect(Buffer.from(lu).toString()).toBe('{"chemin": "/doc.json?v=1"}');
    expect(vus.at(-1)).toEqual({ chemin: "/doc.json?v=1", hote: `cimd.test:${port}` });
    await telechargerEpingle(`https://cimd.test:${port}/a b/é.json`, "127.0.0.1");
    expect(vus.at(-1)?.chemin).toBe("/a%20b/%C3%A9.json");
    expect(await refus(`https://autre.test:${port}/doc.json`)).toBe(
      "Document de client injoignable depuis ce serveur.",
    );
    expect(await refus(`https://cimd.test:${port}/absent`)).toBe("Document de client introuvable.");
    expect(await refus(`https://cimd.test:${port}/redirige`)).toBe("Document de client introuvable.");
    expect(await refus(`https://cimd.test:${port}/gros`)).toBe("Document de client trop volumineux.");
    expect(await refus(`https://cimd.test:1/doc.json`)).toBe(
      "Document de client injoignable depuis ce serveur.",
    );
  });
});
