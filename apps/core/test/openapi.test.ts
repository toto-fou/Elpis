// SPDX-License-Identifier: MIT
/** apps/core/test/openapi.test.ts — façade OpenAPI rejouée contre mcp/openapi.py et routes_openapi.py (vecteurs, pool simulé), puis concurrence par compte et /api/tokens/schema. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server as ServeurHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { HttpError, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { DelaiDepasse, McpFileSaturee, oublierManifeste } from "@elpis/mcp";
import type { ConfigMcp } from "@elpis/mcp";
import { tokenDigest } from "@elpis/securite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { creerFamilleJetons } from "../src/familles/jetons";
import { creerFamilleOpenapi } from "../src/familles/openapi";
import { toolTimeoutS } from "../src/outils/delais";
import { buildSpec, clearCache, responseValue, validationErrors } from "../src/outils/openapi";
import type { PoolOutils } from "../src/outils/openapi";
import { appTest, journalMuet } from "./aides";
import { delaiEnAnglais } from "./ecart-delai-outil";

interface Etape {
  m?: string;
  u?: string;
  entetes?: Record<string, string>;
  corps?: string;
  octets?: string;
  repete?: [string, number];
  config?: unknown;
}

interface Reponse {
  statut: number;
  corps: string;
  entetes: Record<string, string>;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/openapi.json", import.meta.url), "utf-8")) as {
  service: string;
  jetons: [string, string, string, number | null][];
  manifeste: unknown;
  outils_fs: Dict[];
  specs: [string, Dict[]][];
  validations: [Dict, unknown][];
  resultats: [Dict, Dict][];
  delais: string[];
  etapes: Etape[];
  ids: Record<string, number>;
  pur: { specs: string[]; validations: unknown[]; resultats: string[]; delais: Record<string, number> };
  reponses: (Reponse | null)[];
};

const T0 = 1_800_000_000;

/** Pool simulé, mêmes comportements que celui du générateur ; `retenir` bloque `echo` pour le test de concurrence. */
function poolSimule(retenir?: Promise<void>): PoolOutils & { appels: { nom: string; options: Dict }[] } {
  const appels: { nom: string; options: Dict }[] = [];
  const texte = (t: string): Dict => ({ content: [{ type: "text", text: t }] });
  return {
    appels,
    getOrConnect: async (cfg: ConfigMcp) => {
      if ((cfg["families"] as string[] | undefined)?.includes("git"))
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return [null as never, V.outils_fs];
    },
    callTool: async (_cfg: ConfigMcp, nom: string, args: Dict, options: Dict = {}) => {
      appels.push({ nom, options });
      const meta = (options["meta"] ?? {}) as Record<string, string>;
      switch (nom) {
        case "lire":
          return {
            content: [{ type: "text", text: '{"result": "contenu"}' }],
            structuredContent: { result: "contenu" },
          };
        case "ecrire":
          return { content: [], structuredContent: { ok: true, args } };
        case "texte":
          return texte("bonjour");
        case "nombre":
          return texte("42");
        case "liste":
          return texte("[1, 2]");
        case "erreur":
          return { ...texte('{"ok": false, "error": "absent", "fix": "x"}'), isError: true };
        case "lent":
          throw new DelaiDepasse("délai");
        case "sature":
          throw new McpFileSaturee("file pleine");
        case "panne":
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        case "bogue":
          throw new Error("boom");
        case "echo":
          if (retenir) await retenir;
          return {
            content: [],
            structuredContent: {
              args,
              username: meta["username"],
              user_id: meta["user_id"],
              call: (meta["call_id"] ?? "").slice(0, 8),
            },
          };
        default:
          return texte("{}");
      }
    },
  } as PoolOutils & { appels: { nom: string; options: Dict }[] };
}

describe("façade OpenAPI : parties pures (vecteurs)", () => {
  it("spec, validation des arguments, rendu des résultats, délais", () => {
    expect(
      V.specs.map(([f, o]) =>
        pyJsonDumps(buildSpec(f, o, `http://h/api/tools/${f}`), { ensureAscii: false }),
      ),
    ).toEqual(V.pur.specs);
    expect(V.validations.map(([o, a]) => validationErrors(o, a))).toEqual(V.pur.validations);
    expect(V.resultats.map(([r, o]) => pyJsonDumps(responseValue(r, o), { ensureAscii: false }))).toEqual(
      V.pur.resultats,
    );
    expect(Object.fromEntries(V.delais.map((n) => [n, toolTimeoutS(n)]))).toEqual(V.pur.delais);
  });
});

