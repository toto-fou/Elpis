// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-comptes.test.ts — contrats de la console (comptes, groupes, accès LLM, bac, accès délivrés, clients OAuth) rejoués contre le core TS réel en process admin. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseComptesConsole } from "../../src";
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

describe("contrats REST : comptes de la console (core réel)", () => {
  it("création, rôle, mot de passe, liste avec groupes, suppression", async () => {
    expect(
      await core.appeler("POST", "/api/admin/users/new", {
        cookie,
        corps: { username: "bob", password: "pw-de-bob-1", role: "user" },
      }),
    ).toEqual({ ok: true });
    await core.appeler("POST", "/api/admin/users/new", { cookie, corps: { username: "bob", password: "x" } });
    await core.appeler("POST", "/api/admin/users/new", { cookie, corps: { username: "", password: "" } });
    await core.appeler("POST", "/api/admin/users/new", {
      cookie: cookieLou,
      corps: { username: "z", password: "z" },
    });
    expect(
      await core.appeler("POST", "/api/admin/users/3/role", { cookie, corps: { role: "moderator" } }),
    ).toEqual({ ok: true, role: "moderator" });
    await core.appeler("POST", "/api/admin/users/1/role", { cookie, corps: { role: "user" } });
    await core.appeler("POST", "/api/admin/users/99/role", { cookie, corps: { role: "user" } });
    expect(
      await core.appeler("POST", "/api/admin/reset-password", {
        cookie,
        corps: { target_id: 3, new_password: "nouveau-mdp-1" },
      }),
    ).toEqual({ ok: true });
    await core.appeler("POST", "/api/admin/reset-password", { cookie, corps: {} });
    const liste = schemaReponseComptesConsole.parse(
      await core.appeler("GET", "/api/admin/users-with-groups", { cookie }),
    );
    expect(liste.users.map((u) => u.username).sort()).toEqual(["bob", "lou", "zoe"]);
    await core.appeler("GET", "/api/admin/users-with-groups", { cookie: cookieLou });
    expect(await core.appeler("DELETE", "/api/admin/users/3?delete_sandbox=true", { cookie })).toEqual({
      ok: true,
      sandbox_deleted: true,
    });
    await core.appeler("DELETE", "/api/admin/users/3", { cookie });
    await core.appeler("DELETE", "/api/admin/users/1", { cookie });
  });

  it("groupes : création, mise à jour, appartenance, accès LLM, suppression", async () => {
    expect(
      await core.appeler("POST", "/api/admin/groups", {
        cookie,
        corps: { name: "Équipe", description: "d" },
      }),
    ).toEqual({ ok: true, id: 1 });
    await core.appeler("POST", "/api/admin/groups", { cookie, corps: { name: "" } });
    expect(await core.appeler("PUT", "/api/admin/groups/1", { cookie, corps: { name: "Équipe 2" } })).toEqual(
      {
        ok: true,
      },
    );
    await core.appeler("PUT", "/api/admin/groups/99", { cookie, corps: { name: "x" } });
    expect(
      await core.appeler("PUT", "/api/admin/users/2/groups", { cookie, corps: { group_ids: [1] } }),
    ).toEqual({
      ok: true,
      group_ids: [1],
    });
    await core.appeler("PUT", "/api/admin/users/2/groups", { cookie, corps: { group_ids: ["x"] } });
    await core.appeler("PUT", "/api/admin/users/99/groups", { cookie, corps: { group_ids: [] } });
    expect(await core.appeler("GET", "/api/admin/groups", { cookie })).toMatchObject({
      groups: [{ id: 1, name: "Équipe 2", member_count: 1 }],
    });
    expect(await core.appeler("GET", "/api/admin/groups/1/llm-access", { cookie })).toEqual({
      engine_keys: null,
      can_manage_models: null,
    });
    expect(
      await core.appeler("PUT", "/api/admin/groups/1/llm-access", {
        cookie,
        corps: { can_manage_models: false },
      }),
    ).toEqual({ ok: true, engine_keys: null, can_manage_models: false });
    await core.appeler("PUT", "/api/admin/groups/1/llm-access", {
      cookie,
      corps: { engine_keys: ["inconnu"] },
    });
    await core.appeler("GET", "/api/admin/groups/99/llm-access", { cookie });
    expect(await core.appeler("DELETE", "/api/admin/groups/1", { cookie })).toEqual({ ok: true });
    await core.appeler("DELETE", "/api/admin/groups/1", { cookie });
  });

  it("accès LLM d'un compte, moteurs proposés, quota et réseau du bac, machines du bureau", async () => {
    expect(await core.appeler("GET", "/api/admin/llm/engine-options", { cookie })).toMatchObject({
      engines: [{ key: "builtin" }],
    });
    expect(await core.appeler("GET", "/api/admin/users/2/llm-access", { cookie })).toMatchObject({
      engine_source: "default",
    });
    expect(
      await core.appeler("PUT", "/api/admin/users/2/llm-access", {
        cookie,
        corps: { engine_keys: ["builtin"], can_manage_models: true },
      }),
    ).toMatchObject({ ok: true, engine_keys: ["builtin"], engine_source: "user" });
    await core.appeler("PUT", "/api/admin/users/2/llm-access", {
      cookie,
      corps: { can_manage_models: "oui" },
    });
    await core.appeler("GET", "/api/admin/users/99/llm-access", { cookie });
    expect(
      await core.appeler("POST", "/api/admin/users/2/sandbox-quota", { cookie, corps: { quota_mb: 100 } }),
    ).toEqual({ ok: true, quota_mb: 100 });
    await core.appeler("POST", "/api/admin/users/2/sandbox-quota", { cookie, corps: { quota_mb: -5 } });
    await core.appeler("POST", "/api/admin/users/2/sandbox-quota", { cookie, corps: {} });
    expect(
      await core.appeler("POST", "/api/admin/users/2/network-profile", { cookie, corps: { profile_id: "" } }),
    ).toMatchObject({ ok: true, forced_network_profile_id: "" });
    await core.appeler("POST", "/api/admin/users/2/network-profile", {
      cookie,
      corps: { profile_id: "absent" },
    });
    expect(
      await core.appeler("PUT", "/api/admin/users/2/desktop-targets", { cookie, corps: { targets: [] } }),
    ).toEqual({ ok: true, changed: [], desktop_targets: [] });
    await core.appeler("PUT", "/api/admin/users/2/desktop-targets", {
      cookie,
      corps: { targets: ["inconnue"] },
    });
  });

  it("accès délivrés, clients OAuth", async () => {
    expect(await core.appeler("GET", "/api/admin/users/2/access", { cookie })).toEqual({
      tokens: [],
      grants: [],
    });
    expect(await core.appeler("POST", "/api/admin/users/2/access/revoke", { cookie })).toEqual({
      ok: true,
      tokens: 0,
      oauth: 0,
    });
    await core.appeler("GET", "/api/admin/users/99/access", { cookie });
    await core.appeler("POST", "/api/admin/users/99/access/revoke", { cookie });
    await core.base.run(
      "INSERT INTO oauth_clients(client_id, kind, name, secret_hash, auth_method, redirect_uris, metadata, created_at) " +
        "VALUES ('c1', 'dcr', 'Client de test', '', 'none', '[\"http://localhost/cb\"]', '{}', 1700000000)",
    );
    expect(await core.appeler("GET", "/api/admin/oauth/clients", { cookie })).toMatchObject({
      items: [{ client_id: "c1", name: "Client de test", grants: 0, has_secret: false }],
    });
    expect(await core.appeler("DELETE", "/api/admin/oauth/clients?client_id=c1", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", "/api/admin/oauth/clients?client_id=c1", { cookie });
  });

  it("toutes les routes du domaine admin-comptes ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-comptes").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
