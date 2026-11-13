// SPDX-License-Identifier: MIT
/** frontend/test/admin/etat-actualisation.test.ts — état d'actualisation de la Supervision : libellé et bouton inchangés pendant un sondage, seule l'icône tourne. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import EtatActualisation from "../../src/components/admin/EtatActualisation.vue";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("EtatActualisation", () => {
  it("pendant un sondage : même libellé, bouton actif à l'œil mais sans effet, état occupé annoncé", async () => {
    const etat = reactive({
      chargement: false,
      derniereMaj: Date.UTC(2026, 10, 13, 9, 30, 15) as number | null,
    });
    const clics: string[] = [];
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({
      render: () =>
        h(EtatActualisation, { ...etat, auto: true, cadence: "15 s", onActualiser: () => clics.push("a") }),
    });
    app.mount(hote);
    const libelle = (): string => hote.querySelector(".adm-maj__etat")?.textContent?.trim() ?? "";
    const bouton = (): HTMLButtonElement => hote.querySelector('button[aria-label="Actualiser maintenant"]')!;
    const avant = libelle();
    expect(avant).toMatch(/^Mis à jour à /u);

    etat.chargement = true;
    await nextTick();
    expect(libelle()).toBe(avant);
    expect(hote.querySelector(".adm-maj")?.getAttribute("aria-busy")).toBe("true");
    expect(hote.querySelector(".adm-maj__etat i")?.classList.contains("animate-spin")).toBe(true);
    expect(bouton().disabled).toBe(false);
    bouton().click();
    expect(clics).toEqual([]);

    etat.chargement = false;
    await nextTick();
    bouton().click();
    expect(clics).toEqual(["a"]);
    expect(hote.querySelector(".adm-maj")?.hasAttribute("aria-busy")).toBe(false);
  });
});
