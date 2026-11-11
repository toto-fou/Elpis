// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/browser-core.test.ts — essai réel core TS (pool, une connexion par famille) → hôte TS (browser natif, mémoire AX dans la base de l'hôte) → service navigateur factice : session ouverte et pilotée pour le compte du `_meta`, refusée à un autre, mémoire relue. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { oublierManifeste, PoolMcp } from "@elpis/mcp";
import type { ConfigMcp } from "@elpis/mcp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { lireGolden } from "../../../../packages/outils-mcp/test/familles-test";
import { resoudreClientMcp } from "../../../core/src/outils/mcp/clients";
import { fermerBaseHote, ouvrirBaseHote } from "../../src/base-hote";
import { configTest, hoteTest, journalMuet, SVC } from "../aides";
import type { HoteTest } from "../aides";
import { FauxNavigateur, SESSION, SITE } from "../faux-navigateur";

const SENTINELLE: ConfigMcp = {
  type: "stdio",
  name: "Outils Locaux",
  command: "DEFAULT_LOCAL_PYTHON",
  manifest: "elpis-tools",
};

describe("core TS → hôte TS : famille browser native, mémoire AX dans la base de l'hôte", () => {
  let dossier: string;
  let h: HoteTest;
  let faux: FauxNavigateur;
  const restaurer: (() => void)[] = [];
  const pool = new PoolMcp({ rejouable: () => false, parallelisme: () => 4, ttlOutilsS: () => 360 });
  const appeler = (outil: string, args: Record<string, unknown>, username: string): Promise<unknown> =>
    pool.callTool(SENTINELLE, outil, args, { resolveClient: resoudreClientMcp, meta: { username } });
  const resultat = (r: unknown): Record<string, unknown> =>
    ((r as { structuredContent: { result: Record<string, unknown> } }).structuredContent ?? {}).result;

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-browser-core-")));
    faux = await FauxNavigateur.demarrer();
    vi.stubEnv("PLAYWRIGHT_API_URL", faux.url);
    vi.stubEnv("PW_OWNERS_DIR", path.join(dossier, "owners"));
    restaurer.push(surchargerConfig({ DB_BACKEND: "sqlite", DB_PATH: path.join(dossier, "toolhost.db") }));
    invalidateConfigCache();
    expect(await ouvrirBaseHote(() => journalMuet)).not.toBeNull();
    h = await hoteTest(configTest({ families: ["browser"], familles_natives: ["browser"] }));
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
            "x-elpis": { role: "toolhost", host: "main", families: ["browser"] },
          },
        },
      }),
    );
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    oublierManifeste();
  }, 60_000);

  afterAll(async () => {
    const fermetures = [
      async () => {
        await pool.closeAll();
        await pool.attendreFermetures();
      },
      async () => h?.fermer(),
      async () => faux?.arreter(),
      fermerBaseHote,
    ];
    const echecs = (await Promise.allSettled(fermetures.map((f) => f()))).filter(
      (r) => r.status === "rejected",
    );
    vi.unstubAllEnvs();
    oublierManifeste();
    for (const r of restaurer.reverse()) r();
    invalidateConfigCache();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
    if (echecs.length) throw (echecs[0] as PromiseRejectedResult).reason;
  }, 30_000);

  it("outils du core = golden browser ; session ouverte et pilotée pour alice, refusée à bob ; mémoire AX relue par pw_memory", async () => {
    const [, outils] = await pool.getOrConnect(SENTINELLE, resoudreClientMcp);
    expect(outils).toEqual(lireGolden("browser").outils);

    expect(
      resultat(await appeler("pw_session", { action: "start", url: `${SITE}/` }, "alice")),
    ).toMatchObject({
      ok: true,
      session_id: SESSION,
    });
    const clic = resultat(
      await appeler(
        "pw_act",
        { session_id: SESSION, action: "click", target: "role=link|name=Produits" },
        "alice",
      ),
    );
    expect(clic).toMatchObject({
      ok: true,
      element_name: "Produits",
      page_after: { url: `${SITE}/produits` },
    });
    expect(faux.vues.map((v) => `${v.methode} ${v.chemin}`)).toEqual([
      "POST /start",
      "GET /smart_inspect",
      "POST /action",
      "GET /smart_inspect",
      "GET /smart_inspect",
    ]);
    for (const v of faux.vues)
      expect(
        v.methode === "GET" ? new URLSearchParams(v.requete).get("owner") : JSON.parse(v.corps).owner,
      ).toBe("alice");

    const refus = (await appeler("pw_page", { session_id: SESSION, action: "tabs" }, "bob")) as {
      isError: boolean;
    };
    expect(refus.isError).toBe(true);
    expect(JSON.stringify(refus)).toContain("not_your_session");
    expect(faux.vues).toHaveLength(5);

    expect(
      resultat(
        await appeler("pw_memory", { action: "path", site: "93.184.216.34", to_path: "/produits" }, "alice"),
      ),
    ).toMatchObject({
      op: "path",
      found: true,
      from_path: "/",
      steps: [{ from: "/", to: "/produits", action_role: "link", action_name: "Produits" }],
    });
  }, 60_000);
});
