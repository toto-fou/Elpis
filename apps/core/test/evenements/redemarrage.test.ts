// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/redemarrage.test.ts — redémarrage nécessaire (empreinte de main) et cron des routines. */
import { describe, expect, it } from "vitest";

import { cronMatches } from "../../src/evenements/cron";
import { EmpreinteDemarrage, restartPaths } from "../../src/evenements/redemarrage";
import type { SourceRedemarrage } from "../../src/evenements/redemarrage";

const PREFIXES_CHAUDS = [
  "vision.",
  "desktop.",
  "llm.compression.",
  "llm.compaction.",
  "llm.prune.",
  "memory.",
  "mcp.tokens.",
  "mcp.oauth.",
];
const CHEMINS_CHAUDS = [
  "llm.scheduling_mode",
  "app.max_recent_chats",
  "maintenance.daily_digest_enabled",
  "browser.url_allowlist",
  "mcp.allowed_origins",
];

function source(boot: Record<string, unknown>, courant: () => Record<string, unknown>): SourceRedemarrage {
  return {
    lectures: [
      "llama.ip",
      "llama.port",
      "maintenance.hour",
      "maintenance.daily_digest_enabled",
      "vision.endpoint_url",
    ],
    prefixesChauds: PREFIXES_CHAUDS,
    cheminsChauds: CHEMINS_CHAUDS,
    brutDemarrage: () => boot,
    vueCourante: courant,
  };
}

describe("restart_pending (test_restart_pending)", () => {
  it("inventaire : lectures de démarrage, sans ce qui est relu à chaud, plus le cookie de session", () => {
    const chemins = restartPaths(
      ["llama.ip", "llama.port", "llama.max_models", "maintenance.hour", "vision.x", "llm.scheduling_mode"],
      PREFIXES_CHAUDS,
      CHEMINS_CHAUDS,
    );
    expect(chemins).toEqual([
      "llama.ip",
      "llama.max_models",
      "llama.port",
      "maintenance.hour",
      "security.session.cookie_name",
      "security.session.same_site",
    ]);
  });

  it("empreinte sans valeur, seul un chemin « au démarrage » modifié est annoncé", () => {
    const boot = {
      llama: { ip: "10.0.0.5", port: "8080" },
      maintenance: { hour: 6, daily_digest_enabled: true },
      vision: { endpoint_url: "" },
      app: { session_secret: "SECRET-A-NE-PAS-ECRIRE" },
    };
    let courant: Record<string, unknown> = structuredClone(boot);
    const empreinte = new EmpreinteDemarrage(
      source(boot, () => courant),
      "abc",
    );
    empreinte.enregistrer();
    const statut = empreinte.statut();
    expect(JSON.stringify(statut)).not.toContain("10.0.0.5");
    expect(JSON.stringify(statut)).not.toContain("SECRET");
    expect(statut).toMatchObject({ generation: "abc", mode: "main", pid: process.pid, pending: [] });
    courant = {
      ...structuredClone(boot),
      llama: { ip: "10.0.0.9", port: "8080" },
      maintenance: { hour: 6, daily_digest_enabled: false },
      vision: { endpoint_url: "http://x:1" },
    };
    expect(empreinte.statut().pending).toEqual(["llama.ip"]);
    expect(empreinte.pending({ ...courant, maintenance: { hour: 6, metrics_retention_days: 30 } })).toEqual([
      "llama.ip",
    ]);
  });

  it("l'empreinte est prise une fois : une relecture ultérieure du boot ne la change pas", () => {
    const boot: Record<string, unknown> = { llama: { ip: "a" } };
    const empreinte = new EmpreinteDemarrage(source(boot, () => ({ llama: { ip: "a" } })));
    empreinte.enregistrer();
    boot["llama"] = { ip: "b" };
    empreinte.enregistrer();
    expect(empreinte.pending()).toEqual([]);
    expect(empreinte.generation).toMatch(/^[0-9a-f]{12}$/u);
  });
});

describe("cron des routines (test_routines_cron)", () => {
  it("chaque minute, heure exacte, pas, plage, liste ; expression vide jamais", () => {
    const d = (h: number, m: number): Date => new Date(2026, 5, 4, h, m);
    expect(cronMatches("* * * * *", d(10, 0))).toBe(true);
    expect(cronMatches("0 9 * * *", d(9, 0))).toBe(true);
    expect(cronMatches("0 9 * * *", d(10, 0))).toBe(false);
    expect([0, 30, 15].map((m) => cronMatches("*/30 * * * *", d(10, m)))).toEqual([true, true, false]);
    expect(cronMatches("0-5 * * * *", d(10, 3))).toBe(true);
    expect(cronMatches("0-5 * * * *", d(10, 6))).toBe(false);
    expect(cronMatches("0 9,18 * * *", d(18, 0))).toBe(true);
    expect(cronMatches("0 9,18 * * *", d(12, 0))).toBe(false);
    expect(cronMatches("", new Date())).toBe(false);
    expect(cronMatches("* * * * 4", d(10, 0))).toBe(true);
    expect(cronMatches("* * * * 7", new Date(2026, 5, 7, 10, 0))).toBe(true);
  });
});
