// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-skins.test.ts — contrats des skins de la console (éditeur, état, détail, export puis import, suppression) rejoués contre le core TS réel en process admin. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";

const SKIN = {
  id: "test",
  label: "Test",
  description: "Skin de test",
  version: "1.0",
  author: "a",
  license: "MIT",
  darkBase: false,
  swatch: ["#111111", "#222222", "#333333"],
  tokens: { light: { "--accent": "#ff0000" } },
  brand: {},
  css: "",
};

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

describe("contrats REST : skins de la console (core réel)", () => {
  it("liste, création par l'éditeur, doublon, mise à jour, détail", async () => {
    expect(await core.appeler("GET", "/api/admin/skins", { cookie })).toMatchObject({ default: "elpis" });
    await core.appeler("GET", "/api/admin/skins", { cookie: cookieLou });
    expect(await core.appeler("POST", "/api/admin/skins", { cookie, corps: SKIN })).toMatchObject({
      ok: true,
      skin: { id: "test", enabled: false, source: "plugin" },
    });
    await core.appeler("POST", "/api/admin/skins", { cookie, corps: SKIN });
    await core.appeler("POST", "/api/admin/skins", { cookie, corps: { ...SKIN, id: "Mauvais Id" } });
    await core.appeler("POST", "/api/admin/skins", {
      cookie,
      corps: { ...SKIN, update: true, label: "Test 2" },
    });
    await core.appeler("POST", "/api/admin/skins", {
      cookie,
      corps: { ...SKIN, id: "absent", update: true },
    });
    expect(await core.appeler("GET", "/api/admin/skins/test", { cookie })).toMatchObject({ label: "Test 2" });
    await core.appeler("GET", "/api/admin/skins/elpis", { cookie });
  });

  it("activation, défaut, export zip puis import, suppression", async () => {
    expect(
      await core.appeler("PUT", "/api/admin/skins", { cookie, corps: { enabled: { test: true } } }),
    ).toMatchObject({
      skins: expect.arrayContaining([expect.objectContaining({ id: "test", enabled: true })]),
    });
    await core.appeler("PUT", "/api/admin/skins", { cookie, corps: { default: "test" } });
    await core.appeler("PUT", "/api/admin/skins", { cookie, corps: { enabled: ["test"] } });
    await core.appeler("PUT", "/api/admin/skins", { cookie, corps: [] });
    await core.appeler("PUT", "/api/admin/skins", { cookie, corps: { default: "elpis" } });
    const zip = await core.app.inject({
      method: "GET",
      url: "/api/admin/skins/test/export",
      headers: { cookie },
    });
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(
      await core.televerser("/api/admin/skins/import", {
        cookie,
        fichier: zip.rawPayload,
        nom: "test.zip",
        type: "application/zip",
      }),
    ).toMatchObject({ detail: expect.any(String) });
    expect(
      await core.televerser("/api/admin/skins/import?overwrite=true", {
        cookie,
        fichier: zip.rawPayload,
        nom: "test.zip",
        type: "application/zip",
      }),
    ).toBeDefined();
    await core.televerser("/api/admin/skins/import", { cookie, fichier: Buffer.from("pas un zip") });
    expect(await core.appeler("DELETE", "/api/admin/skins/test", { cookie })).toMatchObject({ ok: true });
    await core.appeler("DELETE", "/api/admin/skins/test", { cookie });
    await core.appeler("DELETE", "/api/admin/skins/elpis", { cookie });
  });

  it("toutes les routes du domaine admin-skins ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-skins").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
