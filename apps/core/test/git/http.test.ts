// SPDX-License-Identifier: MIT
/** apps/core/test/git/http.test.ts — client `httpJson` : identifiants retirés hors de l'hôte ou vers http, adresses épinglées, corps plafonné, URL ambiguë, TLS illisible, jeton jamais dans une erreur ; POST JSON redirigé comme urllib ; urljoin de CPython. */
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { brancherAdressesInterdites } from "../../src/git/garde";
import { httpJson, PLAFOND_CORPS, retirerIdentifiants } from "../../src/git/http";
import { urljoin } from "@elpis/commun";

describe("httpJson contre un faux serveur (boucle locale permise ici seulement)", () => {
  let srv: Server;
  let port = 0;
  const vus: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    brancherAdressesInterdites(() => false);
    srv = createServer((req, res) => {
      if (req.url === "/autre-hote") {
        res.writeHead(302, { location: `http://localhost:${port}/fin` });
        res.end();
        return;
      }
      if (req.url === "/meme-hote") {
        res.writeHead(302, { location: "/fin" });
        res.end();
        return;
      }
      if (req.url === "/gros") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(Buffer.alloc(PLAFOND_CORPS + 1, 0x61));
        return;
      }
      if (req.url === "/pile") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"x":"${"a".repeat(PLAFOND_CORPS - 8)}"}`);
        return;
      }
      vus.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok": 1}');
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    port = (srv.address() as AddressInfo).port;
  });

  afterAll(async () => {
    brancherAdressesInterdites(null);
    await new Promise((ok) => srv.close(ok));
  });

  const options = () => ({
    headers: { Authorization: "Bearer secret", "PRIVATE-TOKEN": "glpat", "X-Autre": "garde" },
    ssrfAllowHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  });

  it("une redirection vers un autre hôte ne transporte ni Authorization ni PRIVATE-TOKEN", async () => {
    vus.length = 0;
    const r = await httpJson(`http://127.0.0.1:${port}/autre-hote`, options());
    expect(r["ok"]).toBe(true);
    expect(vus[0]?.authorization).toBeUndefined();
    expect(vus[0]?.["private-token"]).toBeUndefined();
    expect(vus[0]?.["x-autre"]).toBe("garde");
    expect(vus[0]?.["user-agent"]).toBe("elpis-git/1");
  });

  it("sur le même hôte et le même schéma, les identifiants restent", async () => {
    vus.length = 0;
    await httpJson(`http://127.0.0.1:${port}/meme-hote`, options());
    expect(vus[0]?.authorization).toBe("Bearer secret");
    expect(vus[0]?.["private-token"]).toBe("glpat");
  });

  it("la connexion réutilise les adresses validées : une résolution par requête, aucune autre", async () => {
    vus.length = 0;
    const resolutions: string[] = [];
    const r = await httpJson(`http://depot-inconnu.test:${port}/meme-hote`, {
      ...options(),
      ssrfAllowHosts: [`depot-inconnu.test:${port}`],
      resoudre: (h) => {
        resolutions.push(h);
        return Promise.resolve(["127.0.0.1"]);
      },
    });
    expect(r["ok"]).toBe(true);
    expect(resolutions).toEqual(["depot-inconnu.test", "depot-inconnu.test"]);
    expect(vus).toHaveLength(1);
  });

  it("corps plafonné à 8 Mio, lu en flux", async () => {
    expect(await httpJson(`http://127.0.0.1:${port}/gros`, options())).toEqual({
      ok: false,
      status: 0,
      error: "Network: réponse de plus de 8 Mio refusée",
    });
    expect((await httpJson(`http://127.0.0.1:${port}/pile`, options()))["ok"]).toBe(true);
  });

  it("un jeton invalide pour un en-tête n'apparaît jamais dans le message d'erreur", async () => {
    const r = await httpJson(`http://127.0.0.1:${port}/x`, {
      ...options(),
      headers: { Authorization: "Bearer debut\nsecret-tres-prive" },
    });
    expect(r["ok"]).toBe(false);
    expect(JSON.stringify(r)).not.toContain("secret-tres-prive");
  });

  it("une URL que WHATWG lirait vers un autre hôte est refusée sans connexion", async () => {
    const r = await httpJson("http://depot.lan\\.ailleurs.example/x", {
      ssrfAllowHosts: ["depot.lan\\.ailleurs.example"],
      resoudre: () => Promise.resolve(["10.0.0.9"]),
    });
    expect(r).toEqual({ ok: false, status: 0, error: "Network: URL refusée (hôte ambigu)" });
  });
});

