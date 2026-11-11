// SPDX-License-Identifier: MIT
/** apps/toolhost/test/socle.test.ts — porte de l'hôte (jeton, enveloppe, chemins MCP), `/health`, `/manifest` et session d'historique, sur l'app composée. */
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { fabriqueAgent } from "@elpis/bac";
import { IDENTITY_HEADER, current } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Famille } from "../src/app";
import { creerAppToolhost } from "../src/app";
import { composer } from "../src/composition";
import { AgentClient, currentSession } from "@elpis/fichiers";
import {
  configTest,
  dossierTemporaire,
  enveloppe,
  entetes,
  hoteTest,
  journalMuet,
  lignesJournal,
  SVC,
} from "./aides";
import type { HoteTest } from "./aides";

let h: HoteTest;
let dossier: string;
let nettoyer: () => void;

beforeAll(async () => {
  [dossier, nettoyer] = dossierTemporaire("elpis-toolhost-socle-");
  h = await hoteTest(configTest({ transports: ["http", "sse"] }), { demarreA: Date.now() / 1000 - 12 });
});

afterAll(async () => {
  await h.fermer();
  nettoyer();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("porte de l'API", () => {
  it("/health ouvert ; MCP sans amont : aucune famille, aucun transport servi", async () => {
    const r = await h.app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.json()).toMatchObject({
      ok: true,
      service: "elpis-toolhost",
      families: [],
      tools: 0,
      mcp_path: "/mcp",
      sse_path: "",
      transports: [],
      auth: true,
    });
    expect(r.body).toMatch(/"uptime_s":1[23]\.\d\b/u);
    expect(Object.keys(r.json() as object)).toEqual([
      "ok",
      "service",
      "uptime_s",
      "families",
      "tools",
      "mcp_path",
      "sse_path",
      "transports",
      "auth",
    ]);
  });

  it("refus dans l'ordre de ToolhostAuthASGI : jeton absent, faux, enveloppe absente, fausse, périmée", async () => {
    const cas: [Record<string, string>, number, string][] = [
      [{}, 401, "jeton de service requis"],
      [{ authorization: "Bearer faux" }, 401, "jeton de service requis"],
      [{ authorization: `Basic ${SVC}` }, 401, "jeton de service requis"],
      [{ authorization: `Bearer ${SVC}é` }, 401, "jeton de service requis"],
      [{ authorization: `Bearer ${SVC}` }, 401, "enveloppe d'identité absente ou invalide"],
      [
        { authorization: `Bearer ${SVC}`, [IDENTITY_HEADER]: enveloppe(7, "hugo", "autre-cle") },
        401,
        "enveloppe d'identité absente ou invalide",
      ],
      [
        {
          authorization: `Bearer ${SVC}`,
          [IDENTITY_HEADER]: enveloppe(7, "hugo", SVC, Date.now() / 1000 - 120),
        },
        401,
        "enveloppe d'identité absente ou invalide",
      ],
    ];
    for (const [hdrs, statut, detail] of cas) {
      const r = await h.app.inject({ method: "GET", url: "/manifest", headers: hdrs });
      expect(r.statusCode, JSON.stringify(hdrs)).toBe(statut);
      expect(r.body).toBe(`{"detail": "${detail}"}`);
      expect(r.headers["www-authenticate"]).toBe("Bearer");
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    }
  });

  it("chemin inconnu ou paramètre de chemin vide : refusé avant le routage sans preuves, 404 en texte avec (montage MCP, JSON si saut de ligne intérieur), jamais 405", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/sandbox/inconnu" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/api/desktop/frame/" })).statusCode).toBe(401);
    for (const [methode, url] of [
      ["GET", "/api/sandbox/inconnu"],
      ["POST", "/manifest"],
      ["DELETE", "/internal/file-history/session"],
      ["GET", "/manifest/"],
      ["GET", "/api/desktop/frame/"],
      ["GET", "/api/playwright/screenshot/"],
    ] as const) {
      const r = await h.app.inject({ method: methode, url, headers: entetes() });
      expect(r.statusCode, `${methode} ${url}`).toBe(404);
      expect(r.body).toBe("Not Found");
      expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    }
    for (const methode of ["POST", "HEAD", "PUT"] as const) {
      const r = await h.app.inject({ method: methode, url: "/health" });
      expect(r.statusCode, methode).toBe(404);
    }
    const n = await h.app.inject({ method: "GET", url: "/api/a%0Ab", headers: entetes() });
    expect([n.statusCode, n.json()]).toEqual([404, { detail: "Not Found" }]);
  });

  it("hôte sans jeton de service : API fermée (503), /health ouvert", async () => {
    const sans = await hoteTest(configTest({ token: "" }));
    try {
      const r = await sans.app.inject({ method: "GET", url: "/manifest", headers: entetes() });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ detail: "hôte d'outils sans jeton de service : API sandbox fermée" });
      expect(r.body).toContain("hôte d'outils");
      expect((await sans.app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
        auth: false,
      });
    } finally {
      await sans.fermer();
    }
  });

  it("la composition pose la fabrique d'agent du bac (AgentClient) et la retire à la fermeture", async () => {
    const c = composer(configTest(), { journal: journalMuet });
    const fabrique = fabriqueAgent();
    expect(fabrique).not.toBeNull();
    const bac = {
      sandboxPath: "/srv/sb/alice",
      status: vi.fn(),
      ensureRunning: vi.fn(),
      startAgent: vi.fn(),
    };
    const client = fabrique?.(bac);
    expect(client).toBeInstanceOf(AgentClient);
    expect((client as AgentClient).socketPath).toBe("/srv/sb/.elpis-agent/agent.sock");
    await c.fermer();
    expect(fabriqueAgent()).toBeNull();
  });

  it("l'identité de l'enveloppe est le contexte de la requête, corps lu compris", async () => {
    const tc = configTest();
    const c = composer(tc, { journal: journalMuet });
    const essai: Famille = {
      nom: "essai",
      routes: [
        {
          methode: "POST",
          chemin: "/api/sandbox/qui",
          processus: ["toolhost"],
          acces: "enveloppe",
          traiter: async (req) => {
            await new Promise((fin) => setTimeout(fin, 5));
            return {
              ctx: current()?.username ?? null,
              req: req.identite?.username,
              corps: req.body !== undefined,
            };
          },
        },
      ],
    };
    const app = await creerAppToolhost({ tc, familles: [...c.familles, essai], journal: journalMuet });
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/sandbox/qui",
        headers: { ...entetes(9, "zoé"), "content-type": "application/json" },
        payload: JSON.stringify({ x: "y".repeat(200_000) }),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ctx: "zoé", req: "zoé", corps: true });
      expect(current()).toBeNull();
    } finally {
      await app.close();
      await c.fermer();
    }
  });
});

