// SPDX-License-Identifier: MIT
/** frontend/test/admin/sandbox-chargement.test.ts — console › Sandbox : réglages présentés seulement une fois lus du core (aucune saisie sur des valeurs par défaut écrasée ensuite). */
import * as Vue from "vue";
import { createApp, defineComponent, h, nextTick, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageSandbox from "../../src/components/admin/PageSandbox.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { DISQUE_PAR_DEFAUT, JOBS_PAR_DEFAUT } from "../../src/features/admin/etat";
import { chargementDe, reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
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
  jobs: { ...JOBS_PAR_DEFAUT, max_per_chat: 4 },
};

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  reinitialiserSuiviChargement();
});

function domaine(statuts: number[]) {
  const fetchFaux = (url: string): Promise<Response> => {
    if (url === "/api/admin/executors") {
      const statut = statuts.shift() ?? 200;
      return Promise.resolve(
        statut === 200 ? json({ config: CONFIG, image: "elpis/sandbox:1.0.0" }) : json({}, statut),
      );
    }
    return Promise.resolve(json({}));
  };
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url) => fetchFaux(url),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  return setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
}

function monter(tab: string, execCharge: boolean) {
  const adm = reactive({
    adminTab: tab,
    execCharge,
    execHealthcheck: null,
    execExtraArgsText: "",
    execConfig: {
      image: "elpis/sandbox:1.0.0",
      limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
      force_user_docker: false,
      idle_kill_hours: 24,
      network_profiles: [],
      exec_user: "10001:10001",
      runtime: "",
      extra_run_args: [],
      jobs: { ...JOBS_PAR_DEFAUT },
      disk: { ...DISQUE_PAR_DEFAUT },
    },
    netFields: [],
    toolhosts: null,
    sandboxContainers: [],
    staleNetContainers: [],
  }) as unknown as DomaineAdmin;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(defineComponent({ setup: () => () => h(PageSandbox) }));
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return { hote, adm };
}

describe("console › Sandbox : réglages lus avant d'être présentés", () => {
  it("le domaine ne se dit chargé qu'après une lecture réussie ; un échec est suivi avec « Réessayer »", async () => {
    const A = domaine([500, 200]);
    expect(A.execCharge.value).toBe(false);
    await A.loadExecConfig();
    expect(A.execCharge.value).toBe(false);
    const [echec] = chargementDe(["loadExecConfig"]).echecs;
    expect(echec?.nom).toBe("loadExecConfig");
    await echec?.reessayer();
    expect(A.execCharge.value).toBe(true);
    expect(A.execConfig.value.jobs.max_per_chat).toBe(4);
    expect(chargementDe(["loadExecConfig"]).echecs).toEqual([]);
  });

  it.each(["sandbox-limits", "sandbox-network"])(
    "%s : pas de champ sur des valeurs par défaut tant que le core n'a pas répondu",
    async (tab) => {
      const { hote, adm } = monter(tab, false);
      expect(hote.querySelector(`#${tab}`)).toBeNull();
      expect(hote.querySelector("input, select, textarea")).toBeNull();
      expect(hote.querySelector('[aria-busy="true"]')).not.toBeNull();
      adm.execCharge = true;
      await nextTick();
      expect(hote.querySelector('[aria-busy="true"]')).toBeNull();
      expect(hote.querySelector(`#${tab}`)).not.toBeNull();
    },
  );
});
