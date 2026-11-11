// SPDX-License-Identifier: MIT
/** packages/config/test/reglages-vifs.test.ts — invariant 7 : le lint refuse un réglage rechargé à chaud depuis la console (clé de `config` ou lecteur de config.json) lu au chargement d'un module ; lu à l'usage, il passe. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RACINE = path.resolve(import.meta.dirname, "../../..");
const eslint = new ESLint({ cwd: RACINE });
const CIBLE = "apps/core/src/contexte/elagage.ts";

/** Ce que la règle relève dans `rel` augmenté de `ajout` (« config.X », « liveConfigValue() »…). */
async function figes(ajout: string, rel = CIBLE): Promise<string[]> {
  const fichier = path.join(RACINE, rel);
  const [r] = await eslint.lintText(`${readFileSync(fichier, "utf8")}\n${ajout}\n`, { filePath: fichier });
  return (r?.messages ?? [])
    .filter((m) => m.ruleId === "elpis/reglages-vifs")
    .map((m) => /^invariant 7 : (.+?) est modifiable/u.exec(m.message)?.[1] ?? m.message);
}

describe(
  "invariant 7 : un réglage modifiable depuis la console se lit à chaque usage",
  { timeout: 120_000 },
  () => {
    it("clé rechargée à chaud lue au chargement : refusée (affectation sur une ou plusieurs lignes de vivant.ts)", async () => {
      expect(await figes("export const _a = config.COMPRESSION_ENABLED;")).toEqual([
        "config.COMPRESSION_ENABLED",
      ]);
      expect(await figes('export const _b = String(config["DESKTOP_SCREENSHOT_FORMAT"]);')).toEqual([
        "config.DESKTOP_SCREENSHOT_FORMAT",
      ]);
      expect(
        await figes("export class _C { static s = config.MEMORY_ENABLED; i = config.MEMORY_ENABLED; }"),
      ).toEqual(["config.MEMORY_ENABLED"]);
      expect(await figes("const { PRUNE_ENABLED: _p, ...reste } = config;\nexport { _p, reste };")).toEqual([
        "config.PRUNE_ENABLED",
        "le reste de config",
      ]);
      expect(
        await figes(
          'import { config as reglages } from "@elpis/config";\nexport const _d = reglages.VISION_MODEL;',
        ),
      ).toEqual(["config.VISION_MODEL"]);
    });

    it("lecteur vivant de config.json appelé au chargement : refusé, alias compris", async () => {
      expect(
        await figes(
          'import { liveConfigValue as valeurVive, maxRecentChats } from "@elpis/config";\nexport const _e = [valeurVive("memory.enabled"), maxRecentChats()];',
        ),
      ).toEqual(["liveConfigValue()", "maxRecentChats()"]);
      expect(
        await figes(
          'import { configRag } from "@elpis/config";\nexport const _r = configRag().store_dir;\nexport function _s(): string { return configRag().qdrant_url; }',
        ),
      ).toEqual(["configRag()"]);
    });

    it("clé affectée par la console hors de vivant.ts, fonction appelée sur place, assertion de type, espace de noms, clé en gabarit : refusés", async () => {
      expect(
        await figes(
          [
            "export const _i = (() => config.LLM_SCHEDULING_MODE)();",
            "export const _j = (config as { PRUNE_ENABLED: boolean }).PRUNE_ENABLED;",
            "export const _k = config!.MEMORY_ENABLED;",
            "export const _l = config[`VISION_PASSES`];",
          ].join("\n"),
        ),
      ).toEqual([
        "config.LLM_SCHEDULING_MODE",
        "config.PRUNE_ENABLED",
        "config.MEMORY_ENABLED",
        "config.VISION_PASSES",
      ]);
      expect(
        await figes(
          'import * as reglages from "@elpis/config";\nexport const _m = [reglages.config.COMPRESSION_ENABLED, reglages.liveConfigValue("x")];',
        ),
      ).toEqual(["config.COMPRESSION_ENABLED", "liveConfigValue()"]);
    });

    it("lecteurs vivants de @elpis/bac (configuration des bacs relue à chaque appel) : refusés au chargement", async () => {
      expect(
        await figes(
          'import { chargerConfigBac as profils, loadAdminConfig } from "@elpis/bac";\nexport const _n = [profils(), loadAdminConfig()];\nexport const _o = () => loadAdminConfig();',
        ),
      ).toEqual(["chargerConfigBac()", "loadAdminConfig()"]);
    });

    it("lu à l'usage, réglage lu au démarrage seulement, variable locale homonyme : accepté", async () => {
      expect(
        await figes(
          [
            "export const _f = () => config.COMPRESSION_ENABLED;",
            "export function _g(): unknown { return config.MEMORY_ENABLED; }",
            "export const _h = config.LLAMA_MAX_MODELS;",
            "{ const config = { COMPRESSION_ENABLED: 1 }; void config.COMPRESSION_ENABLED; }",
          ].join("\n"),
        ),
      ).toEqual([]);
    });
  },
);
