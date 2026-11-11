// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-base.test.ts — contrats de la console pour la base de données rejoués contre le core TS réel en process admin (SQLite ; la bascule effective n'est pas lancée). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseEnregistrementBase } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

const CIBLE = { backend: "postgres", host: "127.0.0.1", port: 1, name: "elpis", user: "elpis", tls: "off" };

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

describe("contrats REST : base de données de la console (core réel)", () => {
  it("état, tâche, essai et simulation vers un PostgreSQL injoignable, refus", async () => {
    expect(await core.appeler("GET", "/api/admin/database", { cookie })).toMatchObject({
      active: { backend: "sqlite" },
      saved: { pending: false },
      job: { state: "idle" },
    });
    await core.appeler("GET", "/api/admin/database", { cookie: cookieLou });
    expect(await core.appeler("GET", "/api/admin/database/job", { cookie })).toEqual({ state: "idle" });
    expect(await core.appeler("POST", "/api/admin/database/test", { cookie, corps: CIBLE })).toMatchObject({
      ok: false,
    });
    await core.appeler("POST", "/api/admin/database/simulate", { cookie, corps: CIBLE });
    await core.appeler("POST", "/api/admin/database/test", { cookie, corps: { ...CIBLE, backend: "mysql" } });
    await core.appeler("POST", "/api/admin/database/test", { cookie, corps: { ...CIBLE, tls: "x" } });
    await core.appeler("POST", "/api/admin/database/test", { cookie, corps: { backend: "postgres" } });
  });

  it("enregistrement de la cible, bascules refusées ou invalides", async () => {
    const enregistre = schemaReponseEnregistrementBase.parse(
      await core.appeler("POST", "/api/admin/database/save", {
        cookie,
        corps: { ...CIBLE, password: "secret" },
      }),
    );
    expect(enregistre.saved).toMatchObject({ backend: "postgres", pending: true, password_present: true });
    await core.appeler("POST", "/api/admin/database/save", { cookie, corps: { backend: "mysql" } });
    await core.appeler("POST", "/api/admin/database/migrate", { cookie, corps: { backend: "sqlite" } });
    expect(await core.appeler("POST", "/api/admin/database/sqlite", { cookie })).toEqual({
      detail: "Déjà sur SQLite",
    });
  });

  it("toutes les routes du domaine admin-base ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-base").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
