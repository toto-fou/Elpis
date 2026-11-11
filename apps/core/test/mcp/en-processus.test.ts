// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/en-processus.test.ts — familles du compte servies en processus : client `inprocess` du pool et pont `/api/mcp-bridge/<famille>` sans saut réseau (jetons, délégation, portée). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import type { DependancesOAuth } from "@elpis/auth";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { load, oublierManifeste } from "@elpis/mcp";
import { ok } from "@elpis/outils-mcp";
import type { DefinitionOutil } from "@elpis/outils-mcp";
import { current, tokenDigest } from "@elpis/securite";
import { py } from "@elpis/http";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerPontMcp } from "../../src/familles/pont-mcp";
import type { PontMcp } from "../../src/familles/pont-mcp";
import { resoudreClientMcp } from "../../src/outils/mcp/clients";
import {
  creerServeurEnProcessus,
  enregistrerFamilleEnProcessus,
  oublierServeurEnProcessus,
  serviceEnProcessus,
} from "../../src/outils/mcp/en-processus";
import { appTest, journalMuet } from "../aides";

type Dict = Record<string, unknown>;

const OUTILS_FS = "ept_" + "f".repeat(40);
const OPENCODE = "pcr_" + "o".repeat(40);
const J = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function outil(nom: string, famille: string): DefinitionOutil {
  return {
    nom,
    famille,
    definition: { name: nom, description: `Outil ${nom}.`, inputSchema: { type: "object", properties: {} } },
    signature: { x: py.int().defaut(0) },
    traiter: () => {
      const i = current();
      return ok({ compte: i?.username ?? null, uid: i?.user_id ?? null, x: 1 });
    },
  };
}

function messages(texte: string): Dict[] {
  return texte
    .split("\r\n\r\n")
    .filter((b) => b.startsWith("event: message"))
    .map((b) => JSON.parse(b.split("\r\ndata: ")[1] ?? "null") as Dict);
}

