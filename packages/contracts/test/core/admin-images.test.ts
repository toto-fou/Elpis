// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-images.test.ts — contrats de la console pour le moteur d'images (test, modèles, clé scellée) rejoués contre le core TS réel et un faux service. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configurerChiffrement } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FauxServeur } from "../../../../apps/core/test/llm/faux-serveur";
import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let dossier = "";
let faux: FauxServeur;

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrats-images-"));
  configurerChiffrement({ cleEnv: "cle-de-test-contrats", fichierCle: join(dossier, ".k") });
  faux = await FauxServeur.demarrer();
  faux.json("GET /v1/models", { data: [{ id: "image-1" }, { id: "image-2" }] });
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  await faux.arreter();
  rmSync(dossier, { recursive: true, force: true });
});

describe("contrats REST : moteur d'images de la console (core réel)", () => {
  it("clé : état, enregistrement scellé, effacement, refus", async () => {
    expect(await core.appeler("GET", "/api/admin/image/key", { cookie })).toEqual({
      has_key: false,
      stale: false,
    });
    await core.appeler("PUT", "/api/admin/image/key", { cookie, corps: { api_key: "secret" } });
    expect(
      await core.appeler("PUT", "/api/admin/image/key", {
        cookie,
        corps: { api_key: "secret", url: `${faux.url}/v1` },
      }),
    ).toEqual({ ok: true, has_key: false, stale: true });
    expect(
      await core.appeler("PUT", "/api/admin/image/key", { cookie, corps: { api_key: "" } }),
    ).toMatchObject({
      ok: true,
    });
    await core.appeler("PUT", "/api/admin/image/key", {
      cookie,
      corps: { api_key: "x".repeat(5000), url: faux.url },
    });
    await core.appeler("GET", "/api/admin/image/key", { cookie: cookieLou });
  });

  it("test et liste des modèles : sans adresse, vers un faux service, vers un service injoignable", async () => {
    expect(await core.appeler("POST", "/api/admin/image/test", { cookie, corps: {} })).toMatchObject({
      ok: false,
      error: "Aucune adresse renseignée.",
    });
    await core.appeler("POST", "/api/admin/image/test", {
      cookie,
      corps: { provider: "openai", url: `${faux.url}/v1`, model: "image-1" },
    });
    await core.appeler("POST", "/api/admin/image/test", {
      cookie,
      corps: { provider: "sdcpp", url: "http://127.0.0.1:1" },
    });
    expect(await core.appeler("POST", "/api/admin/image/models", { cookie, corps: {} })).toMatchObject({
      ok: false,
      models: [],
    });
    await core.appeler("POST", "/api/admin/image/models", {
      cookie,
      corps: { provider: "openai", url: `${faux.url}/v1` },
    });
    await core.appeler("POST", "/api/admin/image/models", {
      cookie,
      corps: { provider: "openai", url: "http://127.0.0.1:1" },
    });
    await core.appeler("POST", "/api/admin/image/test", { cookie: cookieLou, corps: {} });
  });

  it("toutes les routes du domaine admin-images ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-images").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