describe("façade OpenAPI : routes", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let pool: ReturnType<typeof poolSimule>;
  let liberer: () => void = () => undefined;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [nom, admin] of [
      ["alice", 1],
      ["bob", 0],
    ] as const)
      await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
    for (const [nom, jeton, familles, expire] of V.jetons)
      await t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          V.ids[nom] ?? 0,
          "tools",
          "tools",
          tokenDigest(jeton),
          jeton.slice(-4),
          familles,
          T0,
          expire === null ? null : T0 + expire,
        ],
      );
    await t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [V.ids["alice"] ?? 0, "opencode", "opencode", tokenDigest("pcr_" + "p".repeat(40)), "pppp", "", T0],
    );
    dossier = mkdtempSync(join(tmpdir(), "elpis-openapi-"));
    writeFileSync(join(dossier, "mcp.json"), JSON.stringify(V.manifeste));
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    oublierManifeste();
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    const retenue = new Promise<void>((fin) => {
      liberer = fin;
    });
    pool = poolSimule(retenue);
    const jetons = { ...dependancesParDefaut(t.base), maintenant: () => T0 };
    app = await appTest({ familles: [creerFamilleOpenapi({ jetons, journal: journalMuet, pool })] });
    liberer();
  });

  beforeEach(() => clearCache());

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("rejoue les étapes et rend les mêmes réponses que routes_openapi.py (vecteurs)", async () => {
    for (const [i, e] of V.etapes.entries()) {
      if (e.config !== undefined) {
        writeFileSync(join(dossier, "config.json"), JSON.stringify(e.config));
        invalidateConfigCache();
        clearCache();
        continue;
      }
      let payload: Buffer | undefined;
      if (e.corps !== undefined) payload = Buffer.from(e.corps);
      else if (e.octets !== undefined) payload = Buffer.from(e.octets, "hex");
      else if (e.repete) payload = Buffer.from(e.repete[0].repeat(e.repete[1]));
      const r = await app.inject({
        method: e.m as "GET",
        url: e.u ?? "/",
        headers: { host: "testserver", ...(e.entetes ?? {}) },
        ...(payload !== undefined ? { payload } : {}),
      });
      const attendu = V.reponses[i] as Reponse;
      const garde = (h: Record<string, unknown>): Record<string, string> =>
        Object.fromEntries(
          ["content-type", "cache-control", "www-authenticate", "retry-after"].flatMap((k) =>
            h[k] === undefined
              ? []
              : [[k, k === "content-type" ? (String(h[k]).split(";")[0] ?? "") : String(h[k])]],
          ),
        );
      expect(
        { statut: r.statusCode, corps: r.body, entetes: garde(r.headers) },
        `étape ${i} : ${e.m ?? ""} ${e.u ?? ""}`,
      ).toEqual({ ...attendu, corps: delaiEnAnglais(attendu.corps), entetes: garde(attendu.entetes) });
    }
    const echo = pool.appels.find((a) => a.nom === "echo");
    expect([echo?.options["execTimeoutS"], echo?.options["queueTimeoutS"]]).toEqual([300, 120]);
  });

  it("au plus 4 appels simultanés par compte (429, Retry-After 5)", async () => {
    writeFileSync(join(dossier, "config.json"), "{}");
    invalidateConfigCache();
    let ouvrir: () => void = () => undefined;
    const retenue = new Promise<void>((fin) => {
      ouvrir = fin;
    });
    const lent = poolSimule(retenue);
    const jetons = { ...dependancesParDefaut(t.base), maintenant: () => T0 };
    const autre = await appTest({
      familles: [creerFamilleOpenapi({ jetons, journal: journalMuet, pool: lent })],
    });
    const appel = (): Promise<LightMyRequestResponse> =>
      autre.inject({
        method: "POST",
        url: "/api/tools/fs/echo",
        headers: { authorization: `Bearer ept_${"a".repeat(40)}`, "content-type": "application/json" },
        payload: "{}",
      });
    const enCours = [appel(), appel(), appel(), appel()];
    await vi.waitFor(() => expect(lent.appels.length).toBe(4));
    const refus = await appel();
    expect([refus.statusCode, refus.headers["retry-after"], refus.json()]).toEqual([
      429,
      "5",
      { detail: "Too many simultaneous calls (max 4)." },
    ]);
    ouvrir();
    expect((await Promise.all(enCours)).map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect((await appel()).statusCode).toBe(200);
    await autre.close();
  });
});

