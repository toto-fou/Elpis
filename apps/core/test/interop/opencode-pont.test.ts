// SPDX-License-Identifier: MIT
/** apps/core/test/interop/opencode-pont.test.ts — vrai binaire opencode (ELPIS_OPENCODE_BIN, hors ligne) contre main composé : bloc opencode d'un jeton d'outils (Jetons MCP) connecté au pont MCP ; jeton refusé : découverte OAuth et enregistrement du client. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, creerJeton, dependancesParDefaut } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { composer } from "../../src/composition";
import type { Composition } from "../../src/composition";
import { installerCrochetJournal } from "../../src/journal";
import { arreterSondeModeles, installerRelaisModeles } from "../../src/llm/cache-modeles";
import { installerDiffusion } from "../../src/llm/ports";
import { oublierServeurEnProcessus, serviceEnProcessus } from "../../src/outils/mcp/en-processus";
import { appTest, journalMuet } from "../aides";

const OPENCODE = process.env["ELPIS_OPENCODE_BIN"] ?? "";
const MDP = "mdp-alice-opencode";
const SERVICE = "jeton-service-interop";

/** `opencode <args>` dans `projet`, maison et caches jetables (rien du poste) ; sortie sans codes de couleur. */
function opencode(
  projet: string,
  maison: string,
  ...args: string[]
): Promise<{ code: number | null; sortie: string }> {
  return new Promise((fini) => {
    const p = spawn(OPENCODE, args, {
      cwd: projet,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: maison,
        XDG_CONFIG_HOME: join(maison, ".config"),
        XDG_DATA_HOME: join(maison, ".local", "share"),
        XDG_CACHE_HOME: join(maison, ".cache"),
        XDG_STATE_HOME: join(maison, ".local", "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        NO_COLOR: "1",
      },
    });
    let sortie = "";
    p.stdout.on("data", (m: Buffer) => (sortie += m.toString()));
    p.stderr.on("data", (m: Buffer) => (sortie += m.toString()));
    const delai = setTimeout(() => p.kill("SIGKILL"), 90_000);
    p.on("error", (e) => {
      clearTimeout(delai);
      fini({ code: null, sortie: `${OPENCODE} injoignable : ${e.message}` });
    });
    p.on("close", (code) => {
      clearTimeout(delai);
      fini({
        code,
        sortie: sortie
          .split(String.fromCharCode(27))
          .map((m, n) => (n === 0 ? m : m.replace(/^\[[0-9;?]*[A-Za-z]/u, "")))
          .join(""),
      });
    });
  });
}

/** Hôte d'outils factice : `/mcp/git` répond au protocole MCP (initialize, tools/list), le reste en 404 ou 405. */
function hoteFactice(): Server {
  return createServer((req, res) => {
    let corps = "";
    req.on("data", (m: Buffer) => (corps += m.toString()));
    req.on("end", () => {
      if (req.url !== "/mcp/git") return void res.writeHead(404).end();
      if (req.method === "DELETE") return void res.writeHead(200).end();
      if (req.method !== "POST") return void res.writeHead(405, { allow: "POST, DELETE" }).end();
      const m = JSON.parse(corps || "{}") as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (m.id === undefined) return void res.writeHead(202).end();
      const resultat =
        m.method === "initialize"
          ? {
              protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "hote-factice", version: "1.0.0" },
            }
          : m.method === "tools/list"
            ? {
                tools: [
                  { name: "git_status", description: "État du dépôt", inputSchema: { type: "object" } },
                ],
              }
            : {};
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-interop" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: resultat }));
    });
  });
}

describe.skipIf(!OPENCODE)("vrai opencode contre le core : pont MCP", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let hote: Server;
  let composition: Composition | undefined;
  let dossier: string;
  let restaurer: () => void;
  let base = "";
  let jeton = "";

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", MDP);
    [jeton] = await creerJeton(dependancesParDefaut(t.base), 1, "tools", "opencode", ["git"], 30);
    hote = hoteFactice();
    await new Promise<void>((fin) => hote.listen(0, "127.0.0.1", fin));
    const portHote = (hote.address() as AddressInfo).port;
    dossier = mkdtempSync(join(tmpdir(), "elpis-opencode-pont-"));
    writeFileSync(join(dossier, "config.json"), "{}");
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        toolHosts: { main: { url: `http://127.0.0.1:${portHote}`, token: SERVICE } },
        mcpServers: {
          "elpis-git": {
            type: "http",
            url: `http://127.0.0.1:${portHote}/mcp/git`,
            headers: { Authorization: `Bearer ${SERVICE}` },
            "x-elpis": { role: "toolhost", families: ["git"], host: "main" },
          },
        },
      }),
    );
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: join(dossier, "config.json"),
      LLAMA_URL: "http://127.0.0.1:1/v1/chat/completions",
    });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    vi.stubEnv("ELPIS_AUDIT_DIR", join(dossier, "audit"));
    oublierManifeste();
    composition = await composer("main", t.base, journalMuet, dependancesParDefaut(t.base), dossier);
    app = await appTest({ ...composition, mode: "main" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    try {
      arreterSondeModeles();
      await serviceEnProcessus()?.fermer();
      app?.server.closeAllConnections();
      await app?.close();
      await new Promise<void>((fin) => (hote ? hote.close(() => fin()) : fin()));
      composition?.evenements.systemEvents.fermer({ type: "fin" });
    } finally {
      oublierServeurEnProcessus();
      installerCrochetJournal(null);
      installerDiffusion(null);
      installerRelaisModeles(null);
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      oublierConfigurationAudit();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("bloc opencode d'un jeton d'outils (Jetons MCP) : `opencode mcp list` connecte elpis-git au pont ; jeton inconnu : OAuth demandé, découverte et enregistrement du client par opencode", async () => {
    const bloc = (j: string) => ({
      mcp: {
        "elpis-git": {
          type: "remote",
          url: `${base}/api/mcp-bridge/git`,
          enabled: true,
          headers: { Authorization: `Bearer ${j}` },
        },
      },
    });
    for (const [cas, j, attendu] of [
      ["jeton d'outils", jeton, /elpis-git\s+connected/u],
      ["jeton inconnu", "ept_" + "z".repeat(40), /elpis-git\s+needs authentication/u],
    ] as const) {
      const projet = join(dossier, cas.replace(/[\s']/gu, "-"));
      const maison = join(projet, "maison");
      mkdirSync(maison, { recursive: true });
      writeFileSync(join(projet, "opencode.json"), JSON.stringify(bloc(j)));
      const r = await opencode(projet, maison, "mcp", "list");
      expect(r.sortie, `${cas}\n${r.sortie}`).toMatch(attendu);
      if (j !== jeton) {
        const d = await opencode(projet, maison, "mcp", "debug", "elpis-git");
        expect(d.sortie, d.sortie).toContain(
          `resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp-bridge/git"`,
        );
        expect(d.sortie, d.sortie).toMatch(/Client ID available: elpis-[A-Za-z0-9_-]+/u);
      }
    }
  }, 300_000);
});