describe("familles du compte servies en processus", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let pont: PontMcp;
  let dossier: string;
  let restaurer: () => void;
  let base = "";

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 1 });
    for (const [jeton, type, familles] of [
      [OUTILS_FS, "tools", "fs"],
      [OPENCODE, "opencode", ""],
    ] as const)
      await t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [1, type, type, tokenDigest(jeton), jeton.slice(-4), familles, Date.now() / 1000],
      );
    dossier = mkdtempSync(join(tmpdir(), "elpis-enprocessus-"));
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ mcp: { tokens: { tools_families: "todo,fs" } } }),
    );
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: {
          "elpis-todo": { "x-elpis": { role: "app", families: ["todo"] } },
          "elpis-memory": { "x-elpis": { role: "app", families: ["memory"] } },
        },
      }),
    );
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    oublierManifeste();
    creerServeurEnProcessus({ famillesOpencode: ["todo"], limiteDebit: null, limiteConcurrence: null });
    enregistrerFamilleEnProcessus("todo", [outil("todo_a", "todo"), outil("todo_b", "todo")]);
    enregistrerFamilleEnProcessus("memory", [outil("souvenir", "memory")]);
    const oauth: DependancesOAuth = { base: t.base, config: () => configView() };
    pont = creerPontMcp({
      jetons: dependancesParDefaut(t.base),
      oauth,
      journal: journalMuet,
      reverificationMs: 50,
      enProcessus: () => serviceEnProcessus(),
    });
    app = await appTest({ familles: [pont.famille], extensions: [pont.extension] });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    try {
      await serviceEnProcessus()?.fermer();
      app?.server.closeAllConnections();
      await app?.close();
    } finally {
      oublierServeurEnProcessus();
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("entrée inprocess du manifeste → client du pool en mémoire, limité aux familles de l'entrée (aucune si vide), identité par _meta", async () => {
    const entree = load().get("elpis-todo");
    expect(entree?.type).toBe("inprocess");
    const client = resoudreClientMcp(entree?.clientCfg() ?? {});
    expect(client?.constructor.name).toBe("ClientMcpEnProcessus");
    if (client === null) return;
    const signal = new AbortController().signal;
    await client.connecter(signal);
    try {
      expect((await client.listerOutils(signal)).map((o) => o["name"])).toEqual(["todo_a", "todo_b"]);
      const r = (await client.appelerOutil(
        "todo_a",
        {},
        { meta: { username: "alice", user_id: 1 }, signal },
      )) as Dict;
      expect(r["structuredContent"]).toEqual({ ok: true, compte: "alice", uid: 1, x: 1 });
      await expect(
        client.appelerOutil("souvenir", {}, { meta: { username: "alice" }, signal }),
      ).rejects.toThrow("Unknown tool: 'souvenir'");
    } finally {
      await client.fermer();
    }
    const vide = resoudreClientMcp({ ...entree?.clientCfg(), name: "elpis-vide", families: [] });
    if (vide === null) return;
    await vide.connecter(signal);
    try {
      expect(await vide.listerOutils(signal)).toEqual([]);
    } finally {
      await vide.fermer();
    }
  });

  async function poster(chemin: string, entetes: Record<string, string>, corps: unknown) {
    const r = await fetch(base + chemin, {
      method: "POST",
      headers: { ...J, ...entetes },
      body: JSON.stringify(corps),
    });
    return { statut: r.status, entetes: r.headers, texte: await r.text() };
  }

  it("pont : jeton opencode vérifié, délégation appliquée sans réseau (aucun LOCAL_MCP_URL), en-têtes du relais", async () => {
    const auth = { authorization: `Bearer ${OPENCODE}` };
    const init = await poster("/api/mcp-bridge/todo", auth, INIT);
    expect(init.statut).toBe(200);
    expect(init.entetes.get("cache-control")).toContain("no-store");
    expect(init.entetes.get("content-type")).toBe("text/event-stream");
    const sid = init.entetes.get("mcp-session-id") ?? "";
    expect(((messages(init.texte)[0]?.["result"] as Dict)["serverInfo"] as Dict)["name"]).toBe("elpis-app");
    const S = { ...auth, "mcp-session-id": sid };
    expect(
      (await poster("/api/mcp-bridge/todo", S, { jsonrpc: "2.0", method: "notifications/initialized" }))
        .statut,
    ).toBe(202);
    const liste = messages(
      (await poster("/api/mcp-bridge/todo", S, { jsonrpc: "2.0", id: 2, method: "tools/list" })).texte,
    );
    expect(((liste[0]?.["result"] as Dict)["tools"] as Dict[]).map((o) => o["name"])).toEqual([
      "todo_a",
      "todo_b",
    ]);
    const appel = messages(
      (
        await poster("/api/mcp-bridge/todo", S, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "todo_a", arguments: {}, _meta: { username: "mallory", user_id: 99 } },
        })
      ).texte,
    );
    expect((appel[0]?.["result"] as Dict)["structuredContent"]).toEqual({
      ok: true,
      compte: "alice",
      uid: 0,
      x: 1,
    });
    const fin = await fetch(base + "/api/mcp-bridge/todo", { method: "DELETE", headers: S });
    expect(fin.status).toBe(200);
    await fin.arrayBuffer();
  });

  it("pont : familles refusées au client (jeton d'outils sans la famille, famille hors opencode) et flux GET sans session → 405", async () => {
    const restreint = await poster("/api/mcp-bridge/todo", { authorization: `Bearer ${OUTILS_FS}` }, INIT);
    const sid = restreint.entetes.get("mcp-session-id") ?? "";
    const vue = messages(
      (
        await poster(
          "/api/mcp-bridge/todo",
          { authorization: `Bearer ${OUTILS_FS}`, "mcp-session-id": sid },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        )
      ).texte,
    );
    expect((vue[0]?.["result"] as Dict)["tools"]).toEqual([]);
    const oc = await poster("/api/mcp-bridge/memory", { authorization: `Bearer ${OPENCODE}` }, INIT);
    const sidOc = oc.entetes.get("mcp-session-id") ?? "";
    const vueOc = messages(
      (
        await poster(
          "/api/mcp-bridge/memory",
          { authorization: `Bearer ${OPENCODE}`, "mcp-session-id": sidOc },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        )
      ).texte,
    );
    expect((vueOc[0]?.["result"] as Dict)["tools"]).toEqual([]);
    const get = await fetch(base + "/api/mcp-bridge/todo", {
      headers: { authorization: `Bearer ${OPENCODE}`, accept: "text/event-stream" },
    });
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
    await get.arrayBuffer();
    expect((await poster("/api/mcp-bridge/todo", {}, INIT)).statut).toBe(401);
    expect((await poster("/api/mcp-bridge/todo", { authorization: "Bearer ept_faux" }, INIT)).statut).toBe(
      401,
    );
    expect(
      (await poster("/api/mcp-bridge/inconnue", { authorization: `Bearer ${OPENCODE}` }, INIT)).statut,
    ).toBe(404);
  });

  it("pont : flux GET d'une session fermé quand le jeton est révoqué", async () => {
    const auth = { authorization: `Bearer ${OPENCODE}` };
    const init = await poster("/api/mcp-bridge/todo", auth, INIT);
    const sid = init.entetes.get("mcp-session-id") ?? "";
    const flux = await fetch(base + "/api/mcp-bridge/todo", {
      headers: { ...auth, "mcp-session-id": sid, accept: "text/event-stream" },
    });
    expect(flux.status).toBe(200);
    await t.base.run("DELETE FROM tool_tokens WHERE token_hash=?", [tokenDigest(OPENCODE)]);
    const lu = await Promise.race([
      flux.text().then(() => "fermé"),
      new Promise((fin) => setTimeout(() => fin("ouvert"), 18_000)),
    ]);
    expect(lu).toBe("fermé");
  }, 25_000);
});
