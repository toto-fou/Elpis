// SPDX-License-Identifier: MIT
/** apps/toolhost/test/natives.test.ts — familles natives de l'hôte : configuration (familles_natives obsolète), aiguillage des requêtes MCP (HTTP, SSE, messages), jetons, agrégats de /health et /manifest, famille retirée de families. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { getUsername } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { surchargerConfig } from "@elpis/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { appliquerEnvironnement, chargerConfig, FAMILLES_NATIVES_PORTEES, publicDict } from "../src/config";
import type { ToolhostConfig } from "../src/config";
import { MESSAGE_NON_SERVIE } from "../src/mcp/facade";
import type { FabriqueNative } from "../src/mcp/natives";
import { FABRIQUES_NATIVES } from "../src/mcp/registre";
import { manifeste, sante } from "../src/socle";
import { configTest, entetes, hoteTest, lignesJournal, SVC } from "./aides";
import type { HoteTest } from "./aides";

const ouverts: { fermer: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const o of ouverts.splice(0).reverse()) await o.fermer();
});

const appels: Dict[] = [];

/** Famille « todo » portée pour le test : deux outils, un écho et un compteur d'appels. */
const todoNative: FabriqueNative = () => ({
  famille: "todo",
  outils: ["todo_echo", "todo_compte"].map((nom) => ({
    nom,
    famille: "todo",
    definition: {
      name: nom,
      description: `Outil natif ${nom}.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    signature: {},
    traiter: (args: Dict, ctx: ContexteAppel) => {
      appels.push({ nom, ...args });
      return { ok: true, outil: nom, n: appels.length, compte: getUsername(ctx) };
    },
  })),
});

async function hote(plus: Partial<ToolhostConfig> = {}): Promise<{ h: HoteTest; base: string }> {
  const h = await hoteTest(configTest({ families: ["fs", "todo"], familles_natives: ["todo"], ...plus }), {
    natives: { todo: todoNative },
  });
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  ouverts.push({ fermer: () => h.fermer() });
  return { h, base: `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}` };
}

async function client(base: string, chemin: string, sse = false, jeton = SVC): Promise<Client> {
  const options = { requestInit: { headers: { authorization: `Bearer ${jeton}` } } };
  const c = new Client({ name: "essai", version: "1" });
  await c.connect(
    sse
      ? new SSEClientTransport(new URL(base + chemin), {
          ...options,
          eventSourceInit: {
            fetch: (u, i) =>
              fetch(u, {
                ...i,
                headers: { ...(i?.headers as Record<string, string>), authorization: `Bearer ${jeton}` },
              }),
          },
        })
      : new StreamableHTTPClientTransport(new URL(base + chemin), options),
  );
  ouverts.push({ fermer: () => c.close() });
  return c;
}

describe("configuration des familles natives", () => {
  it("toutes les familles portées en TS de families sont natives (office compris) ; toolhost.json › familles_natives signalé et ignoré ; registre = familles portées", () => {
    expect(Object.keys(FABRIQUES_NATIVES)).toEqual([...FAMILLES_NATIVES_PORTEES]);
    expect(FAMILLES_NATIVES_PORTEES).toContain("office");
    const schema = JSON.parse(
      readFileSync(new URL("../../../docs/schemas/toolhost.schema.json", import.meta.url), "utf-8"),
    ) as { properties: { familles_natives: { description: string } } };
    expect(schema.properties.familles_natives.description).toMatch(/^Obsolète/u);
    const dossier = mkdtempSync(path.join(tmpdir(), "elpis-natives-"));
    try {
      const fichier = path.join(dossier, "toolhost.json");
      const ignore =
        "familles_natives ignoré : toute famille portée en TypeScript de families est servie par l'hôte (retirez une famille de families pour ne pas la servir)";
      for (const valeur of [["todo", "Desktop ", "x"], [], "desktop"]) {
        writeFileSync(
          fichier,
          JSON.stringify({ families: ["fs", "office", "git", "todo"], familles_natives: valeur }),
        );
        const tc = chargerConfig(fichier, {});
        expect(tc.familles_natives, JSON.stringify(valeur)).toEqual(["fs", "git", "office"]);
        expect(tc.warnings, JSON.stringify(valeur)).toContain(ignore);
        expect(publicDict(tc)["familles_natives"]).toEqual(["fs", "git", "office"]);
      }
      for (const valeur of [undefined, null]) {
        writeFileSync(fichier, JSON.stringify({ families: ["fs", "git"], familles_natives: valeur }));
        const tc = chargerConfig(fichier, {});
        expect([tc.familles_natives, tc.warnings.includes(ignore)]).toEqual([["fs", "git"], false]);
      }
      writeFileSync(fichier, JSON.stringify({ families: ["todo", "chart"] }));
      const compte = chargerConfig(fichier, {});
      expect(compte.familles_natives).toEqual([]);
      expect(publicDict(compte)).not.toHaveProperty("familles_natives");
      const absent = chargerConfig(path.join(dossier, "absent.json"), {
        LOCAL_MCP_TOOL_FAMILIES: "fs,shell,office,todo",
      });
      expect([absent.source, absent.familles_natives]).toEqual(["defaults", ["fs", "shell", "office"]]);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("famille sans implémentation TS ou hors de families : ignorée et signalée, jamais relayée", async () => {
    lignesJournal.length = 0;
    const h = await hoteTest(
      configTest({ families: ["fs", "todo"], familles_natives: ["todo", "fs", "git"] }),
      {
        natives: {},
      },
    );
    ouverts.push(h);
    expect(h.composition.natif).toBeNull();
    const journal = lignesJournal.join("\n");
    expect(journal).toContain("famille native fs sans implémentation TS : ignorée");
    expect(journal).toContain("famille native git hors de families : ignorée");
    expect(journal).toContain("famille todo non servie par l'hôte d'outils : ignorée");
    const r = await h.app.inject({
      method: "POST",
      url: "/mcp/fs",
      headers: { authorization: `Bearer ${SVC}` },
    });
    expect(r.statusCode).toBe(503);
  });
});

describe("familles natives servies par l'hôte", () => {
  it("HTTP : /mcp/<native> servi par l'hôte (jeton exigé, identité du jeton avant `_meta`) ; /mcp/<non servie> refusé (503)", async () => {
    appels.length = 0;
    const retour = surchargerConfig({ LOCAL_MCP_CLIENT_TOKENS: { "cli-alice": "alice" } });
    ouverts.push({ fermer: async () => retour() });
    const { base } = await hote();
    const todo = await client(base, "/mcp/todo");
    expect((await todo.listTools()).tools.map((t) => t.name)).toEqual(["todo_echo", "todo_compte"]);
    const r = await todo.callTool({ name: "todo_echo", arguments: {}, _meta: { username: "bob" } });
    expect(r.structuredContent).toEqual({ ok: true, outil: "todo_echo", n: 1, compte: "bob" });
    const alice = await client(base, "/mcp/todo", false, "cli-alice");
    const ra = await alice.callTool({ name: "todo_echo", arguments: {}, _meta: { username: "bob" } });
    expect((ra.structuredContent as Dict)["compte"]).toBe("alice");
    const sansJeton = await fetch(`${base}/mcp/todo`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(sansJeton.status).toBe(401);
    const fs = await fetch(`${base}/mcp/fs`, {
      method: "POST",
      headers: { authorization: `Bearer ${SVC}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect([fs.status, await fs.json()]).toEqual([503, { detail: MESSAGE_NON_SERVIE }]);
  });

  it("racine /mcp servie par l'hôte avec toutes ses familles natives (point d'entrée agrégé), jeton exigé", async () => {
    appels.length = 0;
    const { base } = await hote();
    const racine = await client(base, "/mcp");
    expect((await racine.listTools()).tools.map((t) => t.name)).toEqual(["todo_echo", "todo_compte"]);
    const r = await racine.callTool({ name: "todo_echo", arguments: {}, _meta: { username: "bob" } });
    expect(r.structuredContent).toEqual({ ok: true, outil: "todo_echo", n: 1, compte: "bob" });
    const sansJeton = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(sansJeton.status).toBe(401);
  });

  it("SSE : /sse/<native> et ses messages servis par l'hôte ; sans jeton, 401 ; une session inconnue est introuvable", async () => {
    appels.length = 0;
    const { base } = await hote({ transports: ["http", "sse"] });
    const todo = await client(base, "/sse/todo", true);
    expect((await todo.listTools()).tools.map((t) => t.name)).toEqual(["todo_echo", "todo_compte"]);
    expect((await todo.callTool({ name: "todo_compte", arguments: {} })).structuredContent).toMatchObject({
      ok: true,
      outil: "todo_compte",
      n: 1,
    });
    const flux = await fetch(`${base}/sse/todo`, {
      headers: { authorization: `Bearer ${SVC}`, accept: "text/event-stream" },
    });
    const lecteur = flux.body?.getReader();
    const premier = new TextDecoder().decode((await lecteur?.read())?.value);
    const sid = /session_id=([0-9a-f]+)/u.exec(premier)?.[1] ?? "";
    expect(sid).not.toBe("");
    const sansJeton = await fetch(`${base}/messages/?session_id=${sid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(sansJeton.status).toBe(401);
    await lecteur?.cancel();
    const inconnue = await fetch(`${base}/messages/?session_id=${"a".repeat(32)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SVC}` },
      body: "{}",
    });
    expect(inconnue.status).toBe(404);
    expect((await fetch(`${base}/sse/fs`, { headers: { authorization: `Bearer ${SVC}` } })).status).toBe(404);
  });

  it("/health et /manifest ne comptent que les familles natives ; SSE annoncé par famille native ; retirer une famille de families la retire du service", async () => {
    const { h } = await hote();
    const ctx = {
      tc: h.composition.tc,
      natif: h.composition.natif,
      stdio: (f: string) => ({ command: "node", args: [f] }),
    };
    expect(sante(ctx)).toMatchObject({
      families: ["todo"],
      tools: 2,
      transports: ["http", "sse"],
      sse_path: "/sse",
    });
    const m = manifeste(ctx, "http", "https://th.lan");
    expect(m["families"]).toEqual({ todo: 2 });
    expect(m["endpoints"]).toMatchObject({
      todo: { http: "https://th.lan/mcp/todo", sse: "https://th.lan/sse/todo" },
    });
    expect(m["endpoints"]).not.toHaveProperty("fs");
    const r = await h.app.inject({ method: "GET", url: "/health" });
    expect((r.json() as Dict)["tools"]).toBe(2);
    const mi = await h.app.inject({ method: "GET", url: "/manifest", headers: entetes() });
    expect((mi.json() as { config: Dict }).config["familles_natives"]).toEqual(["todo"]);
    const env: NodeJS.ProcessEnv = {};
    appliquerEnvironnement(h.composition.tc, env);
    expect(env).not.toHaveProperty("LOCAL_MCP_TOOL_FAMILIES");

    const retiree = await hote({ families: ["fs"] });
    expect(retiree.h.composition.natif).toBeNull();
    const todo = await fetch(`${retiree.base}/mcp/todo`, {
      method: "POST",
      headers: { authorization: `Bearer ${SVC}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(todo.status).toBe(503);
  });
});
