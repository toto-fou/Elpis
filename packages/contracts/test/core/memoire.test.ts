// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/memoire.test.ts — contrats de la mémoire long terme (état, écriture, audit, annulation, effacement) rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseEtatMemoire } from "../../src";
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

describe("contrats REST : mémoire (core réel)", () => {
  it("état vide, écriture, origine de chaque note, audit, annulation, effacement", async () => {
    const vide = schemaReponseEtatMemoire.parse(await core.appeler("GET", "/api/memory/state", { cookie }));
    expect(vide.memory_md.exists).toBe(false);
    expect(
      await core.appeler("PUT", "/api/memory/state/memory", {
        cookie,
        corps: { entries: ["Aime le thé", "Habite Lyon"] },
      }),
    ).toMatchObject({ ok: true, state: { exists: true, n_entries: 2 } });
    const etat = schemaReponseEtatMemoire.parse(await core.appeler("GET", "/api/memory/state", { cookie }));
    const op = etat.memory_md.origins?.[0]?.op ?? "";
    expect(op).toMatch(/^[0-9a-f]+$/u);
    expect(await core.appeler("GET", `/api/memory/audit?limit=5`, { cookie })).toMatchObject({
      count: 1,
      summary: { rewrite: 1, ok: 1 },
    });
    expect(await core.appeler("GET", `/api/memory/ops/${op}`, { cookie })).toMatchObject({
      op,
      can_undo: true,
      added: ["Aime le thé", "Habite Lyon"],
    });
    await core.appeler("GET", "/api/memory/ops/ffff", { cookie });
    await core.appeler("GET", "/api/memory/ops/pas-hexa", { cookie });
    expect(await core.appeler("POST", `/api/memory/ops/${op}/undo`, { cookie })).toMatchObject({
      ok: true,
      op: { undone: true },
    });
    await core.appeler("POST", `/api/memory/ops/${op}/undo`, { cookie });
    await core.appeler("PUT", "/api/memory/state/user", {
      cookie,
      corps: { entries: ["Préfère le français"] },
    });
    await core.appeler("PUT", "/api/memory/state/user", { cookie, corps: { entries: [] } });
    await core.appeler("PUT", "/api/memory/state/memory", { cookie, corps: { entries: ["x".repeat(3000)] } });
    await core.appeler("PUT", "/api/memory/state/memory", { cookie, corps: {} });
    await core.appeler("PUT", "/api/memory/state/autre", { cookie, corps: { entries: [] } });
    expect(await core.appeler("DELETE", "/api/memory/state", { cookie })).toMatchObject({
      ok: true,
      errors: [],
    });
    await core.appeler("GET", "/api/memory/state");
  });

  it("toutes les routes du domaine memoire ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "memoire").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
