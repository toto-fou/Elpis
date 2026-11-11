// SPDX-License-Identifier: MIT
/** frontend/test/reglages/choix-editeur.test.ts — choix de l'éditeur dans Apparence : liste pleine largeur, libellé au-dessus, explication dessous, liée à la liste. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ChoixEditeur from "../../src/components/reglages/ChoixEditeur.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { AIDE_SKIN_SANS_EDITEUR } from "../../src/features/editor/interface";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(feuille = "/static/css/skins/elpis/editeur.css") {
  const rg = reactive({ settings: {} as { editor_ui?: string }, skinCourant: { editor_css_url: feuille } });
  const racine = document.createElement("div");
  document.body.appendChild(racine);
  app = createApp({ render: () => h(ChoixEditeur, { idChamp: "champ" }) });
  app.provide(CLE_REGLAGES, rg as unknown as DomaineReglages);
  app.mount(racine);
  const liste = racine.querySelector("select");
  if (!liste) throw new Error("liste absente");
  return { rg, racine, liste };
}

describe("choix de l'éditeur", () => {
  it("liste pleine largeur à la taille normale, libellé au-dessus, explication dessous", () => {
    const { racine, liste } = monter();
    expect(liste.classList.contains("w-full")).toBe(true);
    expect(liste.classList.contains("set-control--sm")).toBe(false);
    expect(racine.querySelector('label[for="champ"]')?.textContent).toBe("Éditeur");
    expect(liste.getAttribute("aria-describedby")).toBe("champ-aide");
    expect(racine.querySelector("#champ-aide")?.textContent).toContain("fourni par le skin");
  });

  it("selon le skin par défaut, puis classique au choix", async () => {
    const { rg, racine, liste } = monter();
    expect(liste.value).toBe("skin");
    liste.value = "classic";
    liste.dispatchEvent(new Event("change"));
    await nextTick();
    expect(rg.settings.editor_ui).toBe("classic");
    expect(racine.querySelector("#champ-aide")?.textContent).toContain("quel que soit le skin");
  });

  it("explique qu'un skin sans feuille d'éditeur reste classique", () => {
    const { racine } = monter("");
    expect(racine.querySelector("#champ-aide")?.textContent).toBe(AIDE_SKIN_SANS_EDITEUR);
  });
});
