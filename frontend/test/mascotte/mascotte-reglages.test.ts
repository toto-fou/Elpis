// SPDX-License-Identifier: MIT
/** frontend/test/mascotte/mascotte-reglages.test.ts — scène d'accueil et réglages : remontée quand « Animer l'accueil » ou les animations du compte changent, jamais quand le document des réglages est seulement remplacé. */
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { App, Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerMascotte } from "../../src/features/mascotte/mascotte";
import type { ReglagesMascotte } from "../../src/features/mascotte/mascotte";

const { montrerAccueil } = vi.hoisted(() => ({
  montrerAccueil: vi.fn((_hote: HTMLElement, _options: Record<string, unknown>) => ({
    detruire: () => undefined,
    jouer: () => undefined,
    choix: "",
    scenario: "",
  })),
}));
vi.mock("../../src/features/mascotte/accueil", () => ({ montrerAccueil }));

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  montrerAccueil.mockClear();
  vi.unstubAllGlobals();
});

/** Mascotte active sur l'accueil d'un nouveau chat ; rend les réglages et attend le montage de la scène. */
async function monter(): Promise<Ref<ReglagesMascotte>> {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const settings = ref<ReglagesMascotte>({
    mascottes_catalogue: [{ id: "flamme", label: "Flamme" }],
    welcome_mascot_on: true,
    welcome_mascot: "flamme",
  });
  app = createApp(
    defineComponent({
      setup() {
        const m = creerMascotte(
          { settings, messages: ref([]), isStreaming: ref(false), currentView: ref("chat") },
          {},
        );
        m.accueilHote.value = document.createElement("div");
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
  await vi.waitFor(() => expect(montrerAccueil).toHaveBeenCalledTimes(1));
  return settings;
}

const stable = async (): Promise<void> => {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
};

describe("scène d'accueil et réglages du compte", () => {
  it("un document de réglages remplacé à l'identique ne remonte pas la scène", async () => {
    const settings = await monter();
    settings.value = { ...settings.value };
    await stable();
    settings.value = { ui_motion: "system", ...settings.value };
    await stable();
    expect(montrerAccueil).toHaveBeenCalledTimes(1);
  });

  it("« Animer l'accueil » ou les animations du compte qui changent la remontent, sans intro", async () => {
    const settings = await monter();
    settings.value = { ...settings.value, welcome_mascot_anime: false };
    await vi.waitFor(() => expect(montrerAccueil).toHaveBeenCalledTimes(2));
    expect(montrerAccueil.mock.lastCall?.[1]).toMatchObject({ mouvement: "systeme", intro: false });
    settings.value = { ...settings.value, ui_motion: "reduced" };
    await vi.waitFor(() => expect(montrerAccueil).toHaveBeenCalledTimes(3));
    settings.value = { ...settings.value, ui_motion: "reduced" };
    await stable();
    expect(montrerAccueil).toHaveBeenCalledTimes(3);
  });
});
