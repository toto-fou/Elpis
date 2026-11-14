// SPDX-License-Identifier: MIT
/** frontend/test/reglages/secrets-sections.test.ts — Paramètres › Secrets : sections « Secrets web », « Comptes Git », « Jetons MCP » et « Remote », anciens onglets « connexions » et « connectors » qui mènent à leur section, recherche fusionnée. */
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
vi.mock("../../src/components/reglages/onglets/OngletConnecteurs.vue", async () => {
  const { defineComponent, h: rendu } = await import("vue");
  return { default: defineComponent({ render: () => rendu("div", { "data-page": "git" }) }) };
});
vi.mock("../../src/components/reglages/onglets/OngletConnexions.vue", async () => {
  const { defineComponent, h: rendu } = await import("vue");
  return {
    default: defineComponent({
      props: { genre: { type: String, required: true } },
      setup: (p) => () => rendu("div", { "data-page": p.genre === "opencode" ? "remote" : "jetons" }),
    }),
  };
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

describe("Secrets : quatre sections", () => {
  it("« Secrets web », « Comptes Git », « Jetons MCP » puis « Remote », chacune avec son aide ; plus d'entrée « connexions » ni « connectors »", () => {
    const l = sectionsVisibles(contexte(), "secrets");
    expect(l.map((s) => [s.id, s.libelle])).toEqual([
      ["web", "Secrets web"],
      ["git", "Comptes Git"],
      ["jetons", "Jetons MCP"],
      ["remote", "Remote"],
    ]);
    expect(l[0]!.aide).toContain("il n'en voit jamais la valeur");
    expect(l[1]!.aide).toContain("GitHub, GitLab, Bitbucket, Gitea");
    expect(l[2]!.aide).toContain("(MCP, OpenAPI)");
    expect(l[3]!.aide).toContain("un par poste relié");
    expect(sectionCourante(contexte(), "secrets")?.id).toBe("web");
    expect(sectionCourante(contexte({ secrets: "jetons" }), "secrets")?.id).toBe("jetons");
    expect(GROUPES_RAIL.flatMap((g) => g.entrees).some((e) => e.id === "connexions")).toBe(false);
    expect(GROUPES_RAIL.flatMap((g) => g.entrees).some((e) => e.id === "connectors")).toBe(false);
    expect(sectionCourante(contexte({ secrets: "git" }), "secrets")?.id).toBe("git");
  });

  it("la recherche des anciennes entrées mène à Secrets, et à la bonne section", () => {
    for (const q of [
      "Jetons d'accès",
      "Connexions",
      "Connecteurs",
      "Comptes Git",
      "token",
      "mcp",
      "openapi",
      "coffre",
    ])
      expect(ids(q), q).toContain("secrets");
    expect(sectionTrouvee("secrets", "openapi")).toBe("jetons");
    expect(sectionTrouvee("secrets", "appairage")).toBe("remote");
    // « opencode » : la configuration du client MCP est dans Jetons MCP, première des deux parties qui en parlent.
    expect(sectionTrouvee("secrets", "opencode")).toBe("jetons");
    expect(sectionTrouvee("secrets", "poste")).toBe("remote");
    expect(sectionTrouvee("secrets", "github")).toBe("git");
    expect(sectionTrouvee("secrets", "Comptes Git")).toBe("git");
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
    chargerOnglet: vi.fn(async () => undefined),
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
    document.querySelector<HTMLButtonElement>('[data-sous-menu] [data-section="remote"]')!.click();
    await nextTick();
    expect(rg.settingsSections["secrets"]).toBe("remote");
    expect(pages()).toEqual(["remote"]);
    document.querySelector<HTMLButtonElement>('[data-sous-menu] [data-section="git"]')!.click();
    await nextTick();
    expect(pages()).toEqual(["git"]);
    document.querySelector<HTMLButtonElement>('[data-sous-menu] [data-section="web"]')!.click();
    await nextTick();
    expect(pages()).toEqual(["web"]);
  });

  it("un settingsTab « connectors » posé tel quel atterrit sur Secrets › Comptes Git", async () => {
    const { rg } = monterModale("connectors");
    await nextTick();
    await nextTick();
    expect(rg.settingsTab).toBe("secrets");
    expect(rg.settingsSections["secrets"]).toBe("git");
    expect(pages()).toEqual(["git"]);
    expect(rg.chargerOnglet).toHaveBeenCalledWith("secrets");
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

  it("« connectors » (ancien lien) et « secrets:git » ouvrent Secrets › Comptes Git et chargent les comptes", async () => {
    for (const tab of ["connectors", "secrets:git"]) {
      const { m, dep } = await ouvrir(tab);
      expect(m.settingsTab.value, tab).toBe("secrets");
      expect(m.settingsSections.value["secrets"], tab).toBe("git");
      expect(dep.loadGitConnectors, tab).toHaveBeenCalled();
    }
  });

  it("chargerOnglet d'un ancien identifiant charge les listes de son onglet", async () => {
    const { m, dep } = await ouvrir("profile");
    expect(dep.loadGitConnectors).not.toHaveBeenCalled();
    await m.chargerOnglet("connectors");
    expect(dep.loadGitConnectors).toHaveBeenCalledTimes(1);
    expect(dep.loadSecrets).toHaveBeenCalledTimes(1);
  });

  it("« secrets:jetons », « secrets:remote » et « secrets:web » ciblent la section", async () => {
    expect((await ouvrir("secrets:jetons")).m.settingsSections.value["secrets"]).toBe("jetons");
    expect((await ouvrir("secrets:remote")).m.settingsSections.value["secrets"]).toBe("remote");
    expect((await ouvrir("secrets:web")).m.settingsSections.value["secrets"]).toBe("web");
  });
});

describe("sous-menu", () => {
  it("Secrets a un bandeau à quatre éléments", async () => {
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
    expect(hote.querySelectorAll("[data-sous-menu] nav button")).toHaveLength(4);
  });
});
