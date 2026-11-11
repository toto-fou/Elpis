// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/catalogue-plus.test.ts — « + » en catalogue : entrées et raccourcis « / », sous-menus Skills, Prompts et Gabarits, mode plan, compactage, puce Images ; l'alerte de contexte propose Compacter d'abord. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import AlerteContexte from "../../../src/components/chat/page/AlerteContexte.vue";
import CataloguePlus from "../../../src/components/chat/page/CataloguePlus.vue";
import PucesComposeur from "../../../src/components/chat/page/PucesComposeur.vue";
import { CLE_COMPOSEUR, CLE_IMAGE, CLE_MODELES, CLE_PAGE } from "../../../src/features/chat/page/domaines";
import { appelsDe, demonter, etat, monter, noms } from "./montage";

afterEach(demonter);

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;

function composeur(extra: Record<string, unknown> = {}) {
  return etat({
    showComposerPlus: true,
    showSharedPrompts: false,
    inboxCount: 2,
    imageAvailable: true,
    imageMode: false,
    isStreaming: false,
    currentChatId: "c1",
    planMode: false,
    pinnedSkills: [{ name: "revue-code" }],
    skillsByScope: {
      user: [{ name: "revue-code", description: "Relire" }],
      global: [{ name: "migration-sql" }, { name: "revue-code" }],
    },
    savedPromptsList: [{ id: 1, title: "Résumé", content: "Résume ce fil." }],
    templatesAll: [{ name: "bug", title: "Rapport de bug", content: "{{x}}" }],
    sharedPromptsList: [],
    sharedSelected: [],
    sharedSelectMode: false,
    ...extra,
  });
}

function monterCatalogue(comp = composeur(), p = etat({ inputMessage: "Bonjour", inputRef: null })) {
  const hote = monter(CataloguePlus, [
    [cle(CLE_COMPOSEUR), comp],
    [cle(CLE_PAGE), p],
  ]);
  return { hote, comp, p };
}

