// SPDX-License-Identifier: MIT
/** packages/config/test/instance.test.ts — objet `config` du process : calcul à l'import, rechargement, surcharge, env propagée. */
import { DOSSIER_TEST } from "./environnement";

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  bootRaw,
  config,
  configView,
  deepGet,
  HOT_RELOAD_PATHS,
  HOT_RELOAD_PREFIXES,
  propagerEnv,
  racineDepot,
  rechargerConfig,
  surchargerConfig,
} from "../src/index";
import type { Reglages } from "../src/index";

const RACINE = realpathSync(path.resolve(import.meta.dirname, "..", "..", ".."));

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

describe("objet config du process", () => {
  it("calculé à l'import depuis process.env et config.json (absent : défauts)", () => {
    expect(config.PROJECT_ROOT).toBe(RACINE);
    expect(config.CONFIG_JSON_PATH).toBe(path.join(DOSSIER_TEST, "config.json"));
    expect(config.DB_PATH).toBe(path.join(DOSSIER_TEST, "db", "app.db"));
    expect(config.LLAMA_URL).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(config.SESSION_SECRET).toMatch(/^ELPIS_[0-9a-f]{64}$/);
    expect(statSync(path.join(DOSSIER_TEST, "db", ".session_secret")).mode & 0o777).toBe(0o600);
    expect(config.BUILD_ID).toMatch(/^\d+-[0-9a-f]{6}$/);
    expect(existsSync(config.MCP_SERVERS_DIR)).toBe(true);
  });

  it("racine du dépôt déduite du paquet, ELPIS_RACINE prioritaire", () => {
    expect(racineDepot()).toBe(RACINE);
    expect(existsSync(path.join(racineDepot(), "packages", "config", "context_config.json"))).toBe(true);
    const ailleurs = realpathSync(mkdtempSync(path.join(DOSSIER_TEST, "racine-")));
    process.env["ELPIS_RACINE"] = ailleurs;
    try {
      expect(racineDepot()).toBe(ailleurs);
    } finally {
      delete process.env["ELPIS_RACINE"];
    }
  });

  it("rechargerConfig relit config.json dans le même objet ; bootRaw suit, gelé", () => {
    const meme = config;
    const secret = config.SESSION_SECRET;
    writeFileSync(
      config.CONFIG_JSON_PATH,
      JSON.stringify({ llama: { ip: "10.1.1.1" }, vision: { passes: 3 } }),
    );
    try {
      expect(deepGet(bootRaw(), "llama.ip", null)).toBeNull();
      rechargerConfig();
      expect(config).toBe(meme);
      expect(config.LLAMA_IP).toBe("10.1.1.1");
      expect(config.VISION_PASSES).toBe(3);
      expect(config.SESSION_SECRET).toBe(secret);
      expect(deepGet(bootRaw(), "llama.ip", null)).toBe("10.1.1.1");
      expect(Object.isFrozen(bootRaw())).toBe(true);
      expect(configView()).toEqual({ llama: { ip: "10.1.1.1" }, vision: { passes: 3 } });
    } finally {
      rmSync(config.CONFIG_JSON_PATH, { force: true });
      rechargerConfig();
    }
    expect(config.LLAMA_IP).toBe("127.0.0.1");
  });

  it("une lecture de bootRaw() après l'import n'entre pas dans BOOT_READ_PATHS", () => {
    deepGet(bootRaw(), "zz.lecture_tardive", null);
    expect(config.BOOT_READ_PATHS.has("zz.lecture_tardive")).toBe(false);
    expect(config.BOOT_READ_PATHS.has("llama.ip")).toBe(true);
    expect(config.BOOT_READ_PATHS.has("mcp.local_transport")).toBe(false);
  });

  it("surchargerConfig rend une fonction qui remet les valeurs précédentes", () => {
    const avant = config.LLAMA_MODEL;
    const remettre = surchargerConfig({ LLAMA_MODEL: "autre", VISION_PASSES: 9 } satisfies Partial<Reglages>);
    expect([config.LLAMA_MODEL, config.VISION_PASSES]).toEqual(["autre", 9]);
    remettre();
    expect(config.LLAMA_MODEL).toBe(avant);
    expect(config.VISION_PASSES).toBe(2);
  });

  it("propagerEnv fait comme os.environ.setdefault (une valeur vide est gardée)", () => {
    const env: Record<string, string | undefined> = { APP_SANDBOX_DIR: "" };
    propagerEnv(env, config);
    expect(env).toEqual({
      APP_SANDBOX_DIR: "",
      APP_SKILLS_DIR: config.SKILLS_DIR,
      APP_USER_SKILLS_DIR: config.USER_SKILLS_DIR,
    });
  });

  it("préfixes et chemins relus à chaud, comme config.py", () => {
    expect(HOT_RELOAD_PREFIXES).toEqual([
      "vision.",
      "desktop.",
      "llm.compression.",
      "llm.compaction.",
      "llm.prune.",
      "memory.",
      "mcp.tokens.",
      "mcp.oauth.",
    ]);
    expect(HOT_RELOAD_PATHS.has("app.max_recent_chats")).toBe(true);
    expect(config.HOT_RELOAD_PATHS).toBe(HOT_RELOAD_PATHS);
  });
});
