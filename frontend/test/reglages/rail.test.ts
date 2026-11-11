// SPDX-License-Identifier: MIT
/** frontend/test/reglages/rail.test.ts — rail des Paramètres : groupes, recherche par libellé et mot-clé, sélection d'une section. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import RailParametres from "../../src/components/reglages/RailParametres.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { GROUPES_RAIL, filtrerRail } from "../../src/features/reglages/rail";

let app: App | null = null;
const appels: string[] = [];
afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

function monter(onglet = "profile"): {
  rg: { settingsTab: string; settingsSections: Record<string, string> };
  racine: HTMLElement;
} {
  const rg = reactive({ settingsTab: onglet, settingsSections: {} }) as unknown as {
    settingsTab: string;
    settingsSections: Record<string, string>;
  };
  const proxy = new Proxy(rg, {
    get(c, cle: string) {
      if (cle in c) return (c as Record<string, unknown>)[cle];
      return () => appels.push(cle);
    },
    set(c, cle: string, v: unknown) {
      (c as Record<string, unknown>)[cle] = v;
      return true;
    },
  });
  const racine = document.createElement("div");
  document.body.appendChild(racine);
  app = createApp({ render: () => h(RailParametres) });
  app.provide(CLE_REGLAGES, proxy as unknown as DomaineReglages);
  app.mount(racine);
  return { rg, racine };
}

describe("rail des Paramètres", () => {
  it("range les 14 entrées en quatre groupes par intention", () => {
    expect(GROUPES_RAIL.map((g) => g.titre)).toEqual(["Général", "Assistant", "Accès", "Avancé"]);
    expect(GROUPES_RAIL.flatMap((g) => g.entrees)).toHaveLength(14);
  });

  it("montre « Fonctionnalités » dans « Général », sans déplier « Avancé »", () => {
    const { racine } = monter();
    expect(GROUPES_RAIL[0]!.entrees.map((e) => e.id)).toContain("features");
    expect(racine.querySelector("nav")!.textContent).toContain("Fonctionnalités");
  });

  it("trouve un réglage par son libellé, sans accent ni casse", () => {
    const ids = (q: string): string[] => filtrerRail(q).flatMap((g) => g.entrees.map((e) => e.id));
    expect(ids("habillage")).toEqual(["appearance"]);
    expect(ids("TOKEN")).toEqual(["secrets", "connectors", "usage"]);
    expect(ids("Connexions")).toEqual(["secrets"]);
    expect(ids("Jetons d'accès")).toEqual(["secrets"]);
    expect(ids("memoire")).toEqual(["memory"]);
    expect(ids("zzz")).toEqual([]);
  });

  it("trouve aussi par une section, et l'ouvre", async () => {
    const ids = (q: string): string[] => filtrerRail(q).flatMap((g) => g.entrees.map((e) => e.id));
    expect(ids("mascotte")).toEqual(["appearance"]);
    expect(ids("dictee")).toEqual(["chat"]);
    expect(ids("indentation")).toEqual(["features"]);
    const { rg, racine } = monter();
    const champ = racine.querySelector<HTMLInputElement>("[data-rail-recherche]")!;
    champ.value = "mascotte";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    racine.querySelector<HTMLButtonElement>("nav button")!.click();
    await nextTick();
    expect(rg.settingsTab).toBe("appearance");
    expect(rg.settingsSections["appearance"]).toBe("mascotte");
  });

  it("filtre le rail, affiche l'absence de résultat et ouvre « Avancé » en recherche", async () => {
    const { racine } = monter();
    expect(racine.querySelector("nav")!.textContent).not.toContain("Sandbox");
    const champ = racine.querySelector<HTMLInputElement>("[data-rail-recherche]")!;
    champ.value = "contexte";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    expect(racine.querySelector("nav")!.textContent).toContain("Compaction");
    expect(racine.querySelector("nav")!.textContent).not.toContain("Profil");
    champ.value = "zzz";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    expect(racine.textContent).toContain("Aucun réglage trouvé.");
  });

  it("choisit une section et charge ses données ; icônes masquées aux lecteurs d'écran", async () => {
    const { rg, racine } = monter();
    const bouton = [...racine.querySelectorAll("nav button")].find((b) =>
      b.textContent?.includes("Secrets"),
    ) as HTMLButtonElement;
    bouton.click();
    await nextTick();
    expect(rg.settingsTab).toBe("secrets");
    expect(appels).toContain("loadSecrets");
    expect(appels).toContain("loadConnexions");
    expect(bouton.getAttribute("aria-current")).toBe("page");
    expect(
      [...racine.querySelectorAll("nav i.ph")].every((i) => i.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
  });
});