const texte = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("catalogue du « + »", () => {
  it("joindre, partages reçus, insérer (avec la commande « / »), conversation ; ni Images ni Collections", () => {
    const { hote } = monterCatalogue();
    const menu = hote.querySelector('[role="menu"]') as HTMLElement;
    const entrees = [...menu.querySelectorAll("[role^='menuitem']")].map((e) =>
      [...e.children].map(texte).filter(Boolean).join(" "),
    );
    expect(entrees).toEqual([
      "Joindre un fichier",
      "Partages reçus 2",
      "Skills /skills",
      "Prompts /prompt",
      "Gabarits /template",
      "Mode plan /plan",
      "Compacter /compact",
    ]);
    expect(texte(menu)).not.toMatch(/Images|Collections/);
  });

  it("Skills › : sous-menu d'un niveau, skills cochables (épingler et retirer), flèche gauche pour revenir", async () => {
    const { hote, comp } = monterCatalogue();
    const skills = hote.querySelector('[data-sous="skills"]') as HTMLElement;
    skills.focus();
    skills.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(noms()).toContain("loadAllSkills");
    const sous = hote.querySelector('[data-sous-menu="skills"]') as HTMLElement;
    expect(sous.getAttribute("role")).toBe("menu");
    const cases = [...sous.querySelectorAll('[role="menuitemcheckbox"]')] as HTMLElement[];
    expect(cases.map(texte)).toEqual(["revue-code", "migration-sql"]);
    expect(cases.map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(document.activeElement).toBe(cases[0]);
    cases[1]?.click();
    expect((comp as unknown as { pinnedSkills: { name: string }[] }).pinnedSkills.map((s) => s.name)).toEqual(
      ["revue-code", "migration-sql"],
    );
    cases[0]?.click();
    expect(appelsDe("removePinnedSkill")).toEqual([["revue-code"]]);
    sous.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await nextTick();
    await nextTick();
    expect(hote.querySelector('[data-sous-menu="skills"]')).toBeNull();
    expect(document.activeElement).toBe(skills);
  });

  it("Prompts › ajoute au brouillon sans l'écraser ; Gabarits › ouvre le gabarit ; le menu se ferme", async () => {
    const { hote, comp, p } = monterCatalogue();
    (hote.querySelector('[data-sous="prompts"]') as HTMLElement).click();
    await nextTick();
    (hote.querySelector('[data-sous-menu="prompts"] [role="menuitem"]') as HTMLElement).click();
    expect((p as unknown as { inputMessage: string }).inputMessage).toBe("Bonjour\n\nRésume ce fil.");
    expect((comp as unknown as { showComposerPlus: boolean }).showComposerPlus).toBe(false);
    (comp as unknown as { showComposerPlus: boolean }).showComposerPlus = true;
    await nextTick();
    (hote.querySelector('[data-sous="gabarits"]') as HTMLElement).click();
    await nextTick();
    (hote.querySelector('[data-sous-menu="gabarits"] [role="menuitem"]') as HTMLElement).click();
    expect(appelsDe("openTemplate")[0]?.[0]).toMatchObject({ name: "bug" });
  });

  it("Mode plan se coche ; Compacter lance la compaction ; hors génération seulement", async () => {
    const { hote } = monterCatalogue();
    const plan = hote.querySelector("[data-catalogue-plan]") as HTMLElement;
    expect(plan.getAttribute("aria-checked")).toBe("false");
    plan.click();
    (hote.querySelector("[data-catalogue-compacter]") as HTMLElement).click();
    expect(appelsDe("setPlanMode")).toEqual([[true]]);
    expect(noms()).toContain("manualCompress");
    demonter();
    const occupe = monterCatalogue(composeur({ isStreaming: true }));
    (occupe.hote.querySelector("[data-catalogue-plan]") as HTMLElement).click();
    (occupe.hote.querySelector("[data-catalogue-compacter]") as HTMLElement).click();
    expect(noms()).not.toContain("setPlanMode");
    expect(noms()).not.toContain("manualCompress");
  });

  it("fermé par Échap ou clic extérieur : focus rendu au « + » ; fermé par un choix : non", async () => {
    const { hote, comp } = monterCatalogue();
    const etatComp = comp as unknown as { showComposerPlus: boolean };
    (hote.querySelector('[role="menuitem"]') as HTMLElement).focus();
    etatComp.showComposerPlus = false;
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(hote.querySelector("[data-catalogue-plus]"));
    etatComp.showComposerPlus = true;
    await nextTick();
    const joindre = hote.querySelector('[role="menuitem"]') as HTMLElement;
    joindre.focus();
    joindre.click();
    await nextTick();
    await nextTick();
    expect(noms()).toContain("triggerFileUpload");
    expect(document.activeElement).not.toBe(hote.querySelector("[data-catalogue-plus]"));
  });

  it("mode Images actif : puce « Images » refermable dans la rangée de puces", () => {
    const p = etat({ planMode: false, imageMode: true, todoPanelOpen: false, todoList: [] });
    const hote = monter(PucesComposeur, [
      [cle(CLE_PAGE), p],
      [cle(CLE_MODELES), etat({ imageMode: true, liveGen: null, ctxUsage: null })],
      [
        cle(CLE_IMAGE),
        etat({
          imageMode: true,
          imageOpts: { fixed: "", n: 1 },
          imageFixedSizes: [],
          imageSides: [],
          imageMaxN: 1,
          imageSize: () => ({ w: 1024, h: 1024 }),
        }),
      ],
    ]);
    const puce = hote.querySelector('button[aria-label="Quitter le mode Images"]') as HTMLElement;
    expect(puce.closest("[data-puces-composeur]")).not.toBeNull();
    puce.click();
    expect(noms()).toContain("closeImageMode");
  });
});

describe("alerte de contexte", () => {
  it("« Compacter » d'abord, puis « Nouveau chat » ; Compacter désactivé pendant une génération", async () => {
    const comp = composeur({ conversationTooLong: true, ctxRealPct: 92 });
    const hote = monter(AlerteContexte, [[cle(CLE_COMPOSEUR), comp]]);
    const boutons = [...hote.querySelectorAll("button")];
    expect(boutons.map(texte)).toEqual(["Compacter", "Nouveau chat"]);
    expect(texte(hote)).toContain("92 %");
    boutons[0]?.click();
    expect(noms()).toEqual(["manualCompress"]);
    (comp as unknown as { isStreaming: boolean }).isStreaming = true;
    await nextTick();
    expect((hote.querySelector("[data-alerte-compacter]") as HTMLButtonElement).disabled).toBe(true);
  });
});
