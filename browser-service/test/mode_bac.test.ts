// SPDX-License-Identifier: MIT
// browser-service/test/mode_bac.test.ts — relais local du bac : boucle locale directe, tout le reste par le relais de l'hôte (socket unix, jeton), refus du relais rendu au navigateur.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { demarrerRelais } from "../src/proxy_guard.ts";
import { verifierBac } from "../src/url_guard.ts";

type Recue = { methode?: string; url?: string; auth: string };

// Faux relais de l'hôte sur socket unix : note les requêtes reçues, refuse « refuse.test ».
function fauxRelais(chemin: string, recues: Recue[]): Promise<http.Server> {
  const s = http.createServer((req, res) => {
    recues.push({ methode: req.method, url: req.url, auth: req.headers["proxy-authorization"] || "" });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("via relais");
  });
  s.on("connect", (req, client) => {
    recues.push({ methode: "CONNECT", url: req.url, auth: req.headers["proxy-authorization"] || "" });
    if (req.url!.startsWith("refuse.test")) {
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.on("data", (d) => client.write(`echo:${d}`));
  });
  return new Promise((r) => s.listen(chemin, () => r(s)));
}

test("http, tunnel et refus passent par le relais de l’hôte, avec le jeton ; la boucle locale reste directe", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "bac-relais-"));
  const chemin = path.join(dossier, "relais.sock");
  const recues: Recue[] = [];
  const amontSrv = await fauxRelais(chemin, recues);
  const locale = http.createServer((_q, r) => r.end("local")).listen(0, "127.0.0.1");
  await new Promise((r) => locale.once("listening", r));
  const relais = await demarrerRelais({ verifier: verifierBac(), amont: { socket: chemin, jeton: "j3t0n" } });
  try {
    const get = (url: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port: relais.port,
              path: url,
              agent: false,
              headers: { host: new URL(url).host },
            },
            (res) => {
              let c = "";
              res.on("data", (d) => {
                c += d;
              });
              res.on("end", () => resolve(c));
            },
          )
          .on("error", reject);
      });
    assert.equal(await get("http://intranet.lan/page?a=1"), "via relais");
    assert.equal(await get(`http://localhost:${(locale.address() as AddressInfo).port}/`), "local");
    const tunnel = (cible: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(relais.port, "127.0.0.1", () =>
          s.write(`CONNECT ${cible} HTTP/1.1\r\nHost: ${cible}\r\n\r\n`),
        );
        let t = "";
        s.on("data", (d) => {
          t += d;
          if (t.includes("200 Connection Established\r\n\r\n") && !t.includes("echo:")) s.write("ping");
          if (t.includes("echo:ping") || t.includes("403")) {
            s.destroy();
            resolve(t);
          }
        });
        s.on("end", () => resolve(t));
      });
    assert.match(await tunnel("site.example:443"), /echo:ping/);
    assert.match(await tunnel("refuse.test:443"), /^HTTP\/1\.1 403/);
    assert.deepEqual(
      recues.map((r) => [r.methode, r.url, r.auth]),
      [
        ["GET", "http://intranet.lan/page?a=1", "Bearer j3t0n"],
        ["CONNECT", "site.example:443", "Bearer j3t0n"],
        ["CONNECT", "refuse.test:443", "Bearer j3t0n"],
      ],
    );
  } finally {
    locale.closeAllConnections();
    amontSrv.closeAllConnections();
    await relais.close();
    locale.close();
    amontSrv.close();
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});
