// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/faux-serveur.ts — faux serveur MCP écrit avec le SDK TS : HTTP streamable (/mcp) et SSE (/sse + /messages), outils de test et traces des requêtes. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server as ServeurHttp, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Dict = Record<string, unknown>;

export interface Requete {
  methode: string;
  chemin: string;
  autorisation: string | undefined;
  session: string | undefined;
  corps: unknown;
}

export interface FauxServeur {
  readonly base: string;
  readonly port: number;
  requetes: Requete[];
  appels: { nom: string; args: Dict; meta: Dict | undefined }[];
  annulations: number;
  initialisations: number;
  /** Redémarrage simulé : les sessions connues sont oubliées (HTTP 404 sur leur identifiant). */
  oublierSessions(): void;
  /** Redémarrage SSE simulé : flux fermés, sessions oubliées. */
  fermerFluxSse(): void;
  /** Sessions SSE oubliées, flux laissés ouverts : le POST suivant reçoit 404. */
  oublierSessionsSse(): void;
  fermer(): Promise<void>;
}

/** Outils exposés (3 par page) : schémas booléens, sortie structurée, erreurs de protocole (message brut, comme un serveur Python) et d'outil. */
const OUTILS: Dict[] = [
  {
    name: "echo",
    description: "Renvoie ses arguments et son _meta",
    inputSchema: { type: "object", properties: { x: true } },
  },
  {
    name: "lent",
    description: "Progression et logs, puis attend",
    inputSchema: { type: "object", properties: { ms: { type: "integer" }, etapes: { type: "integer" } } },
  },
  { name: "erreur", inputSchema: { type: "object" } },
  { name: "en_erreur", inputSchema: { type: "object" } },
  {
    name: "structure",
    inputSchema: { type: "object", properties: { n: {} } },
    outputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
  },
  {
    name: "bool",
    inputSchema: {
      type: "object",
      properties: { a: true, b: false, c: { type: "string" } },
      additionalProperties: false,
    },
  },
  { name: "ecrire", description: "Outil mutant", inputSchema: { type: "object" } },
  {
    name: "structure07",
    inputSchema: { type: "object" },
    outputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    },
  },
  {
    name: "structure04",
    inputSchema: { type: "object" },
    outputSchema: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      properties: { n: { type: "integer" } },
    },
  },
  { name: "schema_casse", inputSchema: { type: "object" }, outputSchema: { type: "entier" } },
];
const PAGE = 3;

function attendre(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function lireCorps(req: IncomingMessage): Promise<unknown> {
  const morceaux: Buffer[] = [];
  for await (const m of req) morceaux.push(m as Buffer);
  const texte = Buffer.concat(morceaux).toString("utf8");
  return texte ? JSON.parse(texte) : undefined;
}

function creerServeurMcp(etat: FauxServeur, outils: readonly Dict[] = OUTILS): Server {
  const s = new Server({ name: "faux", version: "1.0.0" }, { capabilities: { tools: {}, logging: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const page = Number(String(req.params?.cursor ?? "p0").slice(1));
    const suite = (page + 1) * PAGE < outils.length ? `p${page + 1}` : undefined;
    return {
      tools: outils.slice(page * PAGE, (page + 1) * PAGE) as never,
      ...(suite ? { nextCursor: suite } : {}),
    };
  });
  s.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const nom = req.params.name;
    const args = (req.params.arguments ?? {}) as Dict;
    const meta = req.params._meta as Dict | undefined;
    etat.appels.push({ nom, args, meta });
    extra.signal.addEventListener("abort", () => etat.annulations++);
    if (nom === "echo" || nom === "ecrire")
      return { content: [{ type: "text", text: JSON.stringify({ args, meta: meta ?? null }) }] };
    if (nom === "lent") {
      const jeton = meta?.["progressToken"];
      const etapes = Number(args["etapes"] ?? 0);
      for (let i = 1; i <= etapes; i++) {
        if (jeton !== undefined)
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: jeton as string, progress: i, total: etapes, message: `étape ${i}` },
          });
        await extra.sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "lent",
            data: { msg: `ligne ${i}`, extra: { kind: "shell_output", call_id: meta?.["call_id"] } },
          },
        });
      }
      await attendre(Number(args["ms"] ?? 0), extra.signal);
      return { content: [{ type: "text", text: "fini" }] };
    }
    if (nom === "erreur") throw Object.assign(new Error("Invalid params: x manquant"), { code: -32602 });
    if (nom === "en_erreur")
      return { content: [{ type: "text", text: '{"ok": false, "error": "refus"}' }], isError: true };
    if (nom.startsWith("structure") || nom === "schema_casse") {
      if (args["sans"]) return { content: [{ type: "text", text: "rien" }] };
      return {
        content: [{ type: "text", text: JSON.stringify({ n: args["n"] }) }],
        structuredContent: { n: args["n"] },
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  });
  return s;
}

