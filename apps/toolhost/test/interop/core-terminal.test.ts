// SPDX-License-Identifier: MIT
/** apps/toolhost/test/interop/core-terminal.test.ts — essai réel core TS → hôte TS du terminal : sessions nommées, WebSocket et flux SSE relayés par main jusqu'au PTY de l'hôte (faux docker), plafond de quota lu dans les réglages du compte. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, mergeUserSettings } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { composer as composerCore, creerApp, Journal } from "@elpis/core";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { remplacerBase } from "../../../core/src/base";
import { installerUsageTerminal } from "../../src/terminal/quota";
import { reglagesWs } from "../../src/terminal/ws";
import { configTest, hoteTest, SVC } from "../aides";
import type { HoteTest } from "../aides";
import { attendre, creerFauxDockerTerminal } from "../terminal-aides";

const CACHE = vi.hoisted(() => {
  const chemin = `${process.env["TMPDIR"] ?? "/tmp"}/elpis-toolhost-categories-terminal-${process.pid}.json`;
  process.env["TOOL_CATEGORIES_CACHE_PATH"] = chemin;
  return chemin;
});

const journalCore = new Journal({ niveau: "info", sortie: () => undefined });

describe("core TS → hôte TS : terminal", () => {
  let dossier: string;
  let h: HoteTest;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void = () => undefined;
  let core = "";
  let cookie = "";
  let uid = 0;
  const reglages = { ...reglagesWs };

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-core-terminal-")));
    const docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    vi.stubEnv("APP_FILE_HISTORY_DIR", path.join(dossier, "fh"));
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    h = await hoteTest(configTest(), { base: t.base });
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
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
      SANDBOX_DIR: path.join(dossier, "sb"),
    });
    invalidateConfigCache();
    oublierManifeste();
    uid = await createUser(t.base, "alice", "mdp-alice-terminal", { isAdmin: 0 });
    await mergeUserSettings(t.base, uid, (r) => {
      r["sandbox_quota_mb"] = 1;
    });
    remplacerBase(t.base);
    const composition = await composerCore("main", t.base, journalCore);
    app = await creerApp({ mode: "main", journal: journalCore, ...composition });
    await app.listen({ port: 0, host: "127.0.0.1" });
    core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const r = await fetch(`${core}/api/login-lite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "mdp-alice-terminal" }),
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
      Object.assign(reglagesWs, reglages);
      installerUsageTerminal(null);
      app?.server.closeAllConnections();
      await app?.close();
      await h?.fermer();
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

  function ws(
    chemin: string,
  ): Promise<{ ws: WebSocket; textes: unknown[]; sortie: () => string; fin: Promise<number> }> {
    const s = new WebSocket(`${core.replace("http", "ws")}${chemin}`, { headers: { cookie } });
    const textes: unknown[] = [];
    const morceaux: Buffer[] = [];
    s.on("message", (d: Buffer, binaire: boolean) => {
      if (binaire) morceaux.push(d);
      else textes.push(JSON.parse(d.toString()) as unknown);
    });
    const fin = new Promise<number>((ok) => s.on("close", (c: number) => ok(c)));
    return new Promise((ok, ko) => {
      s.once("open", () => ok({ ws: s, textes, sortie: () => Buffer.concat(morceaux).toString(), fin }));
      s.once("unexpected-response", (_q, r) => ko(new Error(`HTTP ${r.statusCode ?? 0}`)));
    });
  }

  it("sessions nommées et WebSocket relayées : accueil, écho, taille, ping ; session supprimée → shell tué", async () => {
    const cree = await fetch(`${core}/api/terminal/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: " relais " }),
    });
    const session = ((await cree.json()) as { session: { id: string; name: string; uid: number } }).session;
    expect([cree.status, session.name, session.uid]).toEqual([200, "relais", uid]);
    const c = await ws(`/ws/terminal/${session.id}`);
    await attendre(() => c.textes.length > 0);
    expect(c.textes[0]).toEqual({ type: "hello", fresh_shell: true });
    c.ws.send(JSON.stringify({ op: "resize", rows: 21, cols: 77 }));
    c.ws.send(Buffer.from("echo re$((2*2))lais; stty size\r"));
    await attendre(() => c.sortie().includes("re4lais") && c.sortie().includes("21 77"));
    c.ws.send(JSON.stringify({ op: "ping" }));
    await attendre(() => c.textes.length > 1);
    expect(c.textes[1]).toEqual({ type: "pong" });
    expect(h.composition.terminaux.duCompte(uid).map((x) => x.sid)).toEqual([session.id]);
    const sup = await fetch(`${core}/api/terminal/sessions/${session.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect([sup.status, await sup.json()]).toEqual([200, { ok: true }]);
    expect(await c.fin).toBe(1000);
    expect(c.textes.at(-1)).toEqual({ type: "exit" });
    const inconnue = await ws(`/ws/terminal/${session.id}`);
    expect(await inconnue.fin).toBe(4004);
    const anonyme = await fetch(`${core}/api/terminal/sessions`);
    expect(anonyme.status).toBe(401);
  }, 30_000);

  it("flux SSE relayé : sortie en base64, frappe par POST, [EOF] relayé après /api/terminal/kill", async () => {
    const r = await fetch(`${core}/api/terminal/stream`, { headers: { cookie } });
    expect([r.status, r.headers.get("content-type")]).toEqual([200, "text/event-stream; charset=utf-8"]);
    let texte = "";
    const lecture = (async () => {
      const d = new TextDecoder();
      for await (const m of r.body ?? []) texte += d.decode(m as Uint8Array, { stream: true });
    })();
    const sortie = () =>
      texte
        .split("\n\n")
        .filter((l) => l.startsWith("data: ") && !l.startsWith("data: ["))
        .map((l) => Buffer.from(l.slice(6), "base64").toString())
        .join("");
    const frappe = await fetch(`${core}/api/terminal/input`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ data: "echo f$((3+4))lux\r" }),
    });
    expect(await frappe.json()).toEqual({ ok: true });
    await attendre(() => sortie().includes("f7lux"));
    const kill = await fetch(`${core}/api/terminal/kill`, { method: "POST", headers: { cookie } });
    expect(await kill.json()).toEqual({ ok: true });
    await lecture;
    expect(texte.endsWith("data: [EOF]\n\n")).toBe(true);
  }, 30_000);

  it("quota : plafond lu dans les réglages du compte (base partagée), avertissement relayé", async () => {
    Object.assign(reglagesWs, { ticMs: 20, intervalleQuotaS: 0 });
    const plafonds: number[] = [];
    installerUsageTerminal(async (_u, _r, quota) => {
      plafonds.push(quota);
      return Math.floor(quota * 0.95);
    });
    const c = await ws("/ws/terminal");
    await attendre(() => plafonds.length > 0);
    expect(plafonds[0]).toBe(1024 * 1024);
    await attendre(
      () => c.sortie().includes("Quota sandbox à 94 %") || c.sortie().includes("Quota sandbox à 95 %"),
    );
    c.ws.close();
    await c.fin;
  }, 30_000);
});