describe("httpJson en POST (redirections d'urllib)", () => {
  let srv: Server;
  let port = 0;
  const recus: { methode: string; url: string; auth: string; type: string; corps: string }[] = [];

  beforeAll(async () => {
    brancherAdressesInterdites(() => false);
    srv = createServer((req, res) => {
      let corps = "";
      req.on("data", (m: Buffer) => (corps += m.toString("utf-8")));
      req.on("end", () => {
        recus.push({
          methode: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization ?? "",
          type: req.headers["content-type"] ?? "",
          corps,
        });
        const redirection: Record<string, [number, string]> = {
          "/p302": [302, "/fin"],
          "/p303-autre": [303, `http://localhost:${port}/fin`],
          "/p307": [307, "/fin"],
          "/p308": [308, "/fin"],
        };
        const r = redirection[req.url ?? ""];
        if (r) {
          res.writeHead(r[0], { location: r[1] });
          res.end("redirigé");
          return;
        }
        res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
        res.end('{"number": 3}');
      });
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    port = (srv.address() as AddressInfo).port;
  });

  afterAll(async () => {
    brancherAdressesInterdites(null);
    await new Promise((ok) => srv.close(ok));
  });

  const poster = (chemin: string) =>
    httpJson(`http://127.0.0.1:${port}${chemin}`, {
      method: "POST",
      body: { title: "é", draft: true },
      headers: { Authorization: "Bearer secret" },
      ssrfAllowHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    });

  it("corps en `json.dumps` (ASCII, séparateurs du Python), Content-Type JSON par défaut", async () => {
    recus.length = 0;
    expect(await poster("/creer")).toEqual({ ok: true, status: 201, body: { number: 3 } });
    expect(recus).toEqual([
      {
        methode: "POST",
        url: "/creer",
        auth: "Bearer secret",
        type: "application/json",
        corps: '{"title": "\\u00e9", "draft": true}',
      },
    ]);
  });

  it("301-303 : GET sans corps ni Content-Type ; identifiants retirés si l'hôte change", async () => {
    recus.length = 0;
    expect((await poster("/p302"))["status"]).toBe(200);
    expect((await poster("/p303-autre"))["status"]).toBe(200);
    expect(recus.map((r) => [r.methode, r.url, r.auth, r.type, r.corps])).toEqual([
      ["POST", "/p302", "Bearer secret", "application/json", '{"title": "\\u00e9", "draft": true}'],
      ["GET", "/fin", "Bearer secret", "", ""],
      ["POST", "/p303-autre", "Bearer secret", "application/json", '{"title": "\\u00e9", "draft": true}'],
      ["GET", "/fin", "", "", ""],
    ]);
  });

  it("307 et 308 sur un POST : erreur HTTP, rien n'est renvoyé", async () => {
    recus.length = 0;
    expect(await poster("/p307")).toEqual({
      ok: false,
      status: 307,
      body: "redirigé",
      error: "HTTP 307: Temporary Redirect",
    });
    expect(await poster("/p308")).toEqual({
      ok: false,
      status: 308,
      body: "redirigé",
      error: "HTTP 308: Permanent Redirect",
    });
    expect(recus.map((r) => r.url)).toEqual(["/p307", "/p308"]);
  });
});

describe("httpJson, politique stricte", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("boucle et lien local refusés même pour un hôte enregistré, sans connexion", async () => {
    expect(await httpJson("http://127.0.0.1:9/x", { ssrfAllowHosts: ["127.0.0.1:9"] })).toEqual({
      ok: false,
      status: 0,
      error: "blocked: blocked_ip (127.0.0.1)",
    });
    expect(
      await httpJson("http://depot.lan/x", {
        ssrfAllowHosts: ["depot.lan"],
        resoudre: () => Promise.resolve(["169.254.169.254"]),
      }),
    ).toEqual({ ok: false, status: 0, error: "blocked: resolves_to_blocked (169.254.169.254)" });
  });

  it("une CA illisible donne une réponse d'échec, jamais une exception", async () => {
    vi.stubEnv("SSL_CERT_FILE", join(tmpdir(), "elpis-ca-absente.pem"));
    vi.resetModules();
    const { httpJson: neuf } = await import("../../src/git/http");
    const r = await neuf("http://10.255.255.1/x", { ssrfAllowHosts: ["10.255.255.1"] });
    expect(r["ok"]).toBe(false);
    expect(r["status"]).toBe(0);
    expect(String(r["error"])).toContain("ENOENT");
  });
});

describe("règles pures", () => {
  it("identifiants retirés si l'hôte ou le port change, ou si https passe à http", () => {
    expect(retirerIdentifiants("https://h/a", "http://h/b")).toBe(true);
    expect(retirerIdentifiants("https://h/a", "https://autre/b")).toBe(true);
    expect(retirerIdentifiants("https://h/a", "https://h:8443/b")).toBe(true);
    expect(retirerIdentifiants("http://h:3000/a", "http://h:3001/b")).toBe(true);
    expect(retirerIdentifiants("http://h:3000/a", "https://h/b")).toBe(true);
    expect(retirerIdentifiants("http://h/a", "https://h/b")).toBe(false);
    expect(retirerIdentifiants("https://h/a", "https://h:443/b")).toBe(false);
    expect(retirerIdentifiants("https://h/a", "https://h/b")).toBe(false);
  });

  it("urljoin de CPython 3.13", () => {
    expect(urljoin("http://h/a/b/c", "../d")).toBe("http://h/a/d");
    expect(urljoin("http://h/a/b/c", "//x/y")).toBe("http://x/y");
    expect(urljoin("http://h/a/b", "?q")).toBe("http://h/a/b?q");
    expect(urljoin("http://h/a/b", "../../../z/.")).toBe("http://h/z/");
    expect(urljoin("http://h/a", "ftp://x/y")).toBe("ftp://x/y");
  });
});