/** Démarre le faux serveur (port libre) ; `jeton` impose `Authorization: Bearer <jeton>`, `basic` (« u:p ») un Basic, `outils` remplace la liste servie. */
export async function demarrerFauxServeur(
  options: { jeton?: string; basic?: string; port?: number; outils?: readonly Dict[] } = {},
): Promise<FauxServeur> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();
  const http: ServeurHttp = createServer();
  const etat: FauxServeur = {
    base: "",
    port: 0,
    requetes: [],
    appels: [],
    annulations: 0,
    initialisations: 0,
    oublierSessions: () => {
      for (const t of sessions.values()) void t.close().catch(() => undefined);
      sessions.clear();
    },
    fermerFluxSse: () => {
      for (const t of sse.values()) void t.close().catch(() => undefined);
      sse.clear();
    },
    oublierSessionsSse: () => {
      sse.clear();
    },
    fermer: async () => {
      etat.oublierSessions();
      for (const t of sse.values()) await t.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };

  const repondre = (res: ServerResponse, statut: number, corps: Dict): void => {
    res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(corps));
  };

  http.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const corps = req.method === "POST" ? await lireCorps(req) : undefined;
      const session = req.headers["mcp-session-id"] as string | undefined;
      etat.requetes.push({
        methode: req.method ?? "",
        chemin: url.pathname,
        autorisation: req.headers.authorization,
        session,
        corps,
      });
      const attendu =
        options.jeton !== undefined
          ? `Bearer ${options.jeton}`
          : options.basic !== undefined
            ? `Basic ${Buffer.from(options.basic, "utf8").toString("base64")}`
            : undefined;
      if (attendu !== undefined && req.headers.authorization !== attendu) {
        repondre(res, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/mcp") {
        let transport = session === undefined ? undefined : sessions.get(session);
        if (transport === undefined) {
          const init =
            typeof corps === "object" && corps !== null && (corps as Dict)["method"] === "initialize";
          if (session !== undefined || !init) {
            repondre(res, 404, {
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: null,
            });
            return;
          }
          etat.initialisations++;
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, t);
            },
          });
          await creerServeurMcp(etat, options.outils).connect(t);
          transport = t;
        }
        await transport.handleRequest(req, res, corps);
        return;
      }
      if (url.pathname === "/sse" && req.method === "GET") {
        const t = new SSEServerTransport("/messages", res);
        sse.set(t.sessionId, t);
        etat.initialisations++;
        await creerServeurMcp(etat, options.outils).connect(t);
        return;
      }
      if (url.pathname === "/messages" && req.method === "POST") {
        const t = sse.get(url.searchParams.get("sessionId") ?? "");
        if (t === undefined) {
          repondre(res, 404, { error: "session inconnue" });
          return;
        }
        await t.handlePostMessage(req, res, corps);
        return;
      }
      repondre(res, 404, { error: "introuvable" });
    })().catch((e: unknown) => {
      if (!res.headersSent) repondre(res, 500, { error: String(e) });
    });
  });

  await new Promise<void>((r) => http.listen(options.port ?? 0, "127.0.0.1", () => r()));
  const port = (http.address() as AddressInfo).port;
  Object.assign(etat, { base: `http://127.0.0.1:${port}`, port });
  return etat;
}
