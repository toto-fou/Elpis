// SPDX-License-Identifier: MIT
/** frontend/test/reglages/onglet-apparence-perso.test.ts — Paramètres › Apparence › Mes habillages : masquée si la fonction est coupée, menu groupé, Aperçu, Supprimer, assistant. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import OngletApparence from "../../src/components/reglages/onglets/OngletApparence.vue";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const INSTANCE = { id: "elpis", label: "Elpis", desc: "", builtin: true, sw: [] };
const PERSO = {
  id: "perso:a",
  label: "Mon A",
  desc: "",
  builtin: false,
  perso: true,
  sw: ["#111", "#222", "#333"],
};

function monter(over: Record<string, unknown>) {
  const fonctions = {
    chargerSkinsPerso: vi.fn(),
    ouvrirAssistant: vi.fn(),
    apercuHabillage: vi.fn(),
    supprimerHabillage: vi.fn(),
  };
  const etat = reactive({
    settings: { skin: "elpis" },
    APP_SKINS: [INSTANCE],
    skinCourant: INSTANCE,
    themeMode: "light",
    persoDispo: false,
    persoMax: 10,
    skinsInstance: [INSTANCE],
    skinsPerso: [],
    ...fonctions,
    ...over,
  });
  const domaine = new Proxy(etat, {
    get: (cible, cle: string) => (cle in cible ? (cible as Record<string, unknown>)[cle] : () => false),
  }) as unknown as DomaineReglages;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(OngletApparence) });
  app.provide(CLE_REGLAGES, domaine);
  app.mount(hote);
  return { hote, fonctions };
}

describe("Paramètres › Apparence › Mes habillages", () => {
  it("fonction coupée : section absente, menu plat, liste rechargée au montage", async () => {
    const { hote, fonctions } = monter({});
    await nextTick();
    expect(hote.querySelector("#set-mes-habillages")).toBeNull();
    expect(hote.querySelector("optgroup")).toBeNull();
    expect(fonctions.chargerSkinsPerso).toHaveBeenCalledTimes(1);
  });

  it("fonction active : menu groupé, pastilles, Aperçu, Supprimer et assistant", async () => {
    const { hote, fonctions } = monter({
      persoDispo: true,
      APP_SKINS: [INSTANCE, PERSO],
      skinsPerso: [PERSO],
    });
    await nextTick();
    expect([...hote.querySelectorAll("optgroup")].map((g) => g.label)).toEqual([
      "Habillages de l'instance",
      "Mes habillages",
    ]);
    const section = hote.querySelector("#set-mes-habillages") as HTMLElement;
    expect(section.textContent).toContain("Mon A");
    expect(section.textContent).toContain("1/10");
    expect(section.querySelectorAll("li span span").length).toBe(3);
    const bouton = (t: string) =>
      [...section.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
    bouton("Aperçu").click();
    bouton("Supprimer").click();
    bouton("Créer avec l'assistant").click();
    expect(fonctions.apercuHabillage).toHaveBeenCalledWith(expect.objectContaining({ id: "perso:a" }));
    expect(fonctions.supprimerHabillage).toHaveBeenCalledWith(expect.objectContaining({ id: "perso:a" }));
    expect(fonctions.ouvrirAssistant).toHaveBeenCalledWith("apparence");
  });
});
