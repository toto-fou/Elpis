// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/http.test.ts — service MCP monté dans Fastify : porte d'origine, portée, Bearer, transport HTTP streamable (sessions) et SSE. */
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import type { Dict } from "@elpis/commun";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FluxSse, ServiceMcpHttp, TAMPON_SSE_MAX } from "../src/http";
import { construireTable, VerificateurJetons } from "../src/jetons";
import { ServeurOutils } from "../src/serveur";
import { outilsGit, outilsMemoire, outilsTodo } from "./aides";

const SERVICE = "svc-0123456789abcdef";
const A = { authorization: `Bearer ${SERVICE}` };
const J = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const DESCRIPTION =
  "Authentication failed. The provided bearer token is invalid, expired, or no longer recognized by the server. To resolve: clear authentication tokens in your MCP client and reconnect. Your client should automatically re-register and obtain new tokens.";

let app: FastifyInstance;
let service: ServiceMcpHttp;
let base = "";

beforeAll(async () => {
  const serveur = new ServeurOutils({
    version: "1",
    famillesOpencode: ["git"],
    limiteDebit: null,
    limiteConcurrence: null,
  });
  serveur.enregistrerFamille("todo", outilsTodo());
  serveur.enregistrerFamille("memory", outilsMemoire());
  serveur.enregistrerFamille("git", outilsGit());
  service = new ServiceMcpHttp({
    serveur,
    verificateur: new VerificateurJetons({
      table: construireTable(SERVICE, { "cli-git": "alice" }, { "cli-git": ["git"] }),
    }),
    http: "/mcp",
    sse: "/sse",
    pingMs: 0,
  });
  app = Fastify();
  service.monter(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await service.fermer();
  app.server.closeAllConnections();
  await app.close();
});

async function envoyer(
  methode: string,
  chemin: string,
  entetes: Record<string, string> = {},
  corps?: unknown,
) {
  const r = await fetch(base + chemin, {
    method: methode,
    headers: entetes,
    ...(corps === undefined ? {} : { body: typeof corps === "string" ? corps : JSON.stringify(corps) }),
  });
  return { statut: r.status, entetes: r.headers, texte: await r.text() };
}

/** Données des événements `message` d'un flux SSE (lignes `\r\n`). */
function messages(texte: string): Dict[] {
  return texte
    .split("\r\n\r\n")
    .filter((b) => b.startsWith("event: message"))
    .map((b) => JSON.parse(b.split("\r\ndata: ")[1] ?? "null") as Dict);
}

async function session(
  chemin = "/mcp/todo",
  entetes: Record<string, string> = A,
): Promise<Record<string, string>> {
  const r = await envoyer("POST", chemin, { ...J, ...entetes }, INIT);
  const sid = r.entetes.get("mcp-session-id") ?? "";
  const S = { ...J, ...entetes, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" };
  await envoyer("POST", chemin, S, { jsonrpc: "2.0", method: "notifications/initialized" });
  return S;
}

describe("portes avant le transport", () => {
  it("401 invalid_token (corps json.dumps, WWW-Authenticate) sans jeton, schéma Basic ou jeton inconnu", async () => {
    for (const auth of [undefined, "Basic eDp5", "Bearer faux", `Bearer  ${SERVICE}`, `bearer${SERVICE}`]) {
      const r = await envoyer("POST", "/mcp", { ...J, ...(auth ? { authorization: auth } : {}) }, INIT);
      expect(r.statut, auth).toBe(401);
      expect(r.texte).toBe(`{"error": "invalid_token", "error_description": "${DESCRIPTION}"}`);
      expect(r.entetes.get("content-type")).toBe("application/json");
      expect(r.entetes.get("www-authenticate")).toBe(
        `Bearer error="invalid_token", error_description="${DESCRIPTION}"`,
      );
    }
    expect((await envoyer("POST", "/mcp", { ...J, authorization: `BEARER ${SERVICE}` }, INIT)).statut).toBe(
      200,
    );
  });

  it("famille inconnue → 404 avant le jeton ; origine non autorisée → 403 ; origine permise par l'environnement", async () => {
    const r = await envoyer("POST", "/mcp/Inconnue/", J, INIT);
    expect([r.statut, r.texte, r.entetes.get("content-type")]).toEqual([
      404,
      '{"error": "famille d\'outils inconnue : inconnue"}',
      "application/json; charset=utf-8",
    ]);
    const o = await envoyer("POST", "/mcp/todo", { ...J, ...A, origin: "https://evil.example" }, INIT);
    expect([o.statut, o.texte]).toEqual([403, '{"error": "origine non autorisée"}']);
    expect((await envoyer("POST", "/mcp/todo", { ...J, ...A, origin: "null" }, INIT)).statut).toBe(403);
    vi.stubEnv("LOCAL_MCP_ALLOWED_ORIGINS", "https://ok.example");
    try {
      expect(
        (await envoyer("POST", "/mcp/todo", { ...J, ...A, origin: "https://ok.example" }, INIT)).statut,
      ).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await envoyer("GET", "/ailleurs", {})).statut).toBe(404);
  });

  it("famille à longue suite de barres internes : 404 en temps linéaire (sans la borne d'URL du réseau)", async () => {
    const debut = performance.now();
    const r = await app.inject({
      method: "POST",
      url: `/mcp/a${"/".repeat(60_000)}b`,
      headers: J,
      payload: INIT,
    });
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(r.statusCode).toBe(404);
  });
});

describe("HTTP streamable", () => {
  it("initialize en flux SSE, notification 202, liste de la famille de la session", async () => {
    const r = await envoyer("POST", "/mcp/todo", { ...J, ...A }, INIT);
    expect(r.statut).toBe(200);
    expect(r.entetes.get("content-type")).toBe("text/event-stream");
    expect(r.entetes.get("cache-control")).toBe("no-cache, no-transform");
    expect(r.entetes.get("x-accel-buffering")).toBe("no");
    const sid = r.entetes.get("mcp-session-id") ?? "";
    expect(sid).toMatch(/^[0-9a-f]{32}$/u);
    expect(
      r.texte.startsWith(
        'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"',
      ),
    ).toBe(true);
    const S = { ...J, ...A, "mcp-session-id": sid };
    const n = await envoyer("POST", "/mcp/todo", S, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect([n.statut, n.texte, n.entetes.get("content-type"), n.entetes.get("mcp-session-id")]).toEqual([
      202,
      "",
      "application/json",
      sid,
    ]);
    const liste = messages(
      (await envoyer("POST", "/mcp/memory", S, { jsonrpc: "2.0", id: 2, method: "tools/list" })).texte,
    );
    expect(((liste[0]?.["result"] as Dict)["tools"] as Dict[]).map((t) => t["name"])).toContain("echo");
  });

  it("erreurs du transport : session absente, inconnue, Accept, Content-Type, JSON, version, méthode", async () => {
    const sans = await envoyer(
      "POST",
      "/mcp",
      { ...J, ...A },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    );
    expect([sans.statut, sans.texte]).toEqual([
      400,
      '{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Bad Request: Missing session ID"}}',
    ]);
    expect(sans.entetes.get("mcp-session-id")).toMatch(/^[0-9a-f]{32}$/u);
    const inconnue = await envoyer("POST", "/mcp", { ...J, ...A, "mcp-session-id": "abc" }, INIT);
    expect([inconnue.statut, inconnue.texte, inconnue.entetes.get("mcp-session-id")]).toEqual([
      404,
      '{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}',
      null,
    ]);
    const S = await session();
    const accept = await envoyer("POST", "/mcp/todo", { ...S, accept: "application/json" }, INIT);
    expect([accept.statut, JSON.parse(accept.texte).error.message]).toEqual([
      406,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    ]);
    const ct = await envoyer("POST", "/mcp/todo", { ...S, "content-type": "text/plain" }, INIT);
    expect([ct.statut, ct.texte, ct.entetes.get("content-type")]).toEqual([
      400,
      "Invalid Content-Type header",
      null,
    ]);
    const ct2 = await envoyer("POST", "/mcp/todo", { ...S, "content-type": "application/jsonx" }, INIT);
    expect([ct2.statut, JSON.parse(ct2.texte).error.message]).toEqual([
      415,
      "Unsupported Media Type: Content-Type must be application/json",
    ]);
    const json = await envoyer("POST", "/mcp/todo", S, "{pas json");
    expect([json.statut, json.texte]).toEqual([
      400,
      '{"jsonrpc":"2.0","id":"server-error","error":{"code":-32700,"message":"Parse error: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"}}',
    ]);
    const version = await envoyer(
      "POST",
      "/mcp/todo",
      { ...S, "mcp-protocol-version": "1999-01-01" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    );
    expect([version.statut, JSON.parse(version.texte).error.message]).toEqual([
      400,
      "Bad Request: Unsupported protocol version: 1999-01-01. Supported versions: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25",
    ]);
    const put = await envoyer("PUT", "/mcp/todo", S, "{}");
    expect([put.statut, put.entetes.get("allow"), put.texte]).toEqual([
      405,
      "GET, POST, DELETE, HEAD",
      "Method Not Allowed",
    ]);
  });

  it("flux GET unique (409 au second), DELETE puis session terminée (404)", async () => {
    const S = await session();
    const ctl = new AbortController();
    const flux = await fetch(base + "/mcp/todo", {
      headers: { ...S, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    expect([flux.status, flux.headers.get("content-type")]).toEqual([200, "text/event-stream"]);
    const second = await envoyer("GET", "/mcp/todo", { ...S, accept: "text/event-stream" });
    expect([second.statut, JSON.parse(second.texte).error.message]).toEqual([
      409,
      "Conflict: Only one SSE stream is allowed per session",
    ]);
    expect((await envoyer("GET", "/mcp/todo", { ...S, accept: "application/json" })).statut).toBe(406);
    ctl.abort();
    const fin = await envoyer("DELETE", "/mcp/todo", S);
    expect([fin.statut, fin.texte]).toEqual([200, ""]);
    const apres = await envoyer("POST", "/mcp/todo", S, { jsonrpc: "2.0", id: 9, method: "ping" });
    expect([apres.statut, JSON.parse(apres.texte).error.message]).toEqual([
      404,
      "Not Found: Session has been terminated",
    ]);
  });

  it("jeton relu à chaque requête : un client restreint ne voit que ses familles sur une session ouverte", async () => {
    const S = await session("/mcp");
    const tout = messages(
      (await envoyer("POST", "/mcp", S, { jsonrpc: "2.0", id: 2, method: "tools/list" })).texte,
    );
    expect(((tout[0]?.["result"] as Dict)["tools"] as Dict[]).length).toBe(12);
    const restreint = { ...S, authorization: "Bearer cli-git" };
    const vue = messages(
      (await envoyer("POST", "/mcp", restreint, { jsonrpc: "2.0", id: 3, method: "tools/list" })).texte,
    );
    expect(((vue[0]?.["result"] as Dict)["tools"] as Dict[]).map((t) => t["name"])).toEqual(["git_query"]);
    const appel = messages(
      (
        await envoyer("POST", "/mcp", restreint, {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        })
      ).texte,
    );
    expect(appel[0]).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "Unknown tool: 'echo'" },
    });
  });
});

describe("SSE", () => {
  it("événement endpoint, messages postés (202 Accepted), réponses sur le flux, portée du GET", async () => {
    const ctl = new AbortController();
    const r = await fetch(base + "/sse/todo", {
      headers: { ...A, accept: "text/event-stream" },
      signal: ctl.signal,
    });
    expect([r.status, r.headers.get("content-type"), r.headers.get("cache-control")]).toEqual([
      200,
      "text/event-stream; charset=utf-8",
      "no-store",
    ]);
    const lecteur = (r.body as ReadableStream<Uint8Array>).getReader();
    let tampon = "";
    const lire = async (n: number): Promise<string[]> => {
      while (tampon.split("\r\n\r\n").length - 1 < n) {
        const { value } = await lecteur.read();
        tampon += new TextDecoder().decode(value);
      }
      return tampon.split("\r\n\r\n").slice(0, n);
    };
    const [endpoint] = await lire(1);
    const chemin =
      /^event: endpoint\r\ndata: (\/messages\/\?session_id=[0-9a-f]{32})$/u.exec(endpoint ?? "")?.[1] ?? "";
    expect(chemin).not.toBe("");
    const poste = await envoyer("POST", chemin, { ...A, "content-type": "application/json" }, INIT);
    expect([poste.statut, poste.texte, poste.entetes.get("content-type")]).toEqual([202, "Accepted", null]);
    await envoyer(
      "POST",
      chemin,
      { ...A, "content-type": "application/json" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    );
    await envoyer(
      "POST",
      chemin,
      { ...A, "content-type": "application/json" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    );
    const evts = await lire(3);
    const liste = JSON.parse((evts[2] ?? "").split("\r\ndata: ")[1] ?? "{}") as Dict;
    expect(
      ((liste["result"] as Dict)["tools"] as Dict[]).every((t) =>
        outilsTodo().some((o) => o.nom === t["name"]),
      ),
    ).toBe(true);
    const illisible = await envoyer(
      "POST",
      chemin,
      { ...A, "content-type": "application/json" },
      "{pas json",
    );
    expect([illisible.statut, illisible.texte]).toEqual([400, "Could not parse message"]);
    const [, , , erreur] = await lire(4);
    expect(erreur).toContain('"logger":"mcp.server.exception_handler","data":"Internal Server Error"');
    expect(
      await envoyer("POST", "/messages/", { ...A, "content-type": "application/json" }, "{}"),
    ).toMatchObject({
      statut: 400,
      texte: "session_id is required",
    });
    expect(
      await envoyer("POST", "/messages/?session_id=0123", { ...A, "content-type": "application/json" }, "{}"),
    ).toMatchObject({
      statut: 400,
      texte: "Invalid session ID",
    });
    expect(
      await envoyer(
        "POST",
        `/messages/?session_id=${"0".repeat(32)}`,
        { ...A, "content-type": "application/json" },
        "{}",
      ),
    ).toMatchObject({
      statut: 404,
      texte: "Could not find session",
    });
    expect((await envoyer("POST", chemin, { "content-type": "application/json" }, INIT)).statut).toBe(401);
    ctl.abort();
  });

  it("session_id à longue suite d'accolades internes : refusé en temps linéaire", () => {
    const debut = performance.now();
    expect(service.aSessionSse(`session_id=a${"{".repeat(60_000)}a`)).toBe(false);
    expect(performance.now() - debut).toBeLessThan(500);
  });
});

describe("requête déjà authentifiée (pont du core)", () => {
  it("jeton fourni par l'appelant : pas de Bearer exigé, revendications du client délégué appliquées", async () => {
    const serveur = new ServeurOutils({
      version: "1",
      famillesOpencode: [],
      limiteDebit: null,
      limiteConcurrence: null,
    });
    serveur.enregistrerFamille("todo", outilsTodo());
    serveur.enregistrerFamille("memory", outilsMemoire());
    const interne = new ServiceMcpHttp({ serveur, verificateur: null });
    const hote = Fastify();
    const jeton = {
      token: "dlg_x",
      client_id: "tools:alice",
      scopes: ["local-tools"],
      expires_at: null,
      claims: {
        username: "alice",
        client_kind: "tools",
        delegated: true,
        families: ["memory"],
        trusted_meta: false,
      },
    };
    hote.post("/pont/:f", (req, reply) => {
      reply.hijack();
      void interne.traiter(req.raw, reply.raw, {
        jeton,
        chemin: `/mcp/${(req.params as { f: string }).f}`,
        corps: Buffer.from(JSON.stringify(req.body)),
      });
    });
    await hote.listen({ port: 0, host: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(hote.server.address() as AddressInfo).port}`;
      const r = await fetch(`${url}/pont/memory`, { method: "POST", headers: J, body: JSON.stringify(INIT) });
      const sid = r.headers.get("mcp-session-id") ?? "";
      await r.text();
      const liste = await fetch(`${url}/pont/memory`, {
        method: "POST",
        headers: { ...J, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(
        ((messages(await liste.text())[0]?.["result"] as Dict)["tools"] as Dict[]).map((t) => t["name"]),
      ).toEqual(["memory"]);
    } finally {
      await interne.fermer();
      hote.server.closeAllConnections();
      await hote.close();
    }
  });
});

describe("bornes du service", () => {
  async function hote(o: { sessionsMax?: number; sessionInactiveMs?: number }) {
    const serveur = new ServeurOutils({ version: "1", limiteDebit: null, limiteConcurrence: null });
    serveur.enregistrerFamille("todo", outilsTodo());
    const svc = new ServiceMcpHttp({ serveur, verificateur: null, pingMs: 0, ...o });
    const h = Fastify();
    svc.monter(h);
    await h.listen({ port: 0, host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(h.server.address() as AddressInfo).port}`;
    const ouvrir = async (): Promise<string> => {
      const r = await fetch(`${url}/mcp`, { method: "POST", headers: J, body: JSON.stringify(INIT) });
      await r.text();
      return r.headers.get("mcp-session-id") ?? "";
    };
    const ping = async (sid: string): Promise<number> => {
      const r = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { ...J, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
      });
      await r.text();
      return r.status;
    };
    const arreter = async (): Promise<void> => {
      await svc.fermer();
      h.server.closeAllConnections();
      await h.close();
    };
    return { svc, ouvrir, ping, arreter };
  }

  it("plafond de sessions : la moins récemment active est terminée (404), les autres restent", async () => {
    const h = await hote({ sessionsMax: 2 });
    try {
      const a = await h.ouvrir();
      const b = await h.ouvrir();
      expect(await h.ping(a)).toBe(200);
      const c = await h.ouvrir();
      expect([await h.ping(a), await h.ping(b), await h.ping(c)]).toEqual([200, 404, 200]);
      expect(h.svc.nombreSessions).toBe(2);
    } finally {
      await h.arreter();
    }
  });

  it("session inactive terminée à l'ouverture suivante", async () => {
    const h = await hote({ sessionInactiveMs: 0 });
    try {
      const a = await h.ouvrir();
      await new Promise((fin) => setTimeout(fin, 5));
      const b = await h.ouvrir();
      expect([await h.ping(a), await h.ping(b)]).toEqual([404, 200]);
    } finally {
      await h.arreter();
    }
  });

  it("client SSE trop lent : flux coupé au-delà du tampon maximal", () => {
    const lente = new (class extends Writable {
      override _write(_c: unknown, _e: BufferEncoding, _fin: () => void): void {
        // ne consomme jamais : le tampon d'écriture grossit
      }
      writeHead(): this {
        return this;
      }
      flushHeaders(): void {}
    })();
    const flux = new FluxSse(lente as unknown as ServerResponse, {}, 0);
    const morceau = "x".repeat(1024 * 1024);
    let n = 0;
    while (!flux.ferme && n < 64) {
      flux.evenement("message", morceau);
      n++;
    }
    expect([n, flux.ferme, lente.destroyed]).toEqual([TAMPON_SSE_MAX / morceau.length, true, true]);
  });
});
