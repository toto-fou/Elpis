// SPDX-License-Identifier: MIT
/** frontend/test/reglages/fermeture.test.ts — une seule façon de fermer une fenêtre : la croix d'en-tête (Paramètres, serveurs MCP), plus de bouton « Fermer » en pied ; le statut des Paramètres passe dans l'en-tête, dans les deux interfaces. */
import { createApp, h, nextTick } from "vue";
import type { App, Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ModaleMcp from "../../src/components/reglages/ModaleMcp.vue";
import ModaleReglages from "../../src/components/reglages/ModaleReglages.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import { appels, etat } from "../chat/page/montage";

vi.mock("../../src/components/skills/OngletSkills.vue", async () => {
  const { defineComponent, h: rendu } = await import("vue");
  return { default: defineComponent({ render: () => rendu("div") }) };
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

function monter(composant: Component, rg: object): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(composant) });
  app.config.warnHandler = () => {};
  app.provide(CLE_REGLAGES, rg as never);
  app.mount(hote);
  return hote;
}

const boutonsFermer = (hote: HTMLElement): HTMLElement[] =>
  [...hote.querySelectorAll<HTMLElement>("button")].filter((b) =>
    /^Fermer$/.test((b.textContent ?? "").trim()),
  );

describe("Paramètres", () => {
  it("la croix seule, statut dans l'en-tête quand il y a quelque chose à dire", async () => {
    const rg = etat<Record<string, unknown>>({
      showSettingsModal: true,
      settingsTab: "aucun",
      settingsDirty: false,
      memoryDirty: false,
      settings: {},
      user: { username: "alice", is_admin: false },
      features: {},
      avatarARecadrer: null,
    });
    const hote = monter(ModaleReglages, rg);
    const dialogue = document.querySelector('[role="dialog"][aria-label="Paramètres"]') as HTMLElement;
    expect(boutonsFermer(dialogue)).toEqual([]);
    const croix = dialogue.querySelector('button[aria-label="Fermer les paramètres"]') as HTMLButtonElement;
    expect(croix.title).toBe("Fermer");
    const statut = dialogue.querySelector('[role="status"][data-etat-parametres]') as HTMLElement;
    expect(statut.textContent?.trim()).toBe("");
    expect(statut.parentElement?.contains(croix)).toBe(true);
    rg["settingsDirty"] = true;
    await nextTick();
    expect(statut.textContent?.trim()).toBe("Modifications non enregistrées");
    croix.click();
    expect(appels.map((a) => a[0])).toContain("closeSettings");
    expect(hote).toBeTruthy();
  });
});

describe("serveurs MCP", () => {
  it("la croix seule, plus de pied", () => {
    const rg = etat<Record<string, unknown>>({
      showMcpManagerModal: true,
      settings: { mcp_servers: [] },
      user: { username: "alice", role: "user" },
      sharedMcpServers: [],
      mcpListePerso: [],
      mcpListePartages: [],
      pinnedServers: [],
      mcpSearch: "",
      mcpSel: null,
      mcpForm: null,
      mcpTests: {},
    });
    monter(ModaleMcp, rg);
    const dialogue = document.querySelector('[role="dialog"][aria-labelledby="mcp-titre"]') as HTMLElement;
    expect(dialogue.querySelector("#mcp-titre")?.textContent?.trim()).toBe("Serveurs MCP");
    expect(boutonsFermer(dialogue)).toEqual([]);
    const croix = dialogue.querySelector('button[aria-label="Fermer"]') as HTMLButtonElement;
    expect(croix.title).toBe("Fermer");
    croix.click();
    expect(appels.map((a) => a[0])).toContain("closeMcpManager");
  });
});
