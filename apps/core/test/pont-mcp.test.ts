// SPDX-License-Identifier: MIT
/** apps/core/test/pont-mcp.test.ts — relais /api/mcp-bridge rejoué contre mcp/bridge.py (vecteurs) avec un amont d'écho, puis veille du jeton, déconnexion et arrêt. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as requeteHttp } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUser,
  dependancesParDefaut,
  exchangeCode,
  getClient,
  issueCode,
  registerClient,
} from "@elpis/auth";
import type { ClientOAuth, DependancesOAuth } from "@elpis/auth";
import { pyJsonDumps } from "@elpis/commun";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste, verifyDelegation } from "@elpis/mcp";
import { tokenDigest } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerPontMcp } from "../src/familles/pont-mcp";
import type { PontMcp } from "../src/familles/pont-mcp";
import { appTest, enTetesSeules, journalMuet } from "./aides";

interface Etape {
  m?: string;
  u?: string;
  entetes?: Record<string, string>;
  corps?: string;
  manifeste?: string;
  config?: unknown;
}

interface Reponse {
  statut: number;
  corps: string;
  entetes: Record<string, string>;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/pont-mcp.json", import.meta.url), "utf-8")) as {
  service: string;
  appmcp: string;
  jetons: [string, string, string, string, number | null][];
  relayes: string[];
  entetes: string[];
  etapes: Etape[];
  manifestes: Record<string, unknown>;
  ids: Record<string, number>;
  oauth: string;
  reponses: (Reponse | null)[];
};

const T0 = 1_800_000_000;

/** Amont d'écho identique à celui du générateur : délégation vérifiée, en-têtes relayés, statut, flux SSE ou coupure. */
function serveurEcho(horloge: () => number): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const morceaux: Buffer[] = [];
    req.on("data", (m: Buffer) => morceaux.push(m));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://amont");
      const auth = req.headers.authorization ?? "";
      let cle: string | null = null;
      let claims: Record<string, unknown> | null = null;
      for (const [nom, k] of [
        ["service", V.service],
        ["app", V.appmcp],
      ] as const) {
        const c = verifyDelegation(auth.startsWith("Bearer ") ? auth.slice(7) : "", k, { now: horloge() });
        if (c) {
          cle = nom;
          claims = Object.fromEntries(["sub", "uid", "kind", "families"].map((x) => [x, c[x] ?? null]));
          break;
        }
      }
      const premiere = (h: string): string | undefined => {
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
          if (req.rawHeaders[i]?.toLowerCase() === h) return req.rawHeaders[i + 1];
        return undefined;
      };
      const entetes: Record<string, string> = {};
      for (const h of V.relayes) {
        const v = premiere(h);
        if (v !== undefined) entetes[h] = v;
      }
      const echo = pyJsonDumps({
        methode: req.method,
        chemin: req.url,
        entetes,
        delegation: cle,
        claims,
        corps: Buffer.concat(morceaux).toString("utf-8"),
      });
      if (url.searchParams.has("sse")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "mcp-session-id": "s-1",
          "x-amont": "oui",
          "keep-alive": "timeout=5",
          "proxy-authenticate": "Basic",
        });
        res.write(`event: message\ndata: ${echo}\n\n`);
        res.end("data: fin\n\n");
        return;
      }
      if (url.searchParams.has("coupe")) {
        res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
        res.write("debut", () => res.socket?.destroy());
        return;
      }
      res.writeHead(Number(url.searchParams.get("statut") ?? 200), {
        "content-type": "application/json",
        "mcp-session-id": "s-1",
        "x-amont": "oui",
        "keep-alive": "timeout=5",
        "content-length": String(Buffer.byteLength(echo)),
      });
      res.end(echo);
    });
  });
}

function ecouter(serveur: Server): Promise<number> {
  return new Promise((fin) =>
    serveur.listen(0, "127.0.0.1", () => fin((serveur.address() as AddressInfo).port)),
  );
}