describe("route qui écrit elle-même sur la réponse brute", () => {
  it("en-têtes partis, flux en cours, rien rendu : l'enveloppe n'envoie rien de plus (pas de `null`, pas d'erreur)", async () => {
    const essai: Famille = {
      nom: "brut",
      routes: [
        {
          methode: "GET",
          chemin: "/api/sandbox/brut",
          processus: ["toolhost"],
          acces: "enveloppe",
          traiter: (_q, r) => {
            r.raw.writeHead(200, { "content-type": "text/plain" });
            r.raw.write("dé");
            setTimeout(() => r.raw.end("but"), 20);
            return Promise.resolve(undefined);
          },
        },
      ],
    };
    lignesJournal.length = 0;
    const app = await creerAppToolhost({ tc: configTest(), familles: [essai], journal: journalMuet });
    try {
      const r = await app.inject({ method: "GET", url: "/api/sandbox/brut", headers: entetes() });
      expect([r.statusCode, r.body]).toEqual([200, "début"]);
      await new Promise((fin) => setTimeout(fin, 50));
      expect(lignesJournal.join("\n")).not.toMatch(
        /already sent|ERR_HTTP_HEADERS_SENT|headers after they are sent/iu,
      );
    } finally {
      await app.close();
    }
  });
});

describe("requêtes brutes : forme absolue, upgrade WebSocket", () => {
  function brute(
    port: number,
    cible: string,
    entetesBrutes: Record<string, string>,
  ): Promise<{ statut: number; corps: string; upgrade: boolean }> {
    return new Promise((fin, echec) => {
      const r = request({
        host: "127.0.0.1",
        port,
        method: "GET",
        path: cible,
        headers: entetesBrutes,
        agent: false,
      });
      r.on("response", (rep) => {
        const morceaux: Buffer[] = [];
        rep.on("data", (m: Buffer) => morceaux.push(m));
        rep.on("end", () =>
          fin({ statut: rep.statusCode ?? 0, corps: Buffer.concat(morceaux).toString(), upgrade: false }),
        );
      });
      r.on("upgrade", (_rep, socket) => {
        socket.destroy();
        fin({ statut: 101, corps: "", upgrade: true });
      });
      r.on("error", echec);
      r.end();
    });
  }

  it("forme absolue : même porte ; upgrade WebSocket refusé (403) sur l'API, /health et /mcp", async () => {
    const hote = await hoteTest(configTest());
    await hote.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (hote.app.server.address() as AddressInfo).port;
    try {
      expect((await brute(port, "http://ailleurs/manifest", {})).statut).toBe(401);
      expect((await brute(port, "http://ailleurs/manifest", entetes())).statut).toBe(200);
      const ws = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      for (const [cible, hdrs] of [
        ["/manifest", { ...ws, ...entetes() }],
        ["/manifest", ws],
        ["/health", ws],
        ["/mcp", { ...ws, authorization: `Bearer ${SVC}` }],
        ["/api/sandbox/x", { ...ws, ...entetes() }],
      ] as const) {
        const r = await brute(port, cible, hdrs);
        expect(r.upgrade, cible).toBe(false);
        expect(r.statut, cible).toBe(403);
      }
    } finally {
      await hote.fermer();
    }
  });
});

