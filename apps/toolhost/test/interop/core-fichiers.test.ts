// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/core-fichiers.test.ts — essai réel core TS → hôte TS des routes de fichiers : requêtes de l'éditeur relayées par main (session, enveloppe signée), quota du compte rappelé au core, ancien `.git-credentials.json` importé dans les connecteurs du core (hôte déjà enregistré par un admin). */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, mergeUserSettings } from "@elpis/auth";
import { oublierOccupations } from "@elpis/bac";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { AgentClient, importLegacyCredentials, oublierAnciensVus } from "@elpis/fichiers";
import { oublierManifeste } from "@elpis/mcp";
import { configurerCoffre } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { remplacerBase } from "../../../core/src/base";
import { createConnector, listConnectors } from "../../../core/src/git/connecteurs";
import { BacTest, PYTHON } from "../../../../packages/fichiers/test/aides";
import { arreterFilsCalcul } from "../../src/fichiers/calcul-execution";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";
import { portLibre } from "./aides-python";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-toolhost-fichiers-categories-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

const lignesCore: string[] = [];
const journalCore = new Journal({ niveau: "info", sortie: (l) => lignesCore.push(l) });

describe.skipIf(!PYTHON)("core TS → hôte TS : routes de fichiers", () => {
  let dossier = "";
  let h: HoteTest;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void = () => undefined;
  let bac: BacTest;
  let agent: AgentClient;
  let core = "";
  let cookie = "";
  let uid = 0;

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-core-fichiers-")));
    vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(dossier, "fh"));
    vi.stubEnv("APP_SANDBOX_DIR", path.join(dossier, "sb"));
    vi.stubEnv("ELPIS_AUDIT_DIR", path.join(dossier, "audit"));
    const portHote = await portLibre();
    const hote = `http://127.0.0.1:${portHote}`;
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
    writeFileSync(path.join(dossier, "config.json"), JSON.stringify({ app: { sandbox_quota_mb: 5120 } }));
    vi.stubEnv("APP_MCP_MANIFEST", path.join(dossier, "mcp.json"));
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
      SANDBOX_DIR: path.join(dossier, "sb"),
    });
    invalidateConfigCache();
    oublierManifeste();
    configurerCoffre({
      cleEnv: randomBytes(32).toString("base64"),
      systeme: path.join(dossier, "absente.key"),
      repli: path.join(dossier, ".vault.key"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    uid = await createUser(t.base, "alice", "mdp-alice-fichiers", { isAdmin: 0 });
    remplacerBase(t.base);
    const composition = await composerCore("main", t.base, journalCore);
    app = await creerApp({ mode: "main", journal: journalCore, ...composition });
    await app.listen({ port: 0, host: "127.0.0.1" });
    core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    bac = new BacTest(dossier, "alice");
    await bac.startAgent(false);
    agent = new AgentClient(bac);
    h = await hoteTest(configTest({ port: portHote, app_url: core }), {
      bacFichiers: { racine: async () => bac.sandboxPath, agent: async () => agent },
    });
    await h.app.listen({ port: portHote, host: "127.0.0.1" });
    const r = await fetch(`${core}/api/login-lite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "mdp-alice-fichiers" }),
    });
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }, 90_000);

  afterAll(async () => {
    try {
      app?.server.closeAllConnections();
      await app?.close();
      await h?.fermer();
      await arreterFilsCalcul();
      await bac?.arreter();
    } finally {
      vi.unstubAllEnvs();
      remplacerBase(undefined);
      oublierManifeste();
      restaurer();
      invalidateConfigCache();
      await t?.fermer();
      rmSync(CACHE, { force: true });
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  }, 30_000);

  it("sauvegarde, arbre et téléchargement relayés par main jusqu'au bac du compte", async () => {
    const save = await fetch(`${core}/api/sandbox/save`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "docs/note.md", content: "# Note é" }),
    });
    expect(save.status, lignesCore.slice(-5).join("\n")).toBe(200);
    expect(await save.json()).toMatchObject({ ok: true, size: 9 });
    expect(readFileSync(path.join(bac.sandboxPath, "docs", "note.md"), "utf8")).toBe("# Note é");
    const arbre = await fetch(`${core}/api/sandbox/tree`, { headers: { cookie } });
    expect(await arbre.json()).toMatchObject({
      root: "work",
      items: [{ name: "docs", children: [{ name: "note.md", size: 9 }] }],
    });
    const dl = await fetch(`${core}/api/sandbox/download?path=docs/note.md`, { headers: { cookie } });
    expect([dl.status, await dl.text(), dl.headers.get("x-size")]).toEqual([200, "# Note é", "9"]);
    const anonyme = await fetch(`${core}/api/sandbox/tree`);
    expect(anonyme.status).toBe(401);
  }, 30_000);

  it("quota du compte rappelé au core : la surcharge de l'admin est appliquée par l'hôte", async () => {
    await mergeUserSettings(t.base, uid, (s) => {
      s["sandbox_quota_mb"] = 1;
    });
    h.composition.rappel.viderCache();
    oublierOccupations();
    const trop = await fetch(`${core}/api/sandbox/save`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: "gros.txt", content: "z".repeat(2 * 1024 * 1024) }),
    });
    expect([trop.status, await trop.json()]).toEqual([413, { detail: "Quota sandbox dépassé (1 Mo)" }]);
    const quota = (await (
      await fetch(`${core}/api/sandbox/quota`, { headers: { cookie } })
    ).json()) as Record<string, unknown>;
    expect(quota["quota_mb"]).toBe(1);
  }, 30_000);

  it("ancien .git-credentials.json : gardé pour un hôte sans connecteur enregistré, importé dans les connecteurs du core puis supprimé pour un hôte d'admin", async () => {
    oublierAnciensVus();
    const ancien = path.join(bac.sandboxPath, ".git-credentials.json");
    writeFileSync(
      ancien,
      JSON.stringify({ gitlab: { token: "glpat-ancien", user: "alice", url: "https://git.exemple.lan/x" } }),
    );
    await importLegacyCredentials(agent, uid, "alice");
    expect(await listConnectors(t.base, uid)).toEqual([]);
    expect(existsSync(ancien)).toBe(true);
    const admin = await createUser(t.base, "admin-git", "mdp-admin-git", { isAdmin: 1 });
    await createConnector(
      t.base,
      admin,
      "gitlab",
      "git.exemple.lan",
      { token: "glpat-admin" },
      { userId: admin, username: "admin-git" },
    );
    oublierAnciensVus();
    await importLegacyCredentials(agent, uid, "alice");
    const connecteurs = await listConnectors(t.base, uid);
    expect(connecteurs.map((c) => [c["host"], c["label"]])).toEqual([["git.exemple.lan", "imported"]]);
    expect(existsSync(ancien)).toBe(false);
  }, 30_000);
});
