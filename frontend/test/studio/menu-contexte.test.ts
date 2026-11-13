// SPDX-License-Identifier: MIT
/** frontend/test/studio/menu-contexte.test.ts — menu du clic droit du Studio : sous-menus selon l'onglet et la cible, entrées propres à un élément, action appelée. */
import { createApp, defineComponent, h, nextTick, provide, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import MenuContexteStudio from "../../src/components/studio/MenuContexteStudio.vue";
import { RACCOURCIS_TOUCHES } from "../../src/features/studio/dialogue";
import { CLE_STUDIO } from "../../src/features/studio/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(tab: string, el: object | null) {
  const appels: string[] = [];
  const noter =
    (nom: string) =>
    (...a: unknown[]): void =>
      void appels.push(`${nom}(${a.join(",")})`);
  const sd = reactive({
    studioTab: tab,
    studioCtxMenu: { x: 0, y: 0, point: [5, 6], el },
    studioCtxSub: "",
    autoWaitSec: 12,
    elementDisplay: (e: { label?: string }) => e.label ?? "",
    ctxSubPos: () => "left-full ml-1 top-0",
    closeStudioCtx: noter("closeStudioCtx"),
    ctxScript: noter("ctxScript"),
    ctxAct: noter("ctxAct"),
    ctxKeyPreset: noter("ctxKeyPreset"),
    ctxAsk: noter("ctxAsk"),
  });
  const Racine = defineComponent({
    setup() {
      provide(CLE_STUDIO, sd as never);
      return () => h(MenuContexteStudio);
    },
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(Racine);
  app.mount(hote);
  const ouvrir = async (titre: string): Promise<void> => {
    (
      Array.from(hote.querySelectorAll("button")).find((b) => b.textContent?.trim() === titre) as HTMLElement
    ).click();
    await nextTick();
  };
  const bouton = (texte: string): HTMLElement | undefined =>
    Array.from(hote.querySelectorAll("button")).find((b) => b.textContent?.includes(texte));
  return { hote, appels, ouvrir, bouton };
}

describe("Studio : menu du clic droit", () => {
  it("sur un point hors de l'onglet Script : ni Script ni Contrôle", async () => {
    const { hote, appels, ouvrir, bouton } = monter("assistant", null);
    await nextTick();
    expect(hote.textContent).toContain("point 5, 6");
    expect(hote.textContent).not.toContain("Script");
    expect(hote.textContent).not.toContain("Contrôle");
    await ouvrir("Clics");
    bouton("Triple-cliquer")?.click();
    await ouvrir("Touches");
    bouton(RACCOURCIS_TOUCHES[0]?.label ?? "")?.click();
    expect(appels).toEqual(["ctxAct(triple_click)", `ctxKeyPreset(${RACCOURCIS_TOUCHES[0]?.keys})`]);
  });

  it("dans l'onglet Script : entrées propres à l'élément seulement sur un élément, délai affiché", async () => {
    const point = monter("script", null);
    await point.ouvrir("Script");
    expect(point.hote.textContent).toContain("Attendre l'écran stable");
    expect(point.hote.textContent).not.toContain("Si présent");
    app?.unmount();
    const cible = monter("script", { label: "OK", role: "button" });
    await cible.ouvrir("Script");
    expect(cible.hote.textContent).toContain("Contrôle (fiable)");
    expect(cible.hote.textContent).toContain("cible : OK");
    expect(cible.bouton("Attendre l'élément")?.textContent).toContain("12 s");
    cible.bouton("Si absent")?.click();
    expect(cible.appels).toEqual(["ctxScript(if_missing)"]);
  });
});
