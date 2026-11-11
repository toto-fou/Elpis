// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/jobs-routes.test.ts — contrats des tâches de fond rejoués contre le core TS réel : `/api/jobs`, arrêt, « Ne pas me réveiller », saisie, `wake_disabled` d'une conversation, défaut du compte `jobs_wake`, section `jobs` de la console. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, DEFAUTS_REGLAGES_JOBS, schemaReponseJobs, schemaReponseNouveauChat } from "../../src";
import { DEFAUTS_JOBS } from "../../../../apps/core/src/jobs/reglages";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let admin: CoreDeTest;
let cookie = "";
let cookieAdmin = "";

beforeAll(async () => {
  core = await demarrerCore();
  admin = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  await creerCompte(admin.base, "max", "mdp-de-max-1", 1);
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieAdmin = await admin.connecter("max", "mdp-de-max-1");
});

afterAll(async () => {
  await admin.fermer();
  await core.fermer();
});

describe("contrats REST : tâches de fond (core réel)", () => {
  it("liste, arrêt, interrupteur de réveil, saisie ; `wake_disabled` posé sur la conversation, effectif dans /api/jobs", async () => {
    const id = schemaReponseNouveauChat.parse(
      await core.appeler("POST", "/api/saved/chats/new", { cookie }),
    ).id;
    expect(schemaReponseJobs.parse(await core.appeler("GET", `/api/jobs?chat_id=${id}`, { cookie }))).toEqual(
      {
        jobs: [],
        active_total: 0,
        max_per_chat: 3,
        max_per_user: 5,
        wake_queue: [],
        wake_running: [],
        wake_disabled: false,
      },
    );
    expect(await core.appeler("GET", "/api/jobs?scope=all", { cookie })).not.toHaveProperty("wake_disabled");
    expect(await core.appeler("GET", "/api/jobs", { cookie })).toEqual({
      detail: "chat_id ou scope=all requis",
    });
    expect(await core.appeler("POST", "/api/jobs/stop", { cookie, corps: { chat_id: id } })).toEqual({
      ok: true,
      stopped: [],
      not_found: [],
    });
    expect(await core.appeler("POST", "/api/jobs/stop", { cookie, corps: { ids: ["j-00000000"] } })).toEqual({
      ok: true,
      stopped: [],
      not_found: ["j-00000000"],
    });
    await core.appeler("POST", "/api/jobs/stop", { cookie, corps: {} });
    expect(
      await core.appeler("PUT", `/api/saved/chats/${id}/wake`, { cookie, corps: { wake_disabled: true } }),
    ).toEqual({ ok: true, wake_disabled: true });
    await core.appeler("PUT", "/api/saved/chats/inconnu/wake", { cookie, corps: { wake_disabled: true } });
    await core.appeler("PUT", `/api/saved/chats/${id}/wake`, { cookie, corps: { wake_disabled: "oui" } });
    expect(await core.appeler("GET", `/api/saved/chats/${id}`, { cookie })).toMatchObject({
      wake_disabled: true,
    });
    expect(await core.appeler("POST", `/api/chat/${id}/composing`, { cookie })).toEqual({ ok: true });
    const autre = schemaReponseNouveauChat.parse(
      await core.appeler("POST", "/api/saved/chats/new", { cookie }),
    ).id;
    await core.appeler("PUT", "/api/settings", { cookie, corps: { jobs_wake: false } });
    expect(await core.appeler("GET", "/api/settings", { cookie })).toMatchObject({ jobs_wake: false });
    expect(await core.appeler("GET", `/api/saved/chats/${autre}`, { cookie })).not.toHaveProperty(
      "wake_disabled",
    );
    expect(await core.appeler("GET", `/api/jobs?chat_id=${autre}`, { cookie })).toMatchObject({
      wake_disabled: true,
    });
    for (const r of CONTRATS_REST.filter((c) => c.domaine === "jobs"))
      expect(core.couvertes.has(cle(r)), cle(r)).toBe(true);
  });

  it("console : section `jobs` servie avec ses défauts, enregistrée bornée, gardée quand le POST n'en porte pas", async () => {
    expect(DEFAUTS_REGLAGES_JOBS).toEqual(DEFAUTS_JOBS);
    expect(await admin.appeler("GET", "/api/admin/executors", { cookie: cookieAdmin })).toMatchObject({
      config: { jobs: DEFAUTS_REGLAGES_JOBS },
    });
    const jobs = { ...DEFAUTS_REGLAGES_JOBS, max_per_chat: 4, wake_concurrency: 2 };
    expect(
      await admin.appeler("POST", "/api/admin/executors", {
        cookie: cookieAdmin,
        corps: { executors: { jobs } },
      }),
    ).toMatchObject({ ok: true, config: { jobs } });
    await admin.appeler("POST", "/api/admin/executors", {
      cookie: cookieAdmin,
      corps: { executors: { jobs: { ...jobs, max_per_chat: 51 } } },
    });
    await admin.appeler("POST", "/api/admin/executors", { cookie: cookieAdmin, corps: { executors: {} } });
    expect(await admin.appeler("GET", "/api/admin/executors", { cookie: cookieAdmin })).toMatchObject({
      config: { jobs },
    });
  });
});
