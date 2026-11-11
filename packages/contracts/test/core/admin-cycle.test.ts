// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-cycle.test.ts — contrats du cycle de vie de la console (redémarrage de main, invalidation des caches) rejoués contre le core TS réel en process admin. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseRedemarrage } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : cycle de vie de la console (core réel)", () => {
  it("redémarrage : main injoignable en test, refus à un compte ordinaire ; le succès est vérifié sur un exemple", async () => {
    const r = schemaReponseRedemarrage.parse(await core.appeler("POST", "/api/admin/restart", { cookie }));
    expect(r.ok).toBe(false);
    await core.appeler("POST", "/api/admin/restart", { cookie: cookieLou });
    const reussi = {
      ok: true,
      target: "main",
      main_url: "http://127.0.0.1:8001",
      active_generations: 0,
      drain_max_s: 30,
    };
    expect(schemaReponseRedemarrage.parse(reussi)).toEqual(reussi);
  });

  it("invalidation des caches de modèles", async () => {
    expect(await core.appeler("POST", "/api/admin/cache/invalidate", { cookie })).toMatchObject({ ok: true });
    await core.appeler("POST", "/api/admin/cache/invalidate", { cookie: cookieLou });
  });

  it("toutes les routes du domaine admin-cycle ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-cycle").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
