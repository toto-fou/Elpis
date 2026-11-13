// SPDX-License-Identifier: MIT
/** frontend/test/studio/survol.test.ts — survol du Studio : la ligne de l'arbre et le cadre de l'image suivent l'élément survolé sans re-rendre la page. */
import { createApp, defineComponent, h, nextTick, provide, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageStudio from "../../src/components/studio/PageStudio.vue";
import { CLE_STUDIO } from "../../src/features/studio/domaine";
import type { DomaineStudio } from "../../src/features/studio/domaine";
import { creerMenuStudio } from "../../src/features/studio/menu";
import type { ElementStudio } from "../../src/features/studio/menu";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

const el = (id: string, depth: number, box: [number, number, number, number]): ElementStudio => ({
  id,
  box,
  depth,
  role: "button",
  label: "Bouton " + id,
  auto_id: "aid_" + id,
  source: "uia",
});

function monter() {
  localStorage.setItem("studioExpert", "1");
  const menu = creerMenuStudio({ currentView: ref("studio") }, { fetchAuth: () => Promise.resolve(null) });
  menu.studioFrame.value = {
    imageUrl: "blob:x",
    imgW: 1000,
    imgH: 1000,
    target: "vm",
    ts: 1,
    boxes: [el("a", 0, [0, 0, 400, 400]), el("b", 1, [10, 10, 60, 40]), el("c", 1, [70, 10, 120, 40])],
  };
  const roleIcon = vi.fn(menu.roleIcon);
  const sd = reactive({
    ...menu,
    roleIcon,
    currentView: "studio",
    studioTab: "assistant",
    studioChatMessages: [],
    studioStageMode: "inspect",
    studioChatInput: "",
    autoAiPrompt: "",
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
  return { hote, menu, roleIcon };
}

const ligne = (hote: HTMLElement, id: string): Element =>
  hote.querySelector(`.elpis-studio-page [data-el-id="${id}"]`) as Element;

describe("Studio : survol", () => {
  it("surligne la ligne et dessine le cadre sans re-rendre l'arbre ni l'image", async () => {
    const { hote, menu, roleIcon } = monter();
    await nextTick();
    expect(hote.querySelectorAll(".elpis-studio-page [data-el-id]")).toHaveLength(3);
    const rendus = roleIcon.mock.calls.length;

    menu.highlightElement("b");
    await nextTick();
    expect(ligne(hote, "b").classList.contains("bg-amber-50")).toBe(true);
    expect(ligne(hote, "c").classList.contains("bg-amber-50")).toBe(false);
    const cadre = hote.querySelector('svg rect[stroke="var(--warn-soft)"]');
    expect(cadre?.getAttribute("x")).toBe("10");
    expect(hote.textContent).toContain("aid_b");
    expect(roleIcon.mock.calls.length).toBe(rendus);

    menu.highlightElement("c");
    await nextTick();
    expect(ligne(hote, "b").classList.contains("bg-amber-50")).toBe(false);
    expect(ligne(hote, "c").classList.contains("bg-amber-50")).toBe(true);
    expect(roleIcon.mock.calls.length).toBe(rendus);

    menu.clearHighlight();
    await nextTick();
    expect(hote.querySelector('svg rect[stroke="var(--warn-soft)"]')).toBeNull();
    expect(ligne(hote, "c").classList.contains("bg-amber-50")).toBe(false);
  });

  it("l'élément sélectionné garde son style sous le survol, puis retrouve le surlignage une fois désélectionné", async () => {
    const { hote, menu } = monter();
    await nextTick();
    menu.highlightElement("b");
    menu.selectStudioElement("b", true);
    await nextTick();
    expect(ligne(hote, "b").className).toContain("bg-blue-50");
    expect(ligne(hote, "b").classList.contains("bg-amber-50")).toBe(false);
    expect(hote.querySelector('svg rect[stroke="var(--accent)"][stroke-width="4"]')).not.toBeNull();

    menu.selectStudioElement("b");
    await nextTick();
    expect(ligne(hote, "b").className).not.toContain("bg-blue-50");
    expect(ligne(hote, "b").classList.contains("bg-amber-50")).toBe(true);
  });
});
