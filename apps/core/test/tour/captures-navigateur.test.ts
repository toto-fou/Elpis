// SPDX-License-Identifier: MIT
/** apps/core/test/tour/captures-navigateur.test.ts — captures d'étape du navigateur : éteintes pour tout compte qui ne les a pas allumées, l'ancienne clé `hide_web_screenshots` sans effet. */
import "../moteur-environnement";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ecrireReglages } from "../../src/comptes/reglages";
import { invalidateCache } from "../../src/llm/acces-moteurs";
import { prepareTurn } from "../../src/tour/preparation";
import type { DependancesTour } from "../../src/tour/preparation";
import { journalMuet } from "../aides";

describe("prepareTurn : captures d'étape du navigateur", () => {
  let t: BaseDeTest;
  const ALICE = 2;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.run(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, ?, 's', 'h', 0, 0)",
      [ALICE, "alice"],
    );
    invalidateCache(t.base);
  });

  afterEach(async () => {
    invalidateCache(t.base);
    await t.fermer();
  });

  const preparer = async (): Promise<boolean> =>
    (
      await prepareTurn(
        { base: t.base } as unknown as DependancesTour,
        { messages: [{ role: "user", content: "bonjour" }] },
        ALICE,
        "c".repeat(24),
      )
    )[0].webCapturesOn;

  it("éteintes par défaut, y compris pour un compte qui affichait les captures ; allumées par le réglage", async () => {
    expect(await preparer()).toBe(false);
    await t.base.run("UPDATE users SET settings_json=? WHERE id=?", [
      JSON.stringify({ hide_web_screenshots: false }),
      ALICE,
    ]);
    expect(await preparer()).toBe(false);
    await ecrireReglages(t.base, ALICE, { web_step_screenshots: true }, "main", journalMuet);
    expect(await preparer()).toBe(true);
    await ecrireReglages(t.base, ALICE, { web_step_screenshots: false }, "main", journalMuet);
    expect(await preparer()).toBe(false);
  });
});
