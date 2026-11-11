// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/jetons.test.ts — contrats des jetons d'accès aux outils (liste, création, régénération, révocation, schéma de famille) rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseJetonCree, schemaReponseSchemaFamille } from "../../src";
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

describe("contrats REST : jetons (core réel)", () => {
  it("liste et politique, création, régénération, révocation", async () => {
    expect(await core.appeler("GET", "/api/tokens", { cookie })).toMatchObject({
      tokens: [],
      policy: { tools_enabled: true },
    });
    const cree = schemaReponseJetonCree.parse(
      await core.appeler("POST", "/api/tokens", {
        cookie,
        corps: { name: "outils", families: ["fs"], days: 5 },
      }),
    );
    expect(cree.token).toMatch(/^ept_/u);
    await core.appeler("POST", "/api/tokens", { cookie, corps: { kind: "opencode", name: "cli", days: "" } });
    await core.appeler("POST", "/api/tokens", { cookie, corps: { name: "vide" } });
    await core.appeler("POST", "/api/tokens", { cookie, corps: { kind: "inconnu" } });
    expect(await core.appeler("GET", "/api/tokens", { cookie })).toMatchObject({
      tokens: [{ kind: "opencode" }, { name: "outils", families: ["fs"] }],
    });
    const nouveau = schemaReponseJetonCree.parse(
      await core.appeler("POST", `/api/tokens/${cree.item.id}/regenerate`, { cookie }),
    );
    expect(nouveau.item.name).toBe("outils");
    await core.appeler("POST", `/api/tokens/${cree.item.id}/regenerate`, { cookie });
    expect(await core.appeler("DELETE", `/api/tokens/${nouveau.item.id}`, { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", `/api/tokens/${nouveau.item.id}`, { cookie });
    await core.appeler("GET", "/api/tokens");
  });

  it("schéma d'une famille : famille inconnue refusée, service d'outils non configuré en test", async () => {
    await core.appeler("GET", "/api/tokens/schema/inconnue", { cookie });
    await core.appeler("GET", "/api/tokens/schema/fs", { cookie });
    const publie = {
      family: "fs",
      tools: [{ name: "read_file", title: "Lire", inputSchema: { type: "object" } }],
    };
    expect(schemaReponseSchemaFamille.parse(publie)).toEqual(publie);
  });

  it("autorisations OAuth du compte : liste vide, révocation d'une autorisation inconnue", async () => {
    expect(await core.appeler("GET", "/api/oauth/grants", { cookie })).toMatchObject({
      items: [],
      enabled: true,
    });
    await core.appeler("DELETE", "/api/oauth/grants/inconnue", { cookie });
    await core.appeler("GET", "/api/oauth/grants");
  });

  it("toutes les routes du domaine jetons ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "jetons").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
