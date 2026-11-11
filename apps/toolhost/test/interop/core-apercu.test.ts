// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/core-apercu.test.ts — essai réel core TS → hôte TS des aperçus : jeton d'aperçu signé par main, pv/pvs/preview, capture Playwright et trame du bureau servis par l'hôte TS derrière le relais. */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { AgentClient } from "@elpis/fichiers";
import { oublierManifeste } from "@elpis/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { remplacerBase } from "../../../core/src/base";
import { BacTest, PYTHON } from "@elpis/fichiers/test";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-toolhost-apercu-categories-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const lignesCore: string[] = [];
const journalCore = new Journal({ niveau: "info", sortie: (l) => lignesCore.push(l) });

describe.skipIf(!PYTHON)("core TS → hôte TS : aperçus, captures et trames", () => {
  let dossier = "";
  let bac: BacTest;
  let h: HoteTest;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let amont: Server;
  let restaurer: () => void;
  let core = "";
  let cookie = "";
  let uid = 0;
  let portAmont = 0;
  const uidsVus: number[] = [];

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-core-apercu-")));
    amont = createServer((req, rep) => {
      if (req.method === "DELETE") return void rep.writeHead(200).end("{}");
      if ((req.url ?? "").startsWith("/screenshots/"))
        return void rep.writeHead(200, { "content-type": "image/png" }).end(PNG);
      rep
        .writeHead(200, { "content-type": "text/plain", "set-cookie": "vol=1" })
        .end(`amont ${req.url ?? ""}`);
    });
    await new Promise<void>((fin) => amont.listen(0, "127.0.0.1", fin));
    portAmont = (amont.address() as AddressInfo).port;
    const proprietaires = path.join(dossier, "pw-owners");
    const trames = path.join(dossier, "trames");
    mkdirSync(proprietaires, { mode: 0o700 });
    chmodSync(proprietaires, 0o700);
    mkdirSync(trames);
    writeFileSync(path.join(proprietaires, "sessAAAA1111.owner"), "alice");
    writeFileSync(path.join(trames, "frame_trameALIC0001.owner"), "alice");
    writeFileSync(path.join(trames, "frame_trameALIC0001.png"), PNG);
    vi.stubEnv("PLAYWRIGHT_API_URL", `http://127.0.0.1:${portAmont}`);
    vi.stubEnv("PW_OWNERS_DIR", proprietaires);
    vi.stubEnv("DESKTOP_SCREENS_DIR", trames);
    vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(dossier, "fh"));
    bac = new BacTest(dossier, "alice");
    writeFileSync(
      path.join(bac.sandboxPath, "index.html"),
      '<html><head></head><img src="/logo.png"></html>',
    );
    writeFileSync(path.join(bac.sandboxPath, "data.json"), '{"ok":true}');
    await bac.startAgent(false);
    const agent = new AgentClient(bac);
    h = await hoteTest(configTest(), {
      bacDuCompte: {
        racine: async (u) => (uidsVus.push(u), bac.sandboxPath),
        agent: async () => agent,
      },
      ipConteneurApercu: { ip: () => Promise.resolve("127.0.0.1"), oublier: () => undefined },
    });
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
            "x-elpis": { role: "toolhost", host: "main", families: ["fs"] },
          },
        },
      }),
    );
    writeFileSync(path.join(dossier, "config.json"), "{}");
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    vi.stubEnv("ELPIS_AUDIT_DIR", path.join(dossier, "audit"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
    invalidateConfigCache();
    oublierManifeste();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    uid = await createUser(t.base, "alice", "mdp-alice-apercu", { isAdmin: 0 });
    remplacerBase(t.base);
    const composition = await composerCore("main", t.base, journalCore);
    app = await creerApp({ mode: "main", journal: journalCore, ...composition });
    await app.listen({ port: 0, host: "127.0.0.1" });
    core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const r = await fetch(`${core}/api/login-lite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "mdp-alice-apercu" }),
    });
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }, 60_000);

  afterAll(async () => {
    try {
      app?.server.closeAllConnections();
      await app?.close();
      await h?.fermer();
    } finally {
      await bac?.arreter();
      await new Promise<void>((fin) => (amont ? amont.close(() => fin()) : fin()));
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

  async function jeton(): Promise<string> {
    const r = await fetch(`${core}/api/sandbox/preview-token`, { headers: { cookie } });
    expect(r.status).toBe(200);
    return ((await r.json()) as { token: string }).token;
  }

  it("pv : jeton signé par main, fichier servi par l'hôte TS sans cookie, HTML réécrit ; jeton faux : 403 de main", async () => {
    const tok = await jeton();
    uidsVus.length = 0;
    const d = await fetch(`${core}/api/sandbox/pv/${tok}/data.json`);
    expect([d.status, await d.text(), d.headers.get("access-control-allow-origin")]).toEqual([
      200,
      '{"ok":true}',
      "*",
    ]);
    expect(d.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/u);
    expect(uidsVus).toEqual([uid]);
    const p = await fetch(`${core}/api/sandbox/pv/${tok}/index.html`);
    expect(p.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    );
    expect(await p.text()).toContain(`src="/api/sandbox/pv/${tok}/~r/d/logo.png"`);
    const faux = await fetch(`${core}/api/sandbox/pv/7-1-${"0".repeat(32)}/data.json`);
    expect([faux.status, await faux.json()]).toEqual([403, { detail: "Aperçu expiré : rechargez-le" }]);
  }, 30_000);

  it("pvs et preview : relayés jusqu'au serveur du conteneur, en-têtes réseau retirés ; preview sans session : 401", async () => {
    const tok = await jeton();
    const s = await fetch(`${core}/api/sandbox/pvs/${tok}/${portAmont}/page?x=1`);
    expect([s.status, await s.text(), s.headers.get("set-cookie")]).toEqual([200, "amont /page?x=1", null]);
    expect(s.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms");
    const p = await fetch(`${core}/api/sandbox/preview/${portAmont}/direct`, { headers: { cookie } });
    expect([p.status, await p.text()]).toEqual([200, "amont /direct"]);
    expect((await fetch(`${core}/api/sandbox/preview/${portAmont}/direct`)).status).toBe(401);
  }, 30_000);

  it("capture Playwright et trame du bureau : servies par l'hôte TS au propriétaire ; sans session : 401", async () => {
    const c = await fetch(`${core}/api/playwright/screenshot/shot_sessAAAA1111_1.png`, {
      headers: { cookie },
    });
    expect([c.status, c.headers.get("content-type"), Buffer.from(await c.arrayBuffer())]).toEqual([
      200,
      "image/png",
      PNG,
    ]);
    const f = await fetch(`${core}/api/desktop/frame/trameALIC0001`, { headers: { cookie } });
    expect([f.status, Buffer.from(await f.arrayBuffer())]).toEqual([200, PNG]);
    expect((await fetch(`${core}/api/desktop/frame/trameALIC0001`)).status).toBe(401);
  }, 30_000);
});
