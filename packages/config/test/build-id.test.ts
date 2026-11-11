// SPDX-License-Identifier: MIT
/** packages/config/test/build-id.test.ts — BUILD_ID : APP_BUILD_ID retenu seulement sous une forme sûre, sinon identifiant neuf. */
import { DOSSIER_TEST } from "./environnement";

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildIdDepuis, buildIdValide, calculerReglages } from "../src/index";

const RACINE = realpathSync(path.resolve(import.meta.dirname, "..", "..", ".."));
const NEUF = /^\d+-[0-9a-f]{6}$/;

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

describe("BUILD_ID", () => {
  it("forme sûre : 1 à 64 caractères parmi lettres et chiffres ASCII, point, tiret, souligné", () => {
    for (const v of ["tests", "BUILD-42", "1714123456-a3f9d2", "v1.2_3", "x".repeat(64)])
      expect(buildIdValide(v), v).toBe(true);
    for (const v of [
      "",
      "x".repeat(65),
      'a"b',
      "a'b",
      "a<b",
      "a b",
      "a\nb",
      "a\\b",
      "a$b",
      "a/b",
      "a&b",
      "été",
      "٣",
      "１",
    ])
      expect(buildIdValide(v), JSON.stringify(v)).toBe(false);
    expect(buildIdValide(42)).toBe(false);
  });

  it("valeur sûre reprise telle quelle ; sinon identifiant neuf « secondes-6 hex »", () => {
    expect(buildIdDepuis("build-fixe")).toBe("build-fixe");
    expect(buildIdDepuis('"><script>x</script>')).toMatch(NEUF);
    expect(buildIdDepuis(undefined)).toMatch(NEUF);
  });

  it("APP_BUILD_ID hors forme sûre ignoré par les réglages (écart voulu au Python de référence)", () => {
    const base = realpathSync(mkdtempSync(path.join(DOSSIER_TEST, "build-")));
    const env = { APP_DB_PATH: path.join(base, "app.db"), MCP_SERVERS_DIR: path.join(base, "mcp") };
    const avec = (v: string) =>
      calculerReglages({ ...env, APP_BUILD_ID: v }, {}, RACINE, path.join(base, "config.json")).reglages
        .BUILD_ID;
    expect(avec("build-fixe")).toBe("build-fixe");
    expect(avec('1"onload="x')).toMatch(NEUF);
    expect(avec("a".repeat(200))).toMatch(NEUF);
  });
});
