// SPDX-License-Identifier: MIT
/** frontend/test/studio/page.test.ts — page Studio : niveaux Simple / Expert selon l'interface, consigne de l'état vide. */
import { createApp, defineComponent, h, nextTick, provide } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageStudio from "../../src/components/studio/PageStudio.vue";
import { CLE_STUDIO } from "../../src/features/studio/domaine";
import type { DomaineStudio } from "../../src/features/studio/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(opts: { expert: boolean; image: boolean; cibles?: number }) {
  const etat: Record<string, unknown> = {
    currentView: "studio",
    studioExpert: opts.expert,
    studioFrame: { imageUrl: opts.image ? "blob:x" : "", imgW: 10, imgH: 10 },
    studioTargets: Array.from({ length: opts.cibles ?? 1 }, (_, i) => ({ name: `c${i}`, os: "linux" })),
    studioElements: [],
    studioLayers: [],
    studioLayerFiltered: [],
    studioTab: "assistant",
    studioChatMessages: [],
    studioTreeDock: true,
    studioTreeRows: [],
    studioStageMode: "inspect",
    studioAudit: { rows: [] },
    selectedTarget: "c0",
    studioChatInput: "",
    autoAiPrompt: "",
    definirStudioExpert: (v: boolean) => (etat.studioExpert = v),
  };
  const sd = new Proxy(etat, {
    get: (t, k) => (k in t ? t[k as string] : undefined),
  }) as unknown as DomaineStudio;
  const Racine = defineComponent({
    setup() {
      provide(CLE_STUDIO, sd);
      return () => h(PageStudio);
    },
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(Racine);
  app.config.errorHandler = (e) => {
    throw e;
  };
  app.mount(hote);
  return hote;
}

describe("Studio : niveaux d'outillage", () => {
  it("Simple : pas d'outils de sélection ni d'arbre, bascule visible, étapes en vide", async () => {
    const hote = monter({ expert: false, image: false });
    await nextTick();
    expect(hote.textContent).toContain("Simple");
    expect(hote.textContent).toContain("Expert");
    expect(hote.textContent).toContain("Cliquez sur « Capturer »");
    expect(hote.textContent).not.toContain("Capturer & annoter");
    expect(hote.textContent).not.toContain("Si présent");
  });

  it("Simple avec capture : ni Inspecter, ni Zone, ni Glisser, ni arbre", async () => {
    const hote = monter({ expert: false, image: true });
    await nextTick();
    for (const t of ["Inspecter", "Glisser", "Plans"]) expect(hote.textContent).not.toContain(t);
    expect(hote.querySelector("[title=\"Afficher l'arbre d'éléments\"]")).toBeNull();
  });

  it("Expert avec capture : tous les outils", async () => {
    const hote = monter({ expert: true, image: true });
    await nextTick();
    for (const t of ["Inspecter", "Zone", "Glisser", "Plans", "Si présent"])
      expect(hote.textContent).toContain(t);
  });
});
