// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/usage.test.ts — contrat de l'usage du compte (`/api/usage/me`) rejoué contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseUsageMoi } from "../../src";
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

describe("contrats REST : usage du compte (core réel)", () => {
  it("compte neuf, fenêtre par défaut puis ramenée aux valeurs autorisées", async () => {
    const neuf = schemaReponseUsageMoi.parse(await core.appeler("GET", "/api/usage/me", { cookie }));
    expect(neuf).toMatchObject({ days: 30, chats: { total: 0 }, tokens: { total: 0, by_source: [] } });
    expect(await core.appeler("GET", "/api/usage/me?days=5", { cookie })).toMatchObject({ days: 7 });
    expect(await core.appeler("GET", "/api/usage/me?days=1000", { cookie })).toMatchObject({ days: 90 });
    expect(await core.appeler("GET", "/api/usage/me?days=abc", { cookie })).toMatchObject({ days: 30 });
    await core.appeler("GET", "/api/usage/me");
  });

  it("toutes les routes du domaine usage ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "usage").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
