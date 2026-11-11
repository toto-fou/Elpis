// SPDX-License-Identifier: MIT
/** apps/core/test/mcp/chart-pont.test.ts — famille chart servie en processus : entrée `inprocess` du manifeste (client du pool), pont `/api/mcp-bridge/chart` (jeton, identité, ressource), façade OpenAPI qui ne l'expose pas, retour arrière par le manifeste. */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { tokenDigest } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { reinitialiserRefus } from "../../src/graphiques/moteur/index";
import { creerFamilleOpenapi } from "../../src/familles/openapi";
import { creerPontMcp } from "../../src/familles/pont-mcp";
import { clearCache } from "../../src/outils/openapi";
import { resoudreClientMcp } from "../../src/outils/mcp/clients";
import {
  creerServeurEnProcessus,
  enregistrerFamillesEnProcessus,
  oublierServeurEnProcessus,
  serviceEnProcessus,
} from "../../src/outils/mcp/en-processus";
import { familleChart } from "../../src/outils/mcp/famille-chart";
import { appTest, journalMuet } from "../aides";

type Dict = Record<string, unknown>;

const ALICE = "pcr_" + "a".repeat(40);
const BOB = "pcr_" + "b".repeat(40);
const FS = "ept_" + "f".repeat(40);
const J = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const VENTES = [
  { m: "a", v: 1 },
  { m: "b", v: 2 },
];

function messages(texte: string): Dict[] {
  return texte
    .split("\r\n\r\n")
    .filter((b) => b.startsWith("event: message"))
    .map((b) => JSON.parse(b.split("\r\ndata: ")[1] ?? "null") as Dict);
}

