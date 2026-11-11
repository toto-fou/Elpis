// SPDX-License-Identifier: MIT
/** frontend/test/admin/jobs-config.test.ts — console › Sandbox : section « Tâches de fond » (neuf réglages) lue, complétée par ses défauts, renvoyée à l'enregistrement. */
import { DEFAUTS_REGLAGES_JOBS } from "@elpis/contracts";
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { JOBS_PAR_DEFAUT } from "../../src/features/admin/etat";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { CHAMPS_ADMIN } from "../../src/features/admin/champs.gen";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const CONFIG = {
  limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
  force_user_docker: false,
  idle_kill_hours: 24,
  network_profiles: [],
  exec_user: "10001:10001",
  runtime: "",
  extra_run_args: [],
};

function monter(jobs?: unknown) {
  const corps: unknown[] = [];
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/admin/executors" && init?.method === "POST") {
      corps.push(JSON.parse(String(init.body)));
      return json({ ok: true, config: {}, warnings: [], stale_containers: [] });
    }
    if (url === "/api/admin/executors")
      return json({
        config: jobs === undefined ? CONFIG : { ...CONFIG, jobs },
        image: "elpis/sandbox:1.0.0",
      });
    return json({});
  };
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  return { A, corps };
}

describe("console › Sandbox › Tâches de fond", () => {
  it("lecture : les neuf réglages du serveur, valeurs manquantes complétées par les défauts du contrat", async () => {
    const { A } = monter({ ...JOBS_PAR_DEFAUT, max_per_chat: 4, wake_concurrency: 2 });
    await A.loadExecConfig();
    expect(A.execConfig.value.jobs).toEqual({ ...JOBS_PAR_DEFAUT, max_per_chat: 4, wake_concurrency: 2 });
    expect(Object.keys(JOBS_PAR_DEFAUT)).toHaveLength(9);
    expect(JOBS_PAR_DEFAUT).toEqual(DEFAUTS_REGLAGES_JOBS);
  });

  it("chargement de la configuration : la section jobs alimente le formulaire", async () => {
    const { A } = monter({ ...JOBS_PAR_DEFAUT, max_per_user: 8, event_max_bytes: 4096 });
    await A.loadExecConfig();
    expect(A.execConfig.value.jobs.max_per_user).toBe(8);
    expect(A.execConfig.value.jobs.event_max_bytes).toBe(4096);
    expect(A.execConfig.value.jobs.max_depth).toBe(5);
  });

  it("serveur sans section jobs : défauts du cahier des charges", async () => {
    const { A } = monter();
    await A.loadExecConfig();
    expect(A.execConfig.value.jobs).toEqual(JOBS_PAR_DEFAUT);
  });

  it("enregistrement : la section jobs modifiée part dans le corps", async () => {
    const { A, corps } = monter();
    await A.loadExecConfig();
    A.execConfig.value.jobs.wakes_per_hour = 30;
    expect(await A.saveExecConfig()).toBe(true);
    const envoye = corps[0] as { executors: { jobs: Record<string, number> } };
    expect(envoye.executors.jobs.wakes_per_hour).toBe(30);
    expect(Object.keys(envoye.executors.jobs)).toHaveLength(9);
  });

  it("chaque réglage est un champ indexé pour la palette de la console", () => {
    const chemins = CHAMPS_ADMIN.filter((c) => c.path.startsWith("jobs.")).map((c) => c.path.slice(5));
    expect(chemins.sort()).toEqual(Object.keys(JOBS_PAR_DEFAUT).sort());
  });
});
