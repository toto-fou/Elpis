// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-identite.test.ts — contrats de la console › connexion d'entreprise rejoués contre le core TS réel en process admin. */
import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";
import { writeFileSync } from "node:fs";

let core: CoreDeTest;
let cookie = "";

const IDP = {
  type: "oidc",
  id: "idp",
  label: "IdP",
  issuer: "https://idp.exemple.lan/realms/elpis",
  client_id: "elpis",
  required_groups: ["elpis"],
};

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : connexion d'entreprise (core réel)", () => {
  it("lecture sans section, réglages, création, secret, activation refusée, extinction, suppression", async () => {
    expect(await core.appeler("GET", "/api/admin/auth", { cookie })).toMatchObject({
      public_url: "",
      local: { mode: "all" },
      providers: [],
      invalid_providers: [],
      prerequisites: { public_url_https: false, cookie_secure: false, local_admins: 1 },
    });
    expect(
      await core.appeler("PUT", "/api/admin/auth/settings", {
        cookie,
        corps: { public_url: "https://elpis.exemple.lan" },
      }),
    ).toMatchObject({ public_url: "https://elpis.exemple.lan" });
    expect(await core.appeler("POST", "/api/admin/auth/providers", { cookie, corps: IDP })).toMatchObject({
      providers: [
        {
          id: "idp",
          type: "oidc",
          enabled: false,
          has_secret: false,
          tested: false,
          active: false,
          identities: 0,
        },
      ],
    });
    await core.appeler("POST", "/api/admin/auth/providers", {
      cookie,
      corps: { ...IDP, issuer: "http://x" },
    });
    await core.appeler("POST", "/api/admin/auth/providers", {
      cookie,
      corps: { type: "oidc", id: "sso", label: "SSO", issuer: "https://sso.exemple.lan", client_id: "c" },
    });
    expect(
      await core.appeler("PUT", "/api/admin/auth/providers/idp", {
        cookie,
        corps: { label: "IdP central" },
      }),
    ).toMatchObject({ providers: [{ label: "IdP central" }, { id: "sso", type: "oidc" }] });
    expect(
      await core.appeler("PUT", "/api/admin/auth/providers/idp/secret", {
        cookie,
        corps: { secret: "mot-de-passe" },
      }),
    ).toMatchObject({ providers: [{ has_secret: true }, {}] });
    expect(await core.appeler("GET", "/api/admin/auth/providers/sso/trial", { cookie })).toEqual({
      result: null,
    });
    await core.appeler("POST", "/api/admin/auth/providers/sso/trial", { cookie, corps: {} });
    await core.appeler("POST", "/api/admin/auth/providers/idp/enable", { cookie });
    expect(await core.appeler("POST", "/api/admin/auth/providers/idp/disable", { cookie })).toMatchObject({
      providers: [{ enabled: false }, {}],
    });
    expect(
      await core.appeler("POST", "/api/admin/auth/providers/test", {
        cookie,
        corps: { ...IDP, issuer: "https://127.0.0.1:9/realms/x" },
      }),
    ).toMatchObject({
      ok: false,
      steps: [
        { id: "settings" },
        { id: "prerequisites" },
        { id: "resolve" },
        { id: "address", level: "fail" },
      ],
    });
    await core.appeler("PUT", "/api/admin/auth/providers/inconnu", { cookie, corps: {} });
    expect(await core.appeler("DELETE", "/api/admin/auth/providers/idp", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", "/api/admin/auth/providers/idp", { cookie });
  });

  it("fournisseur écrit à la main et illisible : listé à part", async () => {
    writeFileSync(
      config.CONFIG_JSON_PATH,
      JSON.stringify({ auth: { providers: [{ id: "casse", label: "Cassé", enabled: true }] } }),
    );
    invalidateConfigCache();
    expect(await core.appeler("GET", "/api/admin/auth", { cookie })).toMatchObject({
      providers: [],
      invalid_providers: [{ id: "casse", label: "Cassé", enabled: true }],
    });
    expect(await core.appeler("DELETE", "/api/admin/auth/providers/casse", { cookie })).toEqual({ ok: true });
  });

  it("toutes les routes du domaine admin-identite ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-identite").map(cle);
    expect(attendues).toHaveLength(11);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
