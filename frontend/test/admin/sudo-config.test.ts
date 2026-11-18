// SPDX-License-Identifier: MIT
/** frontend/test/admin/sudo-config.test.ts — console › Sandbox › Limites : réglage « Sudo » lu (permis sauf false), renvoyé à l'enregistrement, indexé pour la palette. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
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

function monter(config: Record<string, unknown>) {
  const corps: unknown[] = [];
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/admin/executors" && init?.method === "POST") {
      corps.push(JSON.parse(String(init.body)));
      return json({ ok: true, config: {}, warnings: [], stale_containers: [] });
    }
    if (url === "/api/admin/executors")
      return json({ config: { ...CONFIG, ...config }, image: "elpis/sandbox:1.0.0" });
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

describe("console › Sandbox › Sudo", () => {
  it.each([
    [{}, true],
    [{ allow_sudo: true }, true],
    [{ allow_sudo: false }, false],
  ])("lecture %j : permis %s", async (config, attendu) => {
    const { A } = monter(config);
    await A.loadExecConfig();
    expect(A.execConfig.value.allow_sudo).toBe(attendu);
  });

  it("enregistrement : le réglage modifié part dans le corps", async () => {
    const { A, corps } = monter({ allow_sudo: true });
    await A.loadExecConfig();
    A.execConfig.value.allow_sudo = false;
    expect(await A.saveExecConfig()).toBe(true);
    expect((corps[0] as { executors: { allow_sudo: boolean } }).executors.allow_sudo).toBe(false);
  });

  it("champ indexé pour la palette de la console", () => {
    expect(CHAMPS_ADMIN.some((c) => c.path === "allow_sudo" && c.page === "sandbox-limits")).toBe(true);
  });
});
