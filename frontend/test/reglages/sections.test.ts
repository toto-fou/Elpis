// SPDX-License-Identifier: MIT
/** frontend/test/reglages/sections.test.ts — sous-menus de la modale : sections visibles selon le compte, section affichée et mémorisée, rendu du composant. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import SousMenuReglages from "../../src/components/reglages/SousMenuReglages.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { GROUPES_RAIL } from "../../src/features/reglages/rail";
import { sectionCourante, sectionsVisibles, sectionTrouvee } from "../../src/features/reglages/sections";
import type { ContexteSections } from "../../src/features/reglages/sections";

const contexte = (extra: Partial<ContexteSections> = {}): ContexteSections => ({
  settingsSections: {},
  settings: { enable_editor: true, image_ready: true, image_prefs: {} },
  features: { voice_stt: true },
  mascottesOffertes: true,
  ...extra,
});
const ids = (c: ContexteSections, onglet: string): string[] => sectionsVisibles(c, onglet).map((s) => s.id);

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("sections visibles", () => {
  it("chaque section a un identifiant unique dans son onglet, un libellé et une aide", () => {
    for (const e of GROUPES_RAIL.flatMap((g) => g.entrees)) {
      const liste = e.sections ?? [];
      expect(new Set(liste.map((s) => s.id)).size, e.id).toBe(liste.length);
      for (const s of liste) expect(s.libelle && s.aide && s.icone, `${e.id}/${s.id}`).toBeTruthy();
    }
  });

  it("Skills se divise en Global et Perso, Global d'abord", () => {
    expect(ids(contexte(), "skills")).toEqual(["global", "perso"]);
    expect(sectionCourante(contexte(), "skills")?.id).toBe("global");
    expect(sectionTrouvee("skills", "learned")).toBe("global");
  });

  it("une entrée sans sections n'a pas de sous-menu", () => {
    expect(ids(contexte(), "profile")).toEqual([]);
    expect(sectionCourante(contexte(), "profile")).toBeNull();
  });

  it("masque ce que le compte ou l'instance n'a pas", () => {
    expect(ids(contexte(), "appearance")).toEqual(["theme", "editeur", "mascotte"]);
    expect(ids(contexte({ mascottesOffertes: false }), "appearance")).toEqual(["theme", "editeur"]);
    expect(ids(contexte({ features: {} }), "chat")).toEqual(["conversation", "affichage"]);
    expect(ids(contexte({ settings: {} }), "features")).toEqual(["modules"]);
    const coupe = contexte({ settings: { image_ready: true, image_prefs: {}, image_enabled: false } });
    expect(ids(coupe, "features")).not.toContain("images");
  });
});

describe("section affichée", () => {
  it("revient à la dernière choisie, et à la première si elle n'est plus visible", () => {
    const c = contexte({ settingsSections: { features: "editeur" } });
    expect(sectionCourante(c, "features")?.id).toBe("editeur");
    expect(sectionCourante({ ...c, settings: {} }, "features")?.id).toBe("modules");
    expect(sectionCourante(contexte(), "chat")?.id).toBe("conversation");
  });

  it("la recherche désigne la section, sans accent ni casse", () => {
    expect(sectionTrouvee("appearance", "MASCOTTE")).toBe("mascotte");
    expect(sectionTrouvee("appearance", "éditeur sombre")).toBe("editeur");
    expect(sectionTrouvee("chat", "dictée")).toBe("voix");
    expect(sectionTrouvee("chat", "")).toBeNull();
    expect(sectionTrouvee("profile", "x")).toBeNull();
  });
});

describe("composant", () => {
  function monter(onglet: string, extra: Partial<ContexteSections> = {}) {
    const rg = reactive({ settingsTab: onglet, ...contexte(extra) });
    const racine = document.createElement("div");
    document.body.appendChild(racine);
    app = createApp({ render: () => h(SousMenuReglages) });
    app.provide(CLE_REGLAGES, rg as unknown as DomaineReglages);
    app.mount(racine);
    return { rg, racine };
  }

  it("rien sans sections ; une section seule garde son bandeau, qui porte le titre et l'aide", () => {
    expect(monter("profile").racine.querySelector("[data-sous-menu]")).toBeNull();
    app?.unmount();
    const seule = monter("features", { settings: {} }).racine;
    expect(seule.querySelectorAll("[data-sous-menu] nav button")).toHaveLength(1);
  });

  it("masque le bandeau de Skills pendant le détail ou le formulaire d'un skill", async () => {
    const { rg, racine } = monter("skills");
    expect(racine.querySelector("[data-sous-menu]")).not.toBeNull();
    (rg as unknown as { skillEditMode: string }).skillEditMode = "create";
    await nextTick();
    expect(racine.querySelector("[data-sous-menu]")).toBeNull();
    (rg as unknown as { skillEditMode: string }).skillEditMode = "";
    await nextTick();
    expect(racine.querySelector("[data-sous-menu]")).not.toBeNull();
  });

  it("marque la section ouverte et la change au clic ; aucune liste déroulante", async () => {
    const { rg, racine } = monter("chat");
    const courant = (): string | undefined =>
      racine.querySelector<HTMLElement>('[aria-current="page"]')?.dataset["section"];
    expect(courant()).toBe("conversation");
    racine.querySelector<HTMLButtonElement>('[data-section="affichage"]')!.click();
    await nextTick();
    expect(rg.settingsSections["chat"]).toBe("affichage");
    expect(courant()).toBe("affichage");
    expect(racine.querySelector("select")).toBeNull();
    expect(
      [...racine.querySelectorAll("nav i.ph")].every((i) => i.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
  });

  it("montre l'aide de la section à la demande, la referme en changeant de section", async () => {
    const { racine } = monter("chat");
    const bouton = racine.querySelector<HTMLButtonElement>("[data-aide-bouton]")!;
    const ligne = racine.querySelector<HTMLElement>("[data-aide-ligne]")!;
    expect(bouton.getAttribute("aria-expanded")).toBe("false");
    expect(bouton.getAttribute("aria-controls")).toBe(ligne.id);
    expect(ligne.textContent).toContain("Comportement des conversations");
    bouton.click();
    await nextTick();
    expect(bouton.getAttribute("aria-expanded")).toBe("true");
    racine.querySelector<HTMLButtonElement>('[data-section="affichage"]')!.click();
    await nextTick();
    expect(bouton.getAttribute("aria-expanded")).toBe("false");
    expect(ligne.textContent).toContain("Présentation du fil");
  });
});
