// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/git.test.ts — contrats des connecteurs git du compte (liste, analyse d'URL, création, mise à jour, suppression, test, dépôts) rejoués contre le core TS réel ; les appels sortants sont refusés par la garde SSRF (hôte en boucle locale). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseConnecteursGit } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : connecteurs git (core réel)", () => {
  it("liste vide, analyse d'URL, création validée, mise à jour, suppression", async () => {
    const vide = schemaReponseConnecteursGit.parse(
      await core.appeler("GET", "/api/git/connectors", { cookie }),
    );
    expect(vide.connectors).toEqual([]);
    expect(vide.provider_types.length).toBeGreaterThan(0);
    expect(
      await core.appeler("POST", "/api/git/connectors/parse", {
        cookie,
        corps: { url: "https://github.com/acme/app.git" },
      }),
    ).toMatchObject({ ok: true, host: "github.com" });
    expect(await core.appeler("POST", "/api/git/connectors/parse", { cookie, corps: { url: "" } })).toEqual({
      ok: false,
    });
    await core.appeler("POST", "/api/git/connectors/parse", {
      cookie,
      corps: { url: "http://gitea.lan:3000/x/y", provider_type: "gitea" },
    });
    await core.appeler("POST", "/api/git/connectors", {
      cookie,
      corps: { provider_type: "inconnu", host: "h", token: "t" },
    });
    await core.appeler("POST", "/api/git/connectors", {
      cookie,
      corps: { provider_type: "github", host: "", token: "t" },
    });
    await core.appeler("POST", "/api/git/connectors", {
      cookie,
      corps: { provider_type: "github", host: "github.com", token: "" },
    });
    const cree = (await core.appeler("POST", "/api/git/connectors", {
      cookie,
      corps: {
        provider_type: "github",
        host: "github.com",
        token: "ghp_secret",
        label: "perso",
        username: "zoe",
      },
    })) as { id: number };
    const liste = schemaReponseConnecteursGit.parse(
      await core.appeler("GET", "/api/git/connectors", { cookie }),
    );
    expect(liste.connectors).toHaveLength(1);
    expect(liste.connectors[0]).toMatchObject({ has_token: true, label: "perso" });
    expect(JSON.stringify(liste)).not.toContain("ghp_secret");
    expect(
      await core.appeler("PUT", `/api/git/connectors/${cree.id}`, { cookie, corps: { label: "pro" } }),
    ).toEqual({ ok: true });
    await core.appeler("PUT", `/api/git/connectors/${cree.id}`, {
      cookie,
      corps: { provider_type: "inconnu" },
    });
    await core.appeler("PUT", "/api/git/connectors/9999", { cookie, corps: { label: "x" } });
    await core.appeler("PUT", `/api/git/connectors/${cree.id}`, { cookie: cookieLou, corps: { label: "x" } });
    await core.appeler("DELETE", `/api/git/connectors/${cree.id}`, { cookie: cookieLou });
    expect(await core.appeler("DELETE", `/api/git/connectors/${cree.id}`, { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", `/api/git/connectors/${cree.id}`, { cookie });
    await core.appeler("GET", "/api/git/connectors");
  });

  it("test et dépôts : connecteur inconnu 404, hôte local refusé par la garde sortante", async () => {
    await core.appeler("GET", "/api/git/connectors/9999/repos", { cookie });
    await core.appeler("POST", "/api/git/connectors/9999/test", { cookie });
    const local = (await core.appeler("POST", "/api/git/connectors", {
      cookie,
      corps: {
        provider_type: "gitea",
        host: "127.0.0.1:1",
        token: "t",
        api_base: "http://127.0.0.1:1/api/v1",
      },
    })) as { id: number };
    expect(await core.appeler("POST", `/api/git/connectors/${local.id}/test`, { cookie })).toMatchObject({
      ok: false,
    });
    expect(await core.appeler("GET", `/api/git/connectors/${local.id}/repos`, { cookie })).toMatchObject({
      ok: false,
    });
  });

  it("toutes les routes du domaine git ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "git").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
