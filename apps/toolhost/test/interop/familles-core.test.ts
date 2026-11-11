// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/familles-core.test.ts — essai réel core TS (pool, une connexion par famille) → hôte TS (toutes les familles portées, natives) : outils du core = goldens agrégés, desktop servi pour le compte du `_meta`, familles du compte refusées par l'hôte. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidateConfigCache, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { FAMILY_NAMES, oublierManifeste, PoolMcp } from "@elpis/mcp";
import type { ConfigMcp } from "@elpis/mcp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { lireGolden } from "../../../../packages/outils-mcp/test/familles-test";
import { ClientMcpHttp, ClientMcpParFamille, resoudreClientMcp } from "../../../core/src/outils/mcp/clients";
import { FauxLan } from "../../../core/test/faux-lan";
import { FAMILLES_NATIVES_PORTEES } from "../../src/config";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";

const SENTINELLE: ConfigMcp = {
  type: "stdio",
  name: "Outils Locaux",
  command: "DEFAULT_LOCAL_PYTHON",
  manifest: "elpis-tools",
};
const NATIVES = FAMILY_NAMES.filter((f) => FAMILLES_NATIVES_PORTEES.includes(f));
const AGREGE = NATIVES.flatMap((f) => lireGolden(f).outils);

describe("core TS → hôte TS : familles natives, une connexion par famille", () => {
  let dossier: string;
  let h: HoteTest;
  let lan: FauxLan;
  let hote = "";
  const restaurer: (() => void)[] = [];
  const pool = new PoolMcp({ rejouable: () => false, parallelisme: () => 4, ttlOutilsS: () => 360 });

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-familles-core-")));
    lan = await FauxLan.demarrer();
    writeFileSync(
      path.join(dossier, "config.json"),
      JSON.stringify({
        desktop: { targets: [{ name: "vm1", os: "windows", agent_url: `${lan.url}/a`, default: true }] },
      }),
    );
    vi.stubEnv("DESKTOP_SCREENS_DIR", path.join(dossier, "ecrans"));
    vi.stubEnv("DESKTOP_ACTIVE_PATH", path.join(dossier, "actif.json"));
    restaurer.push(
      surchargerConfig({
        CONFIG_JSON_PATH: path.join(dossier, "config.json"),
        DESKTOP_DISABLE_SHELL: false,
        DESKTOP_EXPOSE_RAW_TOOLS: false,
      }),
    );
    invalidateConfigCache();
    reloadDesktopConfigFromDisk(true);
    h = await hoteTest(configTest({ families: [...NATIVES], familles_natives: [...NATIVES] }));
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    hote = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
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
            "x-elpis": { role: "toolhost", host: "main", families: [...NATIVES] },
          },
        },
      }),
    );
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    oublierManifeste();
  }, 60_000);

  afterAll(async () => {
    try {
      await pool.closeAll();
      await pool.attendreFermetures();
      await h?.fermer();
      await lan?.arreter();
    } finally {
      vi.unstubAllEnvs();
      oublierManifeste();
      for (const r of restaurer.reverse()) r();
      invalidateConfigCache();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  }, 30_000);

  it("outils du core = goldens agrégés des familles natives ; desktop servi par l'hôte pour le compte du `_meta` ; racine /mcp = toutes les natives ; familles du compte (servies par main) refusées", async () => {
    const [client, outils] = await pool.getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(client).toBeInstanceOf(ClientMcpParFamille);
    expect(outils).toEqual(AGREGE);

    lan.reponses = [{ statut: 200, json: { ok: true, version: "9" } }];
    lan.vues.length = 0;
    const bureau = await pool.callTool(
      SENTINELLE,
      "desktop_session",
      {},
      {
        resolveClient: resoudreClientMcp,
        meta: { username: "alice" },
      },
    );
    expect((bureau as { structuredContent: unknown }).structuredContent).toEqual({
      ok: true,
      target: "vm1",
      healthy: true,
      agent: { ok: true, version: "9" },
    });
    expect(lan.vues.map((v) => v.p)).toEqual(["/a/health"]);

    const racine = new ClientMcpHttp(`${hote}/mcp`, { Authorization: `Bearer ${SVC}` });
    try {
      await racine.connecter(new AbortController().signal);
      expect(await racine.listerOutils(new AbortController().signal)).toEqual(AGREGE);
    } finally {
      await racine.fermer();
    }
    for (const f of FAMILY_NAMES.filter((x) => !NATIVES.includes(x))) {
      const r = await fetch(`${hote}/mcp/${f}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SVC}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(r.status, f).toBe(503);
    }
  }, 60_000);
});
