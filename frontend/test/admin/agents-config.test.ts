// SPDX-License-Identifier: MIT
/** frontend/test/admin/agents-config.test.ts — console › Sandbox › Sous-agents : lecture seule (défaut, imposition) et réflexion par type, budget de réflexion et plafonds par tour lus, modifiés, enregistrés par `/api/admin/agents`, page du registre, champs indexés pour la palette, rendu des interrupteurs. */
import {
  BORNES_BUDGET_REFLEXION_AGENTS,
  BORNES_JETONS_ENFANTS_AGENTS,
  BORNES_DELAI_FOND_AGENTS,
  BORNES_TACHES_PAR_TOUR_AGENTS,
  DEFAUTS_REGLAGES_AGENTS,
  TYPES_AGENTS_REGLABLES,
} from "@elpis/contracts";
import type { ReglagesAgents } from "@elpis/contracts";
import * as Vue from "vue";
import { createApp, h, nextTick, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageSousAgents from "../../src/components/admin/PageSousAgents.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { CHAMPS_ADMIN } from "../../src/features/admin/champs.gen";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import { NAV_ADMIN } from "../../src/features/admin/registre";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const copie = (r: ReglagesAgents): ReglagesAgents => JSON.parse(JSON.stringify(r)) as ReglagesAgents;

function monter(refusPost?: string) {
  const corps: unknown[] = [];
  const toasts: string[] = [];
  let stocke = copie(DEFAUTS_REGLAGES_AGENTS);
  const route = (url: string, init?: RequestInit): Response => {
    if (url === "/api/admin/agents" && init?.method === "POST") {
      corps.push(JSON.parse(String(init.body)));
      if (refusPost) return json({ detail: refusPost }, 400);
      stocke = (corps.at(-1) as { agents: ReglagesAgents }).agents;
      return json({ ok: true, config: stocke });
    }
    if (url === "/api/admin/agents")
      return json({
        config: stocke,
        types: [...TYPES_AGENTS_REGLABLES],
        bounds: {
          thinking_budget_tokens: [512, 131072],
          max_tasks_per_turn: [1, 100],
          max_child_tokens_per_turn: [10000, 50000000],
          background_timeout_s: [300, 21600],
        },
      });
    return json({});
  };
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => Promise.resolve(route(url, init));
  const refs: RefsAdmin = {
    user: ref({ username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: (m) => toasts.push(m),
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  return { A, corps, toasts };
}

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("console › Sandbox › Sous-agents", () => {
  it("page « Sous-agents » de l'entrée Sandbox : bloc `agents`, chargeur, chemins `agents.`", () => {
    const page = NAV_ADMIN.pages["sandbox-agents"];
    expect(page).toMatchObject({ label: "Sous-agents", entry: "sandbox", role: "admin", stores: ["agents"] });
    expect(page?.loaders).toEqual([["loadAgentsConfig"]]);
    expect(NAV_ADMIN.pageForPath("agents.read_only.forced.explore")).toBe("sandbox-agents");
  });

  it("lecture : défauts du contrat avant réponse, puis réglages servis par le core", async () => {
    const { A } = monter();
    expect(A.agentsConfig.value).toEqual(DEFAUTS_REGLAGES_AGENTS);
    await A.loadAgentsConfig();
    expect(A.agentsConfig.value.read_only.defaults.explore).toBe(true);
    expect(A.agentsBoundsTaches.value).toEqual([1, 100]);
    expect(A.agentsBoundsReflexion.value).toEqual([512, 131072]);
  });

  it("imposer explore : une modification sur la page, section entière envoyée au POST", async () => {
    const { A, corps } = monter();
    A.adminTab.value = "sandbox-agents";
    await A.loadAgentsConfig();
    A.agentsConfig.value.read_only.forced.explore = true;
    A.agentsConfig.value.max_tasks_per_turn = 5;
    await nextTick();
    expect(A.adminPageChanges.value.map((c) => [c.store, c.path])).toEqual([
      ["agents", "read_only.forced.explore"],
      ["agents", "max_tasks_per_turn"],
    ]);
    expect(await A.saveAdminPage()).toBe(true);
    const envoye = corps[0] as { agents: ReglagesAgents };
    expect(envoye.agents.read_only.forced).toEqual({
      ...DEFAUTS_REGLAGES_AGENTS.read_only.forced,
      explore: true,
    });
    expect(envoye.agents.max_tasks_per_turn).toBe(5);
    expect(A.adminDirtyCount.value).toBe(0);
  });

  it("retour arrière d'un champ et refus du core (400) : message affiché, page toujours modifiée", async () => {
    const { A, toasts } = monter("agents.max_tasks_per_turn doit être entre 1 et 100");
    A.adminTab.value = "sandbox-agents";
    await A.loadAgentsConfig();
    A.agentsConfig.value.read_only.defaults.pr = true;
    await nextTick();
    const [modif] = A.adminPageChanges.value;
    if (modif) A.revertAdminChange(modif);
    expect(A.agentsConfig.value.read_only.defaults.pr).toBe(false);
    A.agentsConfig.value.max_tasks_per_turn = 101;
    expect(await A.saveAdminPage()).toBe(false);
    expect(toasts.some((t) => t.includes("entre 1 et 100"))).toBe(true);
    expect(A.adminDirtyCount.value).toBe(1);
  });

  it("palette : trois champs par type (défaut, imposition, réflexion), budget de réflexion et session web, sur la page Sous-agents", () => {
    const chemins = CHAMPS_ADMIN.filter((c) => c.store === "agents")
      .map((c) => c.path)
      .sort();
    const attendus = TYPES_AGENTS_REGLABLES.flatMap((t) => [
      `read_only.defaults.${t}`,
      `read_only.forced.${t}`,
      `thinking.defaults.${t}`,
    ]).concat(
      "thinking_budget_tokens",
      "max_tasks_per_turn",
      "max_child_tokens_per_turn",
      "background_timeout_s",
      "user_browser_session_allowed",
    );
    expect(chemins).toEqual(attendus.sort());
    expect(CHAMPS_ADMIN.filter((c) => c.store === "agents").every((c) => c.page === "sandbox-agents")).toBe(
      true,
    );
    const imposer = CHAMPS_ADMIN.find((c) => c.path === "read_only.forced.explore");
    expect(imposer).toMatchObject({ label: "explore", control: "Imposer" });
  });

  it("rendu : interrupteurs liés aux réglages, bornes du serveur, rappel hors bornes", async () => {
    const domaine = reactive({
      adminTab: "sandbox-agents",
      agentsConfig: copie(DEFAUTS_REGLAGES_AGENTS),
      agentsBoundsReflexion: [...BORNES_BUDGET_REFLEXION_AGENTS],
      agentsBoundsTaches: [...BORNES_TACHES_PAR_TOUR_AGENTS],
      agentsBoundsJetons: [...BORNES_JETONS_ENFANTS_AGENTS],
      agentsBoundsDelaiFond: [...BORNES_DELAI_FOND_AGENTS],
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(PageSousAgents) });
    app.provide(CLE_ADMIN, domaine as never);
    app.mount(hote);
    await nextTick();
    const champ = (id: string) => hote.querySelector<HTMLInputElement>("#" + id);
    expect(champ("ag-ro-defaut-explore")?.checked).toBe(true);
    expect(champ("ag-ro-impose-explore")?.checked).toBe(false);
    expect(hote.querySelectorAll("[data-agent-type]").length).toBe(2 * TYPES_AGENTS_REGLABLES.length);
    expect(hote.querySelector<HTMLSelectElement>("#ag-reflexion-verify")?.value).toBe("on");
    expect(hote.querySelector<HTMLSelectElement>("#ag-reflexion-custom")?.value).toBe("inherit");
    expect(champ("ag-reflexion-budget")?.min).toBe("512");
    champ("ag-ro-impose-explore")?.click();
    expect(domaine.agentsConfig.read_only.forced.explore).toBe(true);
    expect(champ("ag-parallele")).toBeNull();
    expect(champ("ag-fond-max")).toBeNull();
    expect(hote.querySelector('[role="alert"]')).toBeNull();
    domaine.agentsConfig.thinking_budget_tokens = 100;
    await nextTick();
    expect(hote.querySelector('[role="alert"]')?.textContent).toContain("de 512 à 131072");
  });

  it("noms accessibles : chaque interrupteur et liste porte le type d'agent qu'il règle", async () => {
    const domaine = reactive({
      adminTab: "sandbox-agents",
      agentsConfig: copie(DEFAUTS_REGLAGES_AGENTS),
      agentsBoundsReflexion: [...BORNES_BUDGET_REFLEXION_AGENTS],
      agentsBoundsTaches: [...BORNES_TACHES_PAR_TOUR_AGENTS],
      agentsBoundsJetons: [...BORNES_JETONS_ENFANTS_AGENTS],
      agentsBoundsDelaiFond: [...BORNES_DELAI_FOND_AGENTS],
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(PageSousAgents) });
    app.provide(CLE_ADMIN, domaine as never);
    app.mount(hote);
    await nextTick();
    const noms = [...hote.querySelectorAll("[data-agent-type] [aria-label]")].map((e) =>
      e.getAttribute("aria-label"),
    );
    expect(noms.length).toBe(3 * TYPES_AGENTS_REGLABLES.length);
    expect(new Set(noms).size).toBe(noms.length);
    expect(noms).toContain("Imposer : explore");
    expect(noms).toContain("Réflexion : Agents personnalisés");
  });
});
