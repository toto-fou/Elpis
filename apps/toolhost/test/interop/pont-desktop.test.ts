// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/pont-desktop.test.ts — essai réel core TS → pont MCP (/api/mcp-bridge/desktop, délégation signée) → famille desktop native de l'hôte TS → faux agent bureau : le compte délégué atteint l'agent. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, creerJeton, dependancesParDefaut } from "@elpis/auth";
import { invalidateConfigCache, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { remplacerBase } from "../../../core/src/base";
import { FauxLan } from "../../../core/test/faux-lan";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-pont-desktop-categories-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

describe("core TS → pont MCP → famille desktop native de l'hôte TS", () => {
  let dossier: string;
  let h: HoteTest;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let lan: FauxLan;
  let restaurer: () => void;
  let core = "";
  const jetons: Record<string, string> = {};

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-pont-desktop-")));
    lan = await FauxLan.demarrer();
    writeFileSync(
      path.join(dossier, "config.json"),
      JSON.stringify({
        desktop: {
          targets: [
            {
              name: "vm-alice",
              os: "windows",
              agent_url: `${lan.url}/a`,
              access: "list",
              allowed_users: ["alice"],
            },
          ],
        },
      }),
    );
    vi.stubEnv("DESKTOP_SCREENS_DIR", path.join(dossier, "ecrans"));
    vi.stubEnv("DESKTOP_ACTIVE_PATH", path.join(dossier, "actif.json"));
    vi.stubEnv("ELPIS_AUDIT_DIR", path.join(dossier, "audit"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
    invalidateConfigCache();
    reloadDesktopConfigFromDisk(true);
    h = await hoteTest(configTest({ families: ["fs", "desktop"], familles_natives: ["desktop"] }));
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const hote = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    writeFileSync(
      path.join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        toolHosts: { main: { url: hote, token: SVC } },
        mcpServers: {
          "elpis-tools": {
            type: "http",
            url: `${hote}/mcp`,
            headers: { Authorization: `Bearer ${SVC}` },
            "x-elpis": { role: "toolhost", host: "main", families: ["fs", "desktop"] },
          },
        },
      }),
    );
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    oublierManifeste();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    remplacerBase(t.base);
    const dep = dependancesParDefaut(t.base);
    for (const nom of ["alice", "bob"]) {
      const uid = await createUser(t.base, nom, `mdp-${nom}-pont`, { isAdmin: 0 });
      [jetons[nom] = ""] = await creerJeton(dep, uid, "tools", "pont", ["desktop"]);
    }
    const journal = new Journal({ niveau: "warn", sortie: () => undefined });
    const composition = await composerCore("main", t.base, journal);
    app = await creerApp({ mode: "main", journal, ...composition });
    await app.listen({ port: 0, host: "127.0.0.1" });
    core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    try {
      app?.server.closeAllConnections();
      await app?.close();
      await h?.fermer();
      await lan?.arreter();
    } finally {
      vi.unstubAllEnvs();
      remplacerBase(undefined);
      oublierManifeste();
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      rmSync(CACHE, { force: true });
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  }, 30_000);

  async function client(nom: string): Promise<Client> {
    const c = new Client({ name: "pont", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${core}/api/mcp-bridge/desktop`), {
        requestInit: { headers: { authorization: `Bearer ${jetons[nom] ?? ""}` } },
      }),
    );
    return c;
  }

  it("alice (jeton personnel délégué) liste les outils natifs et atteint son poste ; bob n'a aucune cible", async () => {
    const alice = await client("alice");
    try {
      expect((await alice.listTools()).tools.map((t) => t.name)).toContain("desktop_session");
      lan.reponses = [{ statut: 200, json: { ok: true, version: "9" } }];
      lan.vues.length = 0;
      const r = await alice.callTool({ name: "desktop_session", arguments: {} });
      expect(r.structuredContent).toEqual({
        ok: true,
        target: "vm-alice",
        healthy: true,
        agent: { ok: true, version: "9" },
      });
      expect(lan.vues.map((v) => v.p)).toEqual(["/a/health"]);
    } finally {
      await alice.close();
    }
    const bob = await client("bob");
    try {
      lan.vues.length = 0;
      const r = await bob.callTool({ name: "desktop_session", arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("no_target");
      expect(lan.vues).toEqual([]);
    } finally {
      await bob.close();
    }
  }, 30_000);
});
