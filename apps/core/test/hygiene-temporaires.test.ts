// SPDX-License-Identifier: MIT
/** apps/core/test/hygiene-temporaires.test.ts — les temporaires d'environnement des tests vivent sous le dossier du run et disparaissent avec lui. */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import miseEnPlace from "../../../vitest.mise-en-place.mjs";
import { DOSSIER_MOTEUR } from "./moteur-environnement";

const AVANT = { mcp: process.env["MCP_SERVERS_DIR"], tmp: process.env["VITEST_ELPIS_TMP"] };

afterEach(() => {
  for (const [nom, valeur] of [
    ["MCP_SERVERS_DIR", AVANT.mcp],
    ["VITEST_ELPIS_TMP", AVANT.tmp],
  ] as const) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
});

describe("temporaires d'environnement des tests", () => {
  it("le dossier du moteur de ce fichier est sous le dossier du run", () => {
    expect(AVANT.tmp).toBeTruthy();
    expect(DOSSIER_MOTEUR.startsWith(realpathSync(AVANT.tmp ?? "") + path.sep)).toBe(true);
    expect(existsSync(DOSSIER_MOTEUR)).toBe(true);
  });

  it("la fin du run supprime ce qu'un fichier arrêté avant son nettoyage a laissé", () => {
    const fin = miseEnPlace();
    const run = process.env["VITEST_ELPIS_TMP"] ?? "";
    const mcp = process.env["MCP_SERVERS_DIR"] ?? "";
    const laisse = path.join(run, "elpis-moteur-test-oublie", "user_db");
    mkdirSync(laisse, { recursive: true });
    expect([existsSync(run), existsSync(mcp), existsSync(laisse)]).toEqual([true, true, true]);
    fin();
    expect([existsSync(run), existsSync(mcp), existsSync(laisse)]).toEqual([false, false, false]);
  });
});
