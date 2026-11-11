// SPDX-License-Identifier: MIT
/** frontend/test/reglages/secrets-sections.test.ts — Paramètres › Secrets : sections « Secrets web » et « Jetons MCP », ancien onglet « connexions » qui mène à la seconde, recherche fusionnée. */
import * as Vue from "vue";
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModaleReglages from "../../src/components/reglages/ModaleReglages.vue";
import SousMenuReglages from "../../src/components/reglages/SousMenuReglages.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { creerModale } from "../../src/features/reglages/modale";
import { GROUPES_RAIL, filtrerRail } from "../../src/features/reglages/rail";
import { sectionCourante, sectionTrouvee, sectionsVisibles } from "../../src/features/reglages/sections";
import type { ContexteSections } from "../../src/features/reglages/sections";

vi.mock("../../src/components/skills/OngletSkills.vue", async () => {
  const { defineComponent, h: rendu } = await import("vue");
  return { default: defineComponent({ render: () => rendu("div") }) };
});
vi.mock("../../src/components/reglages/onglets/OngletSecrets.vue", async () => {
  const { defineComponent, h: rendu } = await import("vue");
  return { default: defineComponent({ render: () => rendu("div", { "data-page": "web" }) }) };
});
vi.mock("../../src/components/reglages/onglets/OngletConnexions.vue", async () => {
  const { defineComponent, h: rendu } = await import("vue");
  return { default: defineComponent({ render: () => rendu("div", { "data-page": "jetons" }) }) };
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const contexte = (sections: Record<string, string> = {}): ContexteSections => ({
  settingsSections: sections,
  settings: {},
  features: {},
  mascottesOffertes: false,
});
const ids = (q: string): string[] => filtrerRail(q).flatMap((g) => g.entrees.map((e) => e.id));

describe("Secrets : deux sections", () => {
  it("« Secrets web » d'abord, puis « Jetons MCP », chacune avec son aide ; plus d'entrée « connexions »", () => {
    const l = sectionsVisibles(contexte(), "secrets");
    expect(l.map((s) => [s.id, s.libelle])).toEqual([
      ["web", "Secrets web"],
      ["jetons", "Jetons MCP"],
    ]);
    expect(l[0]!.aide).toContain("il n'en voit jamais la valeur");
    expect(l[1]!.aide).toContain("MCP, OpenAPI, opencode");
    expect(sectionCourante(contexte(), "secrets")?.id).toBe("web");
    expect(sectionCourante(contexte({ secrets: "jetons" }), "secrets")?.id).toBe("jetons");
    expect(GROUPES_RAIL.flatMap((g) => g.entrees).some((e) => e.id === "connexions")).toBe(false);
    expect(GROUPES_RAIL.flatMap((g) => g.entrees).some((e) => e.id === "connectors")).toBe(true);
  });

  it("la recherche des deux anciennes entrées mène à Secrets, et à la bonne section", () => {
    for (const q of ["Jetons d'accès", "Connexions", "token", "mcp", "openapi", "coffre"])
      expect(ids(q), q).toContain("secrets");
    expect(sectionTrouvee("secrets", "openapi")).toBe("jetons");
    expect(sectionTrouvee("secrets", "Jetons d'accès")).toBeNull();
    expect(sectionTrouvee("secrets", "coffre")).toBe("web");
  });
});

function monterModale(settingsTab: string, sections: Record<string, string> = {}) {
  const rg = reactive({
    showSettingsModal: true,
    settingsTab,
    settingsSections: sections,
    settingsDirty: false,
    memoryDirty: false,
    settings: {},
    user: { username: "alice", is_admin: false },
    features: {},
    avatarARecadrer: null,
    mascottesOffertes: false,
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(ModaleReglages) });
  app.config.warnHandler = () => {};
  app.provide(CLE_REGLAGES, rg as never);
  app.mount(hote);
  return { rg, hote };
}
const pages = (): string[] =>
  [...document.querySelectorAll<HTMLElement>("[data-page]")].map((e) => e.dataset["page"]!);

describe("Secrets dans la modale", () => {
  it("affiche la page de la section choisie, le sous-menu bascule de l'une à l'autre", async () => {
    const { rg } = monterModale("secrets");
    await nextTick();
    expect(pages()).toEqual(["web"]);
    document.querySelector<HTMLButtonElement>('[data-sous-menu] [data-section="jetons"]')!.click();
    await nextTick();
    expect(rg.settingsSections["secrets"]).toBe("jetons");
    expect(pages()).toEqual(["jetons"]);
    document.querySelector<HTMLButtonElement>('[data-sous-menu] [data-section="web"]')!.click();
    await nextTick();
    expect(pages()).toEqual(["web"]);
  });

  it("un settingsTab « connexions » posé tel quel atterrit sur Secrets › Jetons MCP", async () => {
    const { rg } = monterModale("connexions");
    await nextTick();
    await nextTick();
    expect(rg.settingsTab).toBe("secrets");
    expect(rg.settingsSections["secrets"]).toBe("jetons");
    expect(pages()).toEqual(["jetons"]);
  });
});

describe("openSettingsTab", () => {
  async function ouvrir(tab: string) {
    const refs = { user: Vue.ref(null), settings: Vue.ref({}) };
    const dep = {
      loadAppSkins: vi.fn(async () => true),
      loadSharedMcpServers: vi.fn(async () => {}),
      reinitialiserEpingles: vi.fn(),
      loadSavedPrompts: vi.fn(async () => {}),
      loadSharedPrompts: vi.fn(async () => {}),
      loadPromptTemplates: vi.fn(async () => {}),
      loadArchives: vi.fn(async () => {}),
      loadLlmConnectors: vi.fn(async () => {}),
      loadUsageData: vi.fn(async () => {}),
      loadUserMemory: vi.fn(async () => {}),
      loadSandboxState: vi.fn(async () => {}),
      loadGitConnectors: vi.fn(async () => {}),
      loadConnexions: vi.fn(async () => {}),
      loadSecrets: vi.fn(async () => {}),
      cnxReset: vi.fn(),
      cancelMemoryEdit: vi.fn(),
      startNewTemplate: vi.fn(),
      stopSandboxPolling: vi.fn(),
      reinitialisations: [],
      etatsSales: [],
    };
    const ctx = { showToast: vi.fn(), fetchAuth: vi.fn(async () => null), openConfirm: vi.fn() };
    const persistance = {
      snapshot: Vue.ref(""),
      viderEnAttente: vi.fn(async () => {}),
      passwordSaving: Vue.ref(false),
    };
    const m = creerModale(
      Vue as never,
      refs as never,
      ctx as never,
      persistance as never,
      Vue.ref(false),
      dep as never,
    );
    await m.openSettingsTab(tab);
    return { m, dep };
  }

  it("« connexions » (ancien lien) ouvre Secrets › Jetons MCP et charge les deux listes", async () => {
    const { m, dep } = await ouvrir("connexions");
    expect(m.settingsTab.value).toBe("secrets");
    expect(m.settingsSections.value["secrets"]).toBe("jetons");
    expect(dep.loadConnexions).toHaveBeenCalled();
    expect(dep.loadSecrets).toHaveBeenCalled();
  });

  it("« secrets:jetons » et « secrets:web » ciblent la section", async () => {
    expect((await ouvrir("secrets:jetons")).m.settingsSections.value["secrets"]).toBe("jetons");
    expect((await ouvrir("secrets:web")).m.settingsSections.value["secrets"]).toBe("web");
  });
});

describe("sous-menu", () => {
  it("Secrets a un bandeau à deux éléments", async () => {
    const rg = reactive({
      settingsTab: "secrets",
      settingsSections: {},
      settings: {},
      features: {},
      mascottesOffertes: false,
    });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(SousMenuReglages) });
    app.provide(CLE_REGLAGES, rg as never);
    app.mount(hote);
    expect(hote.querySelectorAll("[data-sous-menu] nav button")).toHaveLength(2);
  });
});
