// SPDX-License-Identifier: MIT
/** packages/auth/test/securite-ligne-session-ancienne-base.test.ts — une base sans la table des identités externes sert encore la ligne de session (compte local intact). */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ligneSession } from "../src/index";

describe("ligneSession sur une base d'avant la connexion d'entreprise (sqlite)", () => {
  let t: BaseDeTest;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.exec(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at, is_admin) VALUES (7,'alice','s','h',0,0)",
    );
  });

  afterEach(async () => {
    await t.fermer();
  });

  it("rend le compte quand user_identities manque", async () => {
    expect((await ligneSession(t.base, 7))?.["username"]).toBe("alice");
    await t.base.exec("DROP TABLE user_identities");
    const ligne = await ligneSession(t.base, 7);
    expect(ligne?.["username"]).toBe("alice");
    expect(ligne?.["ident_provider_id"]).toBeUndefined();
    expect(await ligneSession(t.base, 8)).toBeUndefined();
  });
});
