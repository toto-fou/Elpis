// SPDX-License-Identifier: MIT
/** apps/core/test/interop/opencode-pont.test.ts — vrai binaire opencode (ELPIS_OPENCODE_BIN, hors ligne) contre main composé : opencode.json servi par le core, `opencode mcp list` connecté au pont MCP ; jeton refusé : découverte OAuth et enregistrement du client. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierManifeste } from "@elpis/mcp";
import { oublierConfigurationAudit, tokenDigest } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { composer } from "../../src/composition";
import type { Composition } from "../../src/composition";
import { installerCrochetJournal } from "../../src/journal";
import { installerRelaisModeles } from "../../src/llm/cache-modeles";
import { installerDiffusion } from "../../src/llm/ports";
import { oublierServeurEnProcessus, serviceEnProcessus } from "../../src/outils/mcp/en-processus";
import { appTest, journalMuet } from "../aides";

const OPENCODE = process.env["ELPIS_OPENCODE_BIN"] ?? "";
const ALICE = "pcr_" + "a".repeat(40);

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

describe.skipIf(!OPENCODE)("vrai opencode contre le pont MCP du core", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let composition: Composition | undefined;
  let dossier: string;
  let restaurer: () => void;
  let restaurerUrl: (() => void) | undefined;
  let base = "";

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice-opencode");
    await t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [1, "opencode", "opencode", tokenDigest(ALICE), ALICE.slice(-4), "", Date.now() / 1000],
    );
    dossier = mkdtempSync(join(tmpdir(), "elpis-opencode-pont-"));
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ features: { opencode: true } }));
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: { "elpis-chart": { "x-elpis": { role: "app", families: ["chart"] } } },
      }),
    );
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: join(dossier, "config.json"),
      LOCAL_MCP_OPENCODE_FAMILIES: "chart",
      LLAMA_URL: "http://127.0.0.1:1/v1/chat/completions",
    });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    vi.stubEnv("CHART_CACHE_DIR", join(dossier, "cache"));
    vi.stubEnv("ELPIS_AUDIT_DIR", join(dossier, "audit"));
    oublierManifeste();
    composition = await composer("main", t.base, journalMuet, dependancesParDefaut(t.base), dossier);
    app = await appTest({ ...composition, mode: "main" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // Adresse publique du pont (sans hôte d'outils réseau au manifeste, l'URL de l'app n'est pas déduite).
    restaurerUrl = surchargerConfig({ LOCAL_MCP_PUBLIC_URL: `${base}/api/mcp-bridge` });
  });

  afterAll(async () => {
    try {
      await serviceEnProcessus()?.fermer();
      app?.server.closeAllConnections();
      await app?.close();
      composition?.evenements.systemEvents.fermer({ type: "fin" });
    } finally {
      oublierServeurEnProcessus();
      installerCrochetJournal(null);
      installerDiffusion(null);
      installerRelaisModeles(null);
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurerUrl?.();
      restaurer?.();
      oublierConfigurationAudit();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("opencode.json du core (jeton de l'installeur) : `opencode mcp list` connecte elpis-chart au pont ; jeton inconnu : OAuth demandé, découverte et enregistrement du client par opencode", async () => {
    const rep = await fetch(`${base}/api/cli/opencode.json`, { headers: { "x-elpis-token": ALICE } });
    expect(rep.status).toBe(200);
    const config = (await rep.json()) as { mcp?: Record<string, { url?: string }> };
    expect(config.mcp?.["elpis-chart"]?.url).toBe(`${base}/api/mcp-bridge/chart`);
    for (const [cas, jeton, attendu] of [
      ["jeton opencode", ALICE, /elpis-chart\s+connected/u],
      ["jeton inconnu", "pcr_" + "z".repeat(40), /elpis-chart\s+needs authentication/u],
    ] as const) {
      const projet = join(dossier, cas.replace(/\s/gu, "-"));
      const maison = join(projet, "maison");
      mkdirSync(maison, { recursive: true });
      writeFileSync(join(projet, "opencode.json"), JSON.stringify(config).split(ALICE).join(jeton));
      const r = await opencode(projet, maison, "mcp", "list");
      expect(r.sortie, `${cas}\n${r.sortie}`).toMatch(attendu);
      if (jeton !== ALICE) {
        const d = await opencode(projet, maison, "mcp", "debug", "elpis-chart");
        expect(d.sortie, d.sortie).toContain(
          `resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp-bridge/chart"`,
        );
        expect(d.sortie, d.sortie).toMatch(/Client ID available: elpis-[A-Za-z0-9_-]+/u);
      }
    }
  }, 300_000);
});
