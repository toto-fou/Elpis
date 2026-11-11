// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-executeurs.test.ts — contrats de la console pour les exécuteurs, les conteneurs et les hôtes d'outils rejoués contre le core TS réel en process admin (sans Docker : les chemins qui l'exigent sont vérifiés sur des exemples). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRATS_REST,
  schemaReponseConteneurs,
  schemaReponseHotesOutils,
  schemaReponseSanteDocker,
} from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
const dockerHostAvant = process.env["DOCKER_HOST"];

beforeAll(async () => {
  process.env["DOCKER_HOST"] = "unix:///nonexistent/elpis-test-docker.sock";
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
  if (dockerHostAvant === undefined) delete process.env["DOCKER_HOST"];
  else process.env["DOCKER_HOST"] = dockerHostAvant;
});

describe("contrats REST : exécuteurs de la console (core réel)", () => {
  it("configuration : lecture, enregistrement assaini, corps invalide, refus", async () => {
    expect(await core.appeler("GET", "/api/admin/executors", { cookie })).toMatchObject({
      config: { force_user_docker: false },
    });
    expect(
      await core.appeler("POST", "/api/admin/executors", {
        cookie,
        corps: { executors: { force_user_docker: true, idle_kill_hours: 6 } },
      }),
    ).toMatchObject({ ok: true, config: { force_user_docker: true } });
    await core.appeler("POST", "/api/admin/executors", { cookie, corps: {} });
    await core.appeler("GET", "/api/admin/executors", { cookie: cookieLou });
  });

  it("Docker absent : santé en échec, conteneurs en 502 ; arrêt, destruction et nettoyage répondent ok", async () => {
    expect(
      schemaReponseSanteDocker.parse(
        await core.appeler("GET", "/api/admin/executors/healthcheck", { cookie }),
      ),
    ).toMatchObject({
      daemon_ok: false,
    });
    await core.appeler("GET", "/api/admin/sandbox/containers", { cookie });
    await core.appeler("POST", "/api/admin/sandbox/containers/99/stop", { cookie });
    expect(await core.appeler("POST", "/api/admin/sandbox/containers/1/stop", { cookie })).toEqual({
      ok: true,
    });
    expect(await core.appeler("DELETE", "/api/admin/sandbox/containers/1", { cookie })).toEqual({ ok: true });
    expect(await core.appeler("POST", "/api/admin/sandbox/gc", { cookie })).toEqual({
      ok: true,
      stopped: [],
    });
    await core.appeler("POST", "/api/admin/sandbox/gc", { cookie: cookieLou });
    const sain = {
      daemon_ok: true,
      server_version: "27.0.0",
      image: "elpis/sandbox:1.7.0",
      image_loaded: false,
      archive_available: false,
      archive_path: null,
      image_load_state: { status: "not_checked", image: null, archive_path: null, progress_msg: "" },
    };
    expect(schemaReponseSanteDocker.parse(sain)).toEqual(sain);
    const liste = {
      containers: [
        {
          id: "abc",
          name: "elpis-sandbox-zoe",
          image: "elpis/sandbox:1.7.0",
          state: "running",
          status: "Up 2 hours",
          created: "2026-10-12 10:00:00 +0000 UTC",
          user_id: 1,
          username: "zoe",
        },
      ],
      count: 1,
    };
    expect(schemaReponseConteneurs.parse(liste)).toEqual(liste);
  });

  it("hôtes d'outils : liste, placement inconnu refusé, placements existants", async () => {
    expect(await core.appeler("GET", "/api/admin/toolhosts", { cookie })).toEqual({
      ok: true,
      hosts: [],
      placement: {},
      placements: [],
    });
    await core.appeler("POST", "/api/admin/toolhosts/placements/1", { cookie, corps: { host_id: "x" } });
    await core.appeler("POST", "/api/admin/toolhosts/placements/1/migrate", {
      cookie,
      corps: { host_id: "x" },
    });
    await core.base.run(
      "INSERT INTO sandbox_placements(user_id, host_id, created_at, updated_at) VALUES (1, 'h1', 1700000000, 1700000000)",
    );
    const vue = schemaReponseHotesOutils.parse(await core.appeler("GET", "/api/admin/toolhosts", { cookie }));
    expect(vue.placements).toMatchObject([{ user_id: 1, host_id: "h1", username: "zoe" }]);
    expect(await core.appeler("DELETE", "/api/admin/toolhosts/placements/1", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("GET", "/api/admin/toolhosts", { cookie: cookieLou });
  });

  it("toutes les routes du domaine admin-executeurs ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-executeurs").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
