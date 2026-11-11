// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-audit.test.ts — contrats de la console › Journalisation (réglages du journal de sécurité) rejoués contre le core TS réel en process admin. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReglagesJournal } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1", 2);
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

const CONSOLE = { "x-elpis-console": "1" };
describe("contrats REST : journal de sécurité (core réel)", () => {
  it("réglages lus puis écrits ; refus hors bornes et au modérateur", async () => {
    expect(
      schemaReglagesJournal.parse(await core.appeler("GET", "/api/admin/audit/settings", { cookie })),
    ).toMatchObject({
      retention_days: 365,
    });
    const ecrit = schemaReglagesJournal.parse(
      await core.appeler("PUT", "/api/admin/audit/settings", {
        cookie,
        corps: { retention_days: 400, forwarding_expected: true },
      }),
    );
    expect(ecrit).toMatchObject({ retention_days: 400, forwarding_expected: true });
    expect(
      await core.appeler("PUT", "/api/admin/audit/settings", { cookie, corps: { retention_days: 10 } }),
    ).toMatchObject({
      detail: expect.stringContaining("180") as unknown,
    });
    await core.appeler("GET", "/api/admin/audit/settings", { cookie: cookieLou });
  });

  it("recherche, vérification ; export hors registre (fichier) ; refus au modérateur", async () => {
    const page = await core.appeler("GET", "/api/admin/audit/events?limit=5", { cookie, entetes: CONSOLE });
    expect(page).toMatchObject({ budget_reached: false });
    await core.appeler("GET", "/api/admin/audit/events?cursor=faux", { cookie, entetes: CONSOLE });
    await core.appeler("GET", "/api/admin/audit/events", { cookie: cookieLou, entetes: CONSOLE });
    expect(await core.appeler("POST", "/api/admin/audit/verify", { cookie, corps: {} })).toMatchObject({
      from: null,
    });
    await core.appeler("POST", "/api/admin/audit/verify", { cookie: cookieLou, corps: {} });
    const r = await core.app.inject({
      method: "POST",
      url: "/api/admin/audit/export?format=jsonl",
      headers: { cookie },
    });
    expect([r.statusCode, r.headers["content-type"]]).toEqual([200, "application/x-ndjson"]);
  });

  it("état et événement de test ; refus au modérateur", async () => {
    expect(await core.appeler("GET", "/api/admin/audit/status", { cookie })).toMatchObject({
      files: expect.any(Number) as unknown,
    });
    await core.appeler("GET", "/api/admin/audit/status", { cookie: cookieLou });
    expect(await core.appeler("POST", "/api/admin/audit/test", { cookie, corps: {} })).toMatchObject({
      ok: true,
    });
    await core.appeler("POST", "/api/admin/audit/test", { cookie: cookieLou, corps: {} });
  });

  it("toutes les routes du domaine admin-audit ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-audit").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
