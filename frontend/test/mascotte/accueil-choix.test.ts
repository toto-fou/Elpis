// SPDX-License-Identifier: MIT
/** frontend/test/mascotte/accueil-choix.test.ts — mascotte coupée par défaut, logo par défaut, liste du menu dédié, skin qui apporte la sienne, coupure par l'administrateur. */
import { createApp, ref } from "vue";
import type { App, Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { creerMascotte } from "../../src/features/mascotte/mascotte";
import type { ReglagesMascotte, SurfaceMascotte } from "../../src/features/mascotte/mascotte";

const CATALOGUE = [
  { id: "boite_or", label: "Coffre" },
  { id: "flamme", label: "Flamme" },
  { id: "fantome", label: "Fantôme" },
];

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
});

/** Monte la mascotte dans un composant : elle pose des écouteurs et ses nettoyages. */
function monter(
  reglages: ReglagesMascotte,
  skin: { mascot?: string; label?: string } | null = null,
): { m: SurfaceMascotte; settings: Ref<ReglagesMascotte> } {
  const settings = ref<ReglagesMascotte>({ mascottes_catalogue: CATALOGUE, ...reglages });
  let m: SurfaceMascotte | undefined;
  app = createApp({
    setup() {
      m = creerMascotte(
        { settings, messages: ref([]), isStreaming: ref(false), currentView: ref("chat") },
        { skinCourant: ref(skin) },
      );
      return () => null;
    },
  });
  app.mount(document.createElement("div"));
  return { m: m as SurfaceMascotte, settings };
}

describe("accueil d'un nouveau chat", () => {
  it("logo par défaut, même avec une mascotte stockée ou mise en avant par l'administrateur", () => {
    expect(monter({}).m.mascotteId.value).toBe("");
    app?.unmount();
    const { m } = monter({ welcome_mascot: "flamme" });
    expect(m.mascotteId.value).toBe("");
    expect(m.mascotteVisible.value).toBe(false);
  });

  it("le logo vient d'abord, la mascotte mise en avant ensuite", () => {
    const { m } = monter({ welcome_mascot: "flamme" });
    expect(m.choixAccueil.value.map((c) => c.id)).toEqual(["", "flamme", "boite_or", "fantome"]);
    expect(m.choixAccueil.value[0]?.label).toBe("Logo");
  });

  it("choisir un personnage l'active, choisir le logo la coupe", () => {
    const { m, settings } = monter({});
    m.choisirAccueil("fantome");
    expect(settings.value).toMatchObject({ welcome_mascot_on: true, welcome_mascot: "fantome" });
    expect(m.mascotteId.value).toBe("fantome");
    m.choisirAccueil("");
    expect(settings.value.welcome_mascot_on).toBe(false);
    expect(m.mascotteId.value).toBe("");
  });

  it("ne suit que les mascottes proposées par l'administrateur", () => {
    const { m } = monter({
      welcome_mascot_on: true,
      welcome_mascot: "flamme",
      mascottes_actives: ["fantome"],
    });
    expect(m.mascotteId.value).toBe("");
    expect(m.choixAccueil.value.map((c) => c.id)).toEqual(["", "fantome"]);
  });

  it("un skin qui apporte sa mascotte l'affiche, jusqu'à ce que le compte la coupe", () => {
    const { m, settings } = monter({ welcome_mascot: "flamme" }, { mascot: "kiki", label: "Kiki" });
    expect(m.mascotteId.value).toBe("kiki");
    expect(m.choixAccueil.value).toEqual([
      { id: "", label: "Logo" },
      { id: "kiki", label: "Kiki" },
    ]);
    m.choisirAccueil("");
    expect(m.mascotteId.value).toBe("");
    m.choisirAccueil("kiki");
    expect(m.mascotteId.value).toBe("kiki");
    expect(settings.value.welcome_mascot).toBe("flamme");
  });

  it("l'administrateur coupe tout, y compris une mascotte activée ou apportée par le skin", () => {
    expect(
      monter({ mascottes_on: false, welcome_mascot_on: true, welcome_mascot: "flamme" }).m.mascotteId.value,
    ).toBe("");
    app?.unmount();
    const { m } = monter({ mascottes_on: false }, { mascot: "kiki" });
    expect(m.mascotteId.value).toBe("");
    expect(m.mascottesOffertes.value).toBe(false);
  });
});