describe("/api/tokens/schema/:family", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let serveur: ServeurHttp;
  let port = 0;
  const requetes: { methode: string; chemin: string; autorisation: string | undefined }[] = [];

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 1 });
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    serveur = createServer((req, res) => {
      requetes.push({
        methode: req.method ?? "",
        chemin: req.url ?? "",
        autorisation: req.headers.authorization,
      });
      const id = req.headers["mcp-session-id"];
      const existant = typeof id === "string" ? sessions.get(id) : undefined;
      if (existant) {
        void existant.handleRequest(req, res);
        return;
      }
      const mcp = new Server({ name: "faux", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
          { name: "b", title: "B", description: "outil b", inputSchema: { type: "object" }, _meta: { x: 1 } },
          {
            name: "a",
            inputSchema: { type: "object", properties: { p: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: "c",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", $ref: "#/$defs/Absent" },
          },
        ],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
        },
      });
      void mcp.connect(transport).then(() => transport.handleRequest(req, res));
    });
    await new Promise<void>((fin) => serveur.listen(0, "127.0.0.1", () => fin()));
    port = (serveur.address() as AddressInfo).port;
    dossier = mkdtempSync(join(tmpdir(), "elpis-schema-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    const auth = dependancesParDefaut(t.base);
    app = await appTest({
      familles: [
        creerFamilleJetons({ auth, racine: dossier, mandataires: [], journal: journalMuet, mode: "main" }),
      ],
      gardes: {
        session: (req) => {
          if (!req.headers["x-uid"]) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
      serveur?.closeAllConnections();
      await new Promise<void>((fin) => (serveur ? serveur.close(() => fin()) : fin()));
    } finally {
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  const lire = (family: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: "GET", url: `/api/tokens/schema/${family}`, headers: { "x-uid": "1" } });

  it("famille hors politique, service absent, liste en cache 60 s, service injoignable", async () => {
    expect((await app.inject({ method: "GET", url: "/api/tokens/schema/git" })).statusCode).toBe(401);
    expect((await lire("chart")).json()).toEqual({ detail: "Famille d'outils inconnue." });
    writeFileSync(join(dossier, "mcp.json"), JSON.stringify({ version: 1, mcpServers: {} }));
    oublierManifeste();
    expect([(await lire("git")).statusCode, (await lire("git")).json()]).toEqual([
      503,
      { detail: "Service d'outils partagé non configuré." },
    ]);
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        toolHosts: { main: { url: `http://127.0.0.1:${port}`, token: "jeton-service-0123456789" } },
        mcpServers: {
          "elpis-git": {
            type: "http",
            url: `http://127.0.0.1:${port}/mcp/git`,
            headers: { Authorization: "Bearer jeton-service-0123456789" },
            "x-elpis": { role: "toolhost", host: "main", families: ["git"] },
          },
        },
      }),
    );
    oublierManifeste();
    const r = await lire("git");
    expect(r.json()).toEqual({
      family: "git",
      tools: [
        { name: "b", title: "B", description: "outil b", inputSchema: { type: "object" } },
        {
          name: "a",
          inputSchema: { type: "object", properties: { p: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: "c",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", $ref: "#/$defs/Absent" },
        },
      ],
    });
    expect(requetes.filter((q) => q.methode === "DELETE")).toHaveLength(1);
    expect(
      requetes.every((q) => q.chemin === "/mcp/git" && q.autorisation === "Bearer jeton-service-0123456789"),
    ).toBe(true);
    const avant = requetes.length;
    expect((await lire("git")).statusCode).toBe(200);
    expect(requetes.length).toBe(avant);
    serveur.closeAllConnections();
    await new Promise<void>((fin) => serveur.close(() => fin()));
    expect((await lire("shell")).json()).toEqual({ detail: "Service d'outils injoignable." });
    serveur = createServer();
  });
});
