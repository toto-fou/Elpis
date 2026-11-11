// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/apercu-bac.test.ts — contrat du jeton d'aperçu du bac (`/api/sandbox/preview-token`, servi par main) rejoué contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseJetonApercu } from "../../src";
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

describe("contrats REST : jeton d'aperçu du bac (core réel)", () => {
  it("jeton signé du compte et échéance, refusé sans session", async () => {
    const jeton = schemaReponseJetonApercu.parse(
      await core.appeler("GET", "/api/sandbox/preview-token", { cookie }),
    );
    expect(jeton.token).toMatch(/^\d+-\d+-[0-9a-f]{32}$/u);
    expect(jeton.expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await core.appeler("GET", "/api/sandbox/preview-token");
  });

  it("toutes les routes du domaine ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "apercu-bac").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
