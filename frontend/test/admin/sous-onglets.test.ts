// SPDX-License-Identifier: MIT
/** frontend/test/admin/sous-onglets.test.ts — Images et Voix : onglets par tâche, point « modifié ». */

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageConnexions from "../../src/components/admin/PageConnexions.vue";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { ONGLETS_IMAGES, ONGLETS_VOIX, ongletsAvecModifications } from "../../src/features/admin/onglets";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("rattachement des réglages aux onglets", () => {
  const modifs = (...paths: string[]) => paths.map((path) => ({ store: "config", path }));
  const sales = (r: ReturnType<typeof ongletsAvecModifications>) =>
    r.filter((o) => o.modifie).map((o) => o.id);

  it("images : connexion par défaut, limites et accès par liste, activation à part", () => {
    const r = (...p: string[]) => sales(ongletsAvecModifications(ONGLETS_IMAGES, "image.", modifs(...p)));
    expect(r("image.url", "image.model")).toEqual(["connexion"]);
    expect(r("image.max_side", "image.sizes")).toEqual(["limites"]);
    expect(r("image.groups", "image.keep_per_user")).toEqual(["acces"]);
    expect(r("image.enabled", "voice.stt.url")).toEqual([]);
  });

  it("voix : dictée et lecture", () => {
    const r = (...p: string[]) => sales(ongletsAvecModifications(ONGLETS_VOIX, "voice.", modifs(...p)));
    expect(r("voice.stt.url", "voice.tts.model")).toEqual(["dictee", "lecture"]);
    expect(r("voice.enabled")).toEqual([]);
  });
});

function monter(tab: "images" | "voice", changes: { store: string; path: string }[] = []) {
  const adm = reactive({
    adminTab: tab,
    adminPageChanges: changes,
    configForm: {
      image: { enabled: true, provider: "sdcpp", url: "http://x", model: "m", groups: [], sizes: [] },
      voice: { enabled: true, stt: { url: "http://s" }, tts: { url: "http://t" } },
    },
    imageKey: { has: false, stale: false, draft: "", state: "idle", error: "" },
    imageModels: { state: "idle", models: [], error: "" },
    imageTest: { state: "idle", res: null, error: "", adjusted: false },
    voiceTest: { state: "idle", parts: [], warnings: [], allOk: true, error: "" },
    voiceModels: {
      stt: { models: [], state: "idle", error: "" },
      tts: { models: [], voices: [], state: "idle", error: "" },
    },
    groupsList: [],
    imageSideChoices: [],
  }) as unknown as DomaineAdmin;
  const Racine = defineComponent({
    setup() {
      return () => h(PageConnexions);
    },
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(Racine);
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return hote;
}

const visibles = (hote: HTMLElement) =>
  [...hote.querySelectorAll<HTMLElement>(".adm-onglet")]
    .filter((p) => p.style.display !== "none")
    .map((p) => p.id);

describe("page Images", () => {
  it("un onglet à la fois, point sur l'onglet modifié", async () => {
    const hote = monter("images", [{ store: "config", path: "image.max_side" }]);
    await nextTick();
    expect(visibles(hote)).toEqual(["onglet-images-connexion"]);
    const onglets = [...hote.querySelectorAll<HTMLElement>("[role=tab]")];
    expect(onglets.map((o) => o.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Connexion",
      "Limites (modifié)",
      "Accès",
    ]);
    onglets[1]?.click();
    await nextTick();
    expect(visibles(hote)).toEqual(["onglet-images-limites"]);
    expect(hote.querySelector('[data-field="config:image.max_side"]')).not.toBeNull();
    expect(hote.querySelector("#onglet-images-limites")?.getAttribute("aria-labelledby")).toBe(
      "onglet-bouton-images-limites",
    );
  });

  it("flèches : passe à l'onglet suivant", async () => {
    const hote = monter("images");
    await nextTick();
    hote
      .querySelector("[role=tablist]")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(visibles(hote)).toEqual(["onglet-images-limites"]);
  });
});

describe("page Voix", () => {
  it("dictée puis lecture", async () => {
    const hote = monter("voice");
    await nextTick();
    expect(visibles(hote)).toEqual(["onglet-voice-dictee"]);
    hote.querySelectorAll<HTMLElement>("[role=tab]")[1]?.click();
    await nextTick();
    expect(visibles(hote)).toEqual(["onglet-voice-lecture"]);
  });
});
