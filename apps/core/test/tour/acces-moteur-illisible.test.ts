// SPDX-License-Identifier: MIT
/** apps/core/test/tour/acces-moteur-illisible.test.ts — préparation d'un tour de chat quand les politiques d'accès aux moteurs sont illisibles : 503 `access_check_failed`, jamais un accès ouvert ; politique lisible qui refuse : 409 `forbidden`. */
import "../moteur-environnement";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidateCache, setPolicy } from "../../src/llm/acces-moteurs";
import { prepareTurn } from "../../src/tour/preparation";
import type { DependancesTour } from "../../src/tour/preparation";

let t: BaseDeTest;
const ALICE = 2;
const DONNEES = { messages: [{ role: "user", content: "Bonjour" }] };

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

/** Erreur HTTP levée par la préparation du tour (aucune autre dépendance n'est atteinte avant le contrôle d'accès). */
async function refus(): Promise<{ statusCode: number; detail: unknown }> {
  try {
    await prepareTurn({ base: t.base } as unknown as DependancesTour, DONNEES, ALICE, "c".repeat(24));
  } catch (e) {
    return e as { statusCode: number; detail: unknown };
  }
  throw new Error("tour préparé malgré le contrôle d'accès");
}

describe("contrôle d'accès au moteur fermé en cas d'erreur", () => {
  it("politiques illisibles : 503 engine_unavailable / access_check_failed", async () => {
    await t.base.exec("DROP TABLE user_groups");
    expect(await refus()).toMatchObject({
      statusCode: 503,
      detail: {
        code: "engine_unavailable",
        reason: "access_check_failed",
        message: "Contrôle d'accès au serveur indisponible, réessayez.",
      },
    });
  });

  it("politique lisible qui ferme le serveur intégré : 409 forbidden", async () => {
    await setPolicy(t.base, "user", ALICE, { engine_keys: [], can_manage_models: false });
    invalidateCache(t.base);
    expect(await refus()).toMatchObject({
      statusCode: 409,
      detail: { code: "engine_unavailable", reason: "forbidden" },
    });
  });
});
