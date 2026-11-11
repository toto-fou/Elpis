// SPDX-License-Identifier: MIT
/** frontend/test/admin/disque-config.test.ts — console › Sandbox : bloc « Espace disque » (seuils d'alerte et de refus du harnais N-08) lu, complété par ses défauts, renvoyé à l'enregistrement, indexé pour la palette. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAUTS_SEUILS_DISQUE } from "@elpis/contracts";
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { DISQUE_PAR_DEFAUT } from "../../src/features/admin/etat";
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

function monter(disk?: unknown) {
  const corps: unknown[] = [];
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/admin/executors" && init?.method === "POST") {
      corps.push(JSON.parse(String(init.body)));
      return json({ ok: true, config: {}, warnings: [], stale_containers: [] });
    }
    if (url === "/api/admin/executors")
      return json({
        config: disk === undefined ? CONFIG : { ...CONFIG, disk },
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

describe("console › Sandbox › Espace disque (harnais N-08)", () => {
  it("défauts du contrat : alerte 85 %, refus 97 % ; serveur sans section disk → défauts", async () => {
    expect(DISQUE_PAR_DEFAUT).toEqual(DEFAUTS_SEUILS_DISQUE);
    expect(DISQUE_PAR_DEFAUT).toEqual({ warn_pct: 85, refuse_pct: 97 });
    const { A } = monter();
    await A.loadExecConfig();
    expect(A.execConfig.value.disk).toEqual(DISQUE_PAR_DEFAUT);
  });

  it("lecture : seuils servis par le core repris dans le formulaire", async () => {
    const { A } = monter({ warn_pct: 50, refuse_pct: 60 });
    await A.loadExecConfig();
    expect(A.execConfig.value.disk).toEqual({ warn_pct: 50, refuse_pct: 60 });
  });

  it("enregistrement : la section disk modifiée part dans le corps", async () => {
    const { A, corps } = monter();
    await A.loadExecConfig();
    A.execConfig.value.disk.warn_pct = 70;
    A.execConfig.value.disk.refuse_pct = 90;
    expect(await A.saveExecConfig()).toBe(true);
    const envoye = corps[0] as { executors: { disk: Record<string, number> } };
    expect(envoye.executors.disk).toEqual({ warn_pct: 70, refuse_pct: 90 });
  });

  it("deux champs indexés pour la palette, bornes du serveur dans le formulaire, rappel alerte < refus", () => {
    const chemins = CHAMPS_ADMIN.filter((c) => c.path.startsWith("disk.")).map((c) => [
      c.path,
      c.page,
      c.store,
    ]);
    expect(chemins.sort()).toEqual([
      ["disk.refuse_pct", "sandbox-limits", "exec"],
      ["disk.warn_pct", "sandbox-limits", "exec"],
    ]);
    const vue = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "components", "admin", "PageSandbox.vue"),
      "utf8",
    );
    expect(vue).toMatch(/id="sb-disk-warn"[\s\S]*?min="10"\s+max="99"/u);
    expect(vue).toMatch(/id="sb-disk-refuse"[\s\S]*?min="11"\s+max="100"/u);
    expect(vue).toContain("disk.warn_pct >= adm.execConfig.disk.refuse_pct");
  });
});
