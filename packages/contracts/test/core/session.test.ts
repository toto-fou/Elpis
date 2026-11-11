// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/session.test.ts — contrats de session et de comptes rejoués contre le core TS réel. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseMoi } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;

beforeAll(async () => {
  core = await demarrerCore();
  const zoe = await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  await creerCompte(core.base, "max", "mdp-de-max-1", 2);
  await creerCompte(core.base, "neo", "mdp-de-neo-1");
  await core.base.run("UPDATE users SET must_change_pwd=1 WHERE username='neo'");
  await core.base.run("UPDATE users SET avatar='zoe.png' WHERE id=?", [zoe]);
  await core.base.run("INSERT INTO \"groups\"(name, description, created_at) VALUES ('labo', NULL, 0)");
  await core.base.run(
    "INSERT INTO user_groups(user_id, group_id) SELECT ?, id FROM \"groups\" WHERE name='labo'",
    [zoe],
  );
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : session et comptes (core réel)", () => {
  it("santé, session absente, connexion, rôle, déconnexion", async () => {
    expect(await core.appeler("GET", "/api/health")).toEqual({ status: "ok" });
    expect(await core.appeler("GET", "/api/me-lite")).toEqual({ logged_in: false });
    await core.appeler("GET", "/api/auth/check");
    expect(
      await core.appeler("POST", "/api/login-lite", { corps: { username: "zoe", password: "faux" } }),
    ).toEqual({
      detail: "invalid credentials",
    });
    await core.appeler("POST", "/api/login-lite", { corps: { username: "" } });
    const cookie = await core.connecter("zoe", "mdp-de-zoe-1");
    expect(cookie).toMatch(/^mcpwebui_session=/u);
    await core.appeler("GET", "/api/auth/check", { cookie });
    const moi = schemaReponseMoi.parse(await core.appeler("GET", "/api/me-lite", { cookie }));
    expect(moi).toMatchObject({ logged_in: true, role: "user", is_admin: false, avatar: "zoe.png" });
    const comptes = await core.appeler("GET", "/api/users/lite", { cookie });
    expect(comptes).toMatchObject({ my_groups: [{ name: "labo", description: null }] });
    expect(await core.appeler("POST", "/api/logout-lite", { cookie })).toEqual({ ok: true });
    await core.appeler("GET", "/api/users/lite");
  });

  it("modérateur : `is_admin` vrai, `role` moderator ; mot de passe à changer puis changé", async () => {
    const max = await core.connecter("max", "mdp-de-max-1");
    expect(await core.appeler("GET", "/api/me-lite", { cookie: max })).toMatchObject({
      is_admin: true,
      role: "moderator",
    });
    const neo = await core.connecter("neo", "mdp-de-neo-1");
    expect(await core.appeler("GET", "/api/me-lite", { cookie: neo })).toMatchObject({
      logged_in: false,
      must_change_password: true,
      username: "neo",
    });
    await core.appeler("POST", "/api/users/change-password", { cookie: neo, corps: {} });
    expect(
      await core.appeler("POST", "/api/users/change-password", {
        cookie: neo,
        corps: { new_password: "nouveau-mdp-de-neo-2" },
      }),
    ).toEqual({ ok: true });
  });

  it("toutes les routes du domaine ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "session").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
