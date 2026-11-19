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

const LDAP = {
  type: "ldap",
  id: "annuaire",
  label: "Annuaire",
  urls: ["ldaps://ldap.exemple.lan"],
  bind_dn: "uid=svc,cn=users,dc=exemple,dc=lan",
  user_base_dn: "cn=users,dc=exemple,dc=lan",
  user_filter: "(uid={username})",
  required_groups: ["cn=elpis,cn=groups,dc=exemple,dc=lan"],
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
    expect(await core.appeler("POST", "/api/admin/auth/providers", { cookie, corps: LDAP })).toMatchObject({
      providers: [
        {
          id: "annuaire",
          type: "ldap",
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
      corps: { ...LDAP, urls: ["ldap://x"] },
    });
    await core.appeler("POST", "/api/admin/auth/providers", {
      cookie,
      corps: { type: "oidc", id: "sso", label: "SSO", issuer: "https://idp.exemple.lan", client_id: "c" },
    });
    expect(
      await core.appeler("PUT", "/api/admin/auth/providers/annuaire", {
        cookie,
        corps: { label: "Annuaire central" },
      }),
    ).toMatchObject({ providers: [{ label: "Annuaire central" }, { id: "sso", type: "oidc" }] });
    expect(
      await core.appeler("PUT", "/api/admin/auth/providers/annuaire/secret", {
        cookie,
        corps: { secret: "mot-de-passe" },
      }),
    ).toMatchObject({ providers: [{ has_secret: true }, {}] });
    expect(await core.appeler("GET", "/api/admin/auth/providers/sso/trial", { cookie })).toEqual({
      result: null,
    });
    await core.appeler("POST", "/api/admin/auth/providers/sso/trial", { cookie, corps: {} });
    await core.appeler("POST", "/api/admin/auth/providers/annuaire/enable", { cookie });
    expect(
      await core.appeler("POST", "/api/admin/auth/providers/annuaire/disable", { cookie }),
    ).toMatchObject({
      providers: [{ enabled: false }, {}],
    });
    expect(
      await core.appeler("POST", "/api/admin/auth/providers/test", {
        cookie,
        corps: { ...LDAP, urls: ["ldaps://127.0.0.1:9"] },
      }),
    ).toMatchObject({
      ok: false,
      complete: false,
      steps: [
        { id: "settings" },
        { id: "prerequisites" },
        { id: "resolve" },
        { id: "address", level: "fail" },
      ],
    });
    await core.appeler("PUT", "/api/admin/auth/providers/inconnu", { cookie, corps: {} });
    expect(await core.appeler("DELETE", "/api/admin/auth/providers/annuaire", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", "/api/admin/auth/providers/annuaire", { cookie });
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
