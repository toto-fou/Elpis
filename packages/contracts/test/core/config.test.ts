// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/config.test.ts — contrats de la configuration du compte et de la configuration publique, rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseConfigCompte } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : configuration (core réel)", () => {
  it("configuration du compte : lecture, écriture, refus hors session ou mal formé", async () => {
    const lue = schemaReponseConfigCompte.parse(await core.appeler("GET", "/api/config", { cookie }));
    expect(lue.username).toBe("zoe");
    expect(
      await core.appeler("PUT", "/api/config", {
        cookie,
        corps: { config: { app: { max_recent_chats: 7 } } },
      }),
    ).toMatchObject({ ok: true });
    expect(
      schemaReponseConfigCompte.parse(await core.appeler("GET", "/api/config", { cookie })).config,
    ).toEqual({
      app: { max_recent_chats: 7 },
    });
    await core.appeler("PUT", "/api/config", { cookie, corps: { config: [] } });
    await core.appeler("GET", "/api/config");
    await core.appeler("PUT", "/api/config", { corps: { config: {} } });
  });

  it("configuration publique, lisible sans session", async () => {
    expect(await core.appeler("GET", "/api/public-config")).toMatchObject({
      app_mode: "main",
      features: { opencode: true },
    });
  });

  it("toutes les routes du domaine config ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "config").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