describe("famille chart servie en processus", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let base = "";

  const fichiers = (compte: string): string[] => {
    const d = join(dossier, "cache", compte);
    return existsSync(d) ? readdirSync(d).sort() : [];
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 1 });
    await createUser(t.base, "bob", "mdp-bob");
    for (const [jeton, uid, type, familles] of [
      [ALICE, 1, "opencode", ""],
      [BOB, 2, "opencode", ""],
      [FS, 1, "tools", "fs"],
    ] as const)
      await t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [uid, type, type, tokenDigest(jeton), jeton.slice(-4), familles, Date.now() / 1000],
      );
    dossier = mkdtempSync(join(tmpdir(), "elpis-chart-pont-"));
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ mcp: { tokens: { tools_families: "fs" } } }),
    );
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: { "elpis-chart": { "x-elpis": { role: "app", families: ["chart"] } } },
      }),
    );
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    vi.stubEnv("CHART_CACHE_DIR", join(dossier, "cache"));
    oublierManifeste();
    reinitialiserRefus();
    creerServeurEnProcessus({ famillesOpencode: ["chart"], limiteDebit: null, limiteConcurrence: null });
    expect(enregistrerFamillesEnProcessus([familleChart()])).toEqual(["chart"]);
    expect(enregistrerFamillesEnProcessus([familleChart()])).toEqual([]);
    const jetons = dependancesParDefaut(t.base);
    const oauth: DependancesOAuth = { base: t.base, config: () => configView() };
    const pont = creerPontMcp({
      jetons,
      oauth,
      journal: journalMuet,
      reverificationMs: 50,
      enProcessus: () => serviceEnProcessus(),
    });
    const openapi = creerFamilleOpenapi({ jetons, journal: journalMuet });
    app = await appTest({ familles: [pont.famille, openapi], extensions: [pont.extension] });
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

  async function poster(chemin: string, entetes: Record<string, string>, corps: unknown) {
    const r = await fetch(base + chemin, {
      method: "POST",
      headers: { ...J, ...entetes },
      body: JSON.stringify(corps),
    });
    return { statut: r.status, entetes: r.headers, texte: await r.text() };
  }

  async function session(jeton: string, famille = "chart"): Promise<Record<string, string>> {
    const chemin = `/api/mcp-bridge/${famille}`;
    const init = await poster(chemin, { authorization: `Bearer ${jeton}` }, INIT);
    expect(init.statut, init.texte).toBe(200);
    const S = {
      authorization: `Bearer ${jeton}`,
      "mcp-session-id": init.entetes.get("mcp-session-id") ?? "",
    };
    expect((await poster(chemin, S, { jsonrpc: "2.0", method: "notifications/initialized" })).statut).toBe(
      202,
    );
    return S;
  }

  async function requete(
    S: Record<string, string>,
    id: number,
    method: string,
    params?: Dict,
  ): Promise<Dict> {
    const r = await poster("/api/mcp-bridge/chart", S, {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    });
    return messages(r.texte)[0] ?? {};
  }

  it("entrée role=app sans url → client du pool en mémoire : 30 outils chart_*, appel avec l'identité de _meta, fichier dans le dossier du compte", async () => {
    const entree = load().get("elpis-chart");
    expect(entree?.type).toBe("inprocess");
    const client = resoudreClientMcp(entree?.clientCfg() ?? {});
    expect(client?.constructor.name).toBe("ClientMcpEnProcessus");
    if (client === null) return;
    const signal = new AbortController().signal;
    await client.connecter(signal);
    try {
      const outils = await client.listerOutils(signal);
      expect(outils).toHaveLength(30);
      expect(outils.every((o) => String(o["name"]).startsWith("chart_"))).toBe(true);
      const r = (await client.appelerOutil(
        "chart_bar",
        { data: VENTES, title: "T" },
        { meta: { username: "alice", chat_id: "c1" }, signal },
      )) as Dict;
      expect((r["structuredContent"] as Dict)["result"]).toMatchObject({
        ok: true,
        chart_id: "abc53bd62331",
      });
      expect(fichiers("alice")).toEqual(["abc53bd62331.json"]);
      const refus = (await client.appelerOutil(
        "chart_table",
        { data: [{}] },
        { meta: { username: "alice" }, signal },
      )) as Dict;
      expect(refus["isError"]).toBe(true);
    } finally {
      await client.fermer();
    }
  });

  it("pont /api/mcp-bridge/chart : jeton opencode vérifié, 30 outils, identité du jeton (pas du _meta), ressource chart:// limitée au compte du jeton", async () => {
    const S = await session(ALICE);
    const liste = (await requete(S, 2, "tools/list"))["result"] as Dict;
    expect((liste["tools"] as Dict[]).map((o) => o["name"]).slice(0, 3)).toEqual([
      "chart_bar",
      "chart_line",
      "chart_area",
    ]);
    expect(liste["tools"]).toHaveLength(30);
    const appel = (
      await requete(S, 3, "tools/call", {
        name: "chart_line",
        arguments: {
          data: [
            { x: "a", y: 1.0 },
            { x: "b", y: 2 },
          ],
          trend: true,
        },
        _meta: { username: "mallory", chat_id: "c9" },
      })
    )["result"] as Dict;
    expect(appel["isError"]).toBe(false);
    const id = ((appel["structuredContent"] as Dict)["result"] as Dict)["chart_id"] as string;
    expect(fichiers("alice")).toContain(`${id}.json`);
    expect(fichiers("mallory")).toEqual([]);
    const lire = async (jeton: string, compte: string): Promise<string> => {
      const s = await session(jeton);
      const r = (await requete(s, 4, "resources/read", { uri: `chart://${compte}/${id}` }))["result"] as Dict;
      return ((r["contents"] as Dict[])[0] as Dict)["text"] as string;
    };
    expect(await lire(ALICE, "alice")).toContain('"series"');
    expect(await lire(BOB, "alice")).toBe(`{"ok": false, "error": "chart_not_found", "chart_id": "${id}"}`);
    const modeles = (await requete(S, 5, "resources/templates/list"))["result"] as Dict;
    expect((modeles["resourceTemplates"] as Dict[]).map((m) => m["uriTemplate"])).toEqual([
      "chart://{username}/{chart_id}",
    ]);
  });

  it("pont : un jeton d'outils sans la famille chart ne voit aucun outil et ne peut pas appeler chart_bar ; jeton absent ou inconnu → 401", async () => {
    const S = await session(FS);
    expect(((await requete(S, 2, "tools/list"))["result"] as Dict)["tools"]).toEqual([]);
    const appel = await requete(S, 3, "tools/call", { name: "chart_bar", arguments: { data: VENTES } });
    expect(appel["error"]).toMatchObject({ code: -32602, message: "Unknown tool: 'chart_bar'" });
    expect((await poster("/api/mcp-bridge/chart", {}, INIT)).statut).toBe(401);
    expect((await poster("/api/mcp-bridge/chart", { authorization: "Bearer ept_faux" }, INIT)).statut).toBe(
      401,
    );
  });

  it("façade OpenAPI : la famille chart n'est pas exposée (404 comme une famille inconnue, jeton d'outils valide compris)", async () => {
    clearCache();
    const auth = { authorization: `Bearer ${FS}` };
    const spec = await fetch(`${base}/api/tools/chart/openapi.json`, { headers: auth });
    expect(spec.status).toBe(404);
    await spec.arrayBuffer();
    const appel = await fetch(`${base}/api/tools/chart/chart_bar`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ data: VENTES }),
    });
    expect(appel.status).toBe(404);
    await appel.arrayBuffer();
  });

  it("entrée app avec une URL réseau : servie par ce serveur, le client n'est plus en processus", () => {
    const reseau = {
      version: 1,
      mcpServers: {
        "elpis-chart": {
          type: "http",
          url: "http://127.0.0.1:8766/mcp/chart",
          "x-elpis": { role: "app", families: ["chart"] },
        },
      },
    };
    writeFileSync(join(dossier, "mcp.json"), JSON.stringify(reseau));
    oublierManifeste();
    const entree = load().get("elpis-chart");
    expect([entree?.type, entree?.url, entree?.clientCfg()["type"]]).toEqual([
      "http",
      "http://127.0.0.1:8766/mcp/chart",
      "stdio",
    ]);
  });
});