function appeler(
  port: number,
  methode: string,
  chemin: string,
  entetes: Record<string, string>,
  corps?: string,
): Promise<Reponse> {
  return new Promise((fin, echec) => {
    const r = requeteHttp(
      {
        host: "127.0.0.1",
        port,
        method: methode,
        path: chemin,
        headers: { host: "testserver", connection: "close", ...entetes },
      },
      (res) => {
        const morceaux: Buffer[] = [];
        res.on("data", (m: Buffer) => morceaux.push(m));
        res.on("end", () => {
          const vus: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined) vus[k] = Array.isArray(v) ? v.join(", ") : v;
          fin({
            statut: res.statusCode ?? 0,
            corps: Buffer.concat(morceaux).toString("utf-8"),
            entetes: vus,
          });
        });
        res.on("error", echec);
      },
    );
    r.on("error", echec);
    r.end(corps);
  });
}

describe("relais MCP sous l'origine de l'app", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let pont: PontMcp;
  let echo: Server;
  let portEcho: number;
  let portMort: number;
  let portApp: number;
  let dossier: string;
  let restaurer: () => void;
  const horloge = T0;
  let compteur = 0;
  let oauth: DependancesOAuth;

  const poserManifeste = (nom: string): void => {
    const port = nom === "mort" ? portMort : portEcho;
    const texte = JSON.stringify(V.manifestes[nom === "mort" ? "ecoute" : nom])
      .replaceAll("127.0.0.1:9/", `127.0.0.1:${port}/`)
      .replaceAll('127.0.0.1:9"', `127.0.0.1:${port}"`);
    writeFileSync(join(dossier, "mcp.json"), texte);
    oublierManifeste();
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [nom, admin] of [
      ["alice", 1],
      ["bob", 0],
    ] as const)
      await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
    for (const [nom, type, jeton, familles, expire] of V.jetons)
      await t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          V.ids[nom] ?? 0,
          type,
          type,
          tokenDigest(jeton),
          jeton.slice(-4),
          familles,
          T0,
          expire === null ? null : T0 + expire,
        ],
      );
    dossier = mkdtempSync(join(tmpdir(), "elpis-pont-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    echo = serveurEcho(() => horloge);
    portEcho = await ecouter(echo);
    const mort = createServer();
    portMort = await ecouter(mort);
    await new Promise<void>((fin) => mort.close(() => fin()));
    poserManifeste("ecoute");
    oauth = {
      base: t.base,
      config: () => configView(),
      maintenant: () => horloge,
      jetonUrl: (n) => `U${String(++compteur).padStart(3, "0")}`.padEnd(Math.ceil((4 * n) / 3), "u"),
      jetonHex: (n) => `H${String(++compteur).padStart(3, "0")}`.padEnd(2 * n, "0"),
    };
    pont = creerPontMcp({
      jetons: { ...dependancesParDefaut(t.base), maintenant: () => horloge },
      oauth,
      journal: journalMuet,
      reverificationMs: 50,
    });
    app = await appTest({ familles: [pont.famille], extensions: [pont.extension] });
    await app.listen({ port: 0, host: "127.0.0.1" });
    portApp = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    try {
      await app?.close();
      echo?.closeAllConnections();
      await new Promise<void>((fin) => (echo ? echo.close(() => fin()) : fin()));
    } finally {
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("rejoue les étapes et rend les mêmes réponses que bridge.py (vecteurs)", async () => {
    const c = (await registerClient(oauth, {
      redirect_uris: ["http://127.0.0.1:9/cb"],
      token_endpoint_auth_method: "none",
    })) as { client_id: string };
    const v = "v".repeat(43);
    const { createHash } = await import("node:crypto");
    const code = await issueCode(oauth, {
      client_id: c.client_id,
      user_id: V.ids["alice"] ?? 0,
      redirect_uri: "",
      code_challenge: createHash("sha256").update(v).digest("base64url"),
      resource: "http://testserver/api/mcp-bridge",
      families: ["fs"],
    });
    const paire = await exchangeCode(oauth, {
      code,
      client: (await getClient(t.base, c.client_id)) as ClientOAuth,
      redirectUri: "",
      codeVerifier: v,
      resource: null,
      appUrl: "http://testserver",
    });
    expect(paire["access_token"]).toBe(V.oauth);
    for (const [i, e] of V.etapes.entries()) {
      if (e.manifeste !== undefined) {
        poserManifeste(e.manifeste);
        continue;
      }
      if (e.config !== undefined) {
        writeFileSync(join(dossier, "config.json"), JSON.stringify(e.config));
        invalidateConfigCache();
        continue;
      }
      const entetes = Object.fromEntries(
        Object.entries(e.entetes ?? {}).map(([k, x]) => [k, x.replace("{oauth}", V.oauth)]),
      );
      const r = await appeler(portApp, e.m ?? "GET", e.u ?? "/", entetes, e.corps);
      const attendu = V.reponses[i] as Reponse;
      const garde = (h: Record<string, string>): Record<string, string> =>
        Object.fromEntries(
          V.entetes.flatMap((k) =>
            h[k] === undefined ? [] : [[k, k === "content-type" ? (h[k].split(";")[0] ?? "") : h[k]]],
          ),
        );
      expect(
        { statut: r.statut, corps: r.corps, entetes: garde(r.entetes) },
        `étape ${i} : ${e.m ?? ""} ${e.u ?? ""}`,
      ).toEqual({ ...attendu, entetes: garde(attendu.entetes) });
    }
    poserManifeste("ecoute");
  });

  it("ferme un flux GET dont le jeton est révoqué, et à l'arrêt", async () => {
    let fermer: (() => void) | undefined;
    const lent = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ouvert\n\n");
      fermer = () => res.end();
    });
    const port = await ecouter(lent);
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify(V.manifestes["ecoute"]).replaceAll("127.0.0.1:9", `127.0.0.1:${port}`),
    );
    oublierManifeste();
    const jeton = "ept_" + "r".repeat(40);
    await t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [V.ids["alice"] ?? 0, "tools", "tools", tokenDigest(jeton), jeton.slice(-4), "fs", T0],
    );
    const flux = appeler(portApp, "GET", "/api/mcp-bridge/fs", { authorization: `Bearer ${jeton}` });
    await vi.waitFor(() => expect(fermer).toBeDefined());
    await t.base.run("DELETE FROM tool_tokens WHERE token_hash=?", [tokenDigest(jeton)]);
    const r = await flux;
    expect([r.statut, r.corps]).toEqual([200, "data: ouvert\n\n"]);
    fermer = undefined;
    await t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [V.ids["alice"] ?? 0, "tools", "tools", tokenDigest(jeton), jeton.slice(-4), "fs", T0],
    );
    const second = appeler(portApp, "GET", "/api/mcp-bridge/fs", { authorization: `Bearer ${jeton}` });
    await vi.waitFor(() => expect(fermer).toBeDefined());
    await pont.fermer();
    expect((await second).corps).toBe("data: ouvert\n\n");
    await new Promise<void>((fin) => lent.close(() => fin()));
    lent.closeAllConnections();
  });

  it("POST : origine et jeton vérifiés avant la lecture du corps ; DELETE : corps jamais lu", async () => {
    poserManifeste("ecoute");
    const sans = await enTetesSeules(portApp, "POST", "/api/mcp-bridge/fs");
    expect(sans).toBe("HTTP/1.1 401 Unauthorized");
    expect(
      await enTetesSeules(
        portApp,
        "POST",
        "/api/mcp-bridge/fs",
        `Authorization: Bearer ept_${"z".repeat(40)}\r\n`,
      ),
    ).toBe("HTTP/1.1 401 Unauthorized");
    expect(
      await enTetesSeules(portApp, "POST", "/api/mcp-bridge", "Origin: https://ailleurs.example\r\n"),
    ).toBe("HTTP/1.1 403 Forbidden");
    expect(await enTetesSeules(portApp, "DELETE", "/api/mcp-bridge/fs")).toBe("HTTP/1.1 401 Unauthorized");
  });
});
