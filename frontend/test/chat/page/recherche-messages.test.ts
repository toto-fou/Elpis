// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/recherche-messages.test.ts — recherche dans la conversation : résultat précédent et suivant en boucle (boutons, Entrée, Maj+Entrée), saut vers le message, fermeture par le bouton. */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import RechercheMessages from "../../../src/components/chat/page/RechercheMessages.vue";
import { CLE_CONVERSATION } from "../../../src/features/chat/page/domaines";
import { positionVoisine, rangsTrouves } from "../../../src/features/chat/page/recherche-messages";
import { appelsDe, demonter, etat, monter } from "./montage";

afterEach(demonter);

const MESSAGES = [
  { role: "user", content: "Migration Postgres" },
  { role: "assistant", content: "pg_dump puis restauration" },
  { role: "user", content: "et la POSTGRES 16 ?" },
];

describe("résultats", () => {
  it("rangs des messages trouvés (casse ignorée) ; voisin en boucle", () => {
    expect(rangsTrouves(MESSAGES, "postgres")).toEqual([0, 2]);
    expect(rangsTrouves(MESSAGES, "  ")).toEqual([]);
    expect([positionVoisine(-1, 2, 1), positionVoisine(-1, 2, -1)]).toEqual([0, 1]);
    expect([positionVoisine(1, 2, 1), positionVoisine(0, 2, -1)]).toEqual([0, 1]);
    expect(positionVoisine(0, 0, 1)).toBe(-1);
  });
});

describe("barre de recherche", () => {
  it("suivant, précédent, Entrée et Maj+Entrée sautent au message ; le compteur dit la position ; × ferme", async () => {
    const conv = etat({
      messageSearchActive: true,
      messageSearch: "postgres",
      messageSearchQ: "postgres",
      messageSearchCount: 2,
      messages: MESSAGES,
    });
    const hote = monter(RechercheMessages, [[CLE_CONVERSATION as InjectionKey<object>, conv]]);
    const compteur = () => hote.querySelector("[data-recherche-compteur]")?.textContent?.trim();
    expect(compteur()).toBe("2 résultat(s)");
    (hote.querySelector("[data-recherche-suivant]") as HTMLElement).click();
    await nextTick();
    expect(compteur()).toBe("1 / 2");
    const champ = hote.querySelector("input") as HTMLInputElement;
    champ.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await nextTick();
    expect(compteur()).toBe("2 / 2");
    champ.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    (hote.querySelector("[data-recherche-precedent]") as HTMLElement).click();
    await nextTick();
    expect(compteur()).toBe("2 / 2");
    expect(appelsDe("scrollToMessage")).toEqual([[0], [2], [0], [2]]);
    (hote.querySelector("[data-recherche-fermer]") as HTMLElement).click();
    expect([conv.messageSearchActive, conv.messageSearch]).toEqual([false, ""]);
  });

  it("aucun résultat : précédent et suivant désactivés", () => {
    const conv = etat({
      messageSearchActive: true,
      messageSearch: "zzz",
      messageSearchQ: "zzz",
      messageSearchCount: 0,
      messages: MESSAGES,
    });
    const hote = monter(RechercheMessages, [[CLE_CONVERSATION as InjectionKey<object>, conv]]);
    expect((hote.querySelector("[data-recherche-suivant]") as HTMLButtonElement).disabled).toBe(true);
    expect((hote.querySelector("[data-recherche-precedent]") as HTMLButtonElement).disabled).toBe(true);
  });
});