describe("chemins MCP : portes du service avant le relais", () => {
  it("Origin non autorisée : 403 ; famille inconnue : 404 ; jamais la porte de l'API", async () => {
    let r = await h.app.inject({ method: "POST", url: "/mcp", headers: { origin: "https://evil.example" } });
    expect(r.statusCode).toBe(403);
    expect(r.body).toBe('{"error": "origine non autorisée"}');
    r = await h.app.inject({ method: "POST", url: "/mcp/ZZZ/" });
    expect(r.statusCode).toBe(404);
    expect(r.body).toBe(`{"error": "famille d'outils inconnue : zzz"}`);
    r = await h.app.inject({ method: "GET", url: "/sse/fs/..%2F..%2Fmanifest" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "famille d'outils inconnue : fs/../../manifest" });
  });

  it("famille à longue suite de barres internes : 404 en temps linéaire, avant tout jeton", async () => {
    const debut = performance.now();
    const r = await h.app.inject({ method: "POST", url: `/mcp/a${"/".repeat(60_000)}b` });
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(r.statusCode).toBe(404);
  });

  it("famille non servie : /mcp en 503, /sse et /messages comme un transport non servi (404 texte)", async () => {
    const r = await h.app.inject({ method: "POST", url: "/mcp/fs" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ detail: "MCP service unavailable: family not served by the tool host" });
    for (const url of ["/sse", "/sse/git", "/messages/?session_id=x", "/mcpx"]) {
      const s = await h.app.inject({ method: "GET", url });
      expect(s.statusCode, url).toBe(404);
      expect(s.body).toBe("Not Found");
    }
  });
});

describe("routes de l'hôte", () => {
  it("/manifest : configuration publique sans le jeton, préfixes servis, aucune famille sans amont", async () => {
    const r = await h.app.inject({
      method: "GET",
      url: "/manifest?transport=sse&base_url=https://th.lan",
      headers: entetes(),
    });
    expect(r.statusCode).toBe(200);
    const m = r.json() as Record<string, unknown>;
    expect(Object.keys(m)).toEqual([
      "ok",
      "config",
      "families",
      "served_prefixes",
      "mcp_path",
      "sse_path",
      "transports",
      "endpoints",
      "mcpServers",
    ]);
    expect(m["config"]).toMatchObject({ has_token: true, families: ["fs", "git"], source: "defaults" });
    expect(m).toMatchObject({
      families: {},
      served_prefixes: [
        "/api/sandbox/",
        "/api/terminal/",
        "/ws/terminal",
        "/api/playwright/screenshot/",
        "/api/desktop/frame/",
      ],
      endpoints: {},
      mcpServers: {},
    });
    expect(r.body).not.toContain(SVC);
  });

  it("session d'historique ouverte pour le compte de l'enveloppe", async () => {
    vi.stubEnv("APP_FILE_HISTORY_DIR", dossier);
    expect((await h.app.inject({ method: "POST", url: "/internal/file-history/session" })).statusCode).toBe(
      401,
    );
    const r = await h.app.inject({
      method: "POST",
      url: "/internal/file-history/session",
      headers: entetes(7),
    });
    expect(r.statusCode).toBe(200);
    const corps = r.json() as { ok: boolean; id: string };
    expect(corps).toEqual({ ok: true, id: await currentSession(7) });
    expect(corps.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/u);
  });
});
