// SPDX-License-Identifier: MIT
/** frontend/test/communs/transition-menu.test.ts — TransitionMenu : « popover » ou « popover-up » selon l'ancrage ; le menu qui sort devient inerte et lâche le focus qu'il tenait, un menu rouvert redevient actif. */
import { createApp, createCommentVNode, h, nextTick, ref, vShow, withDirectives } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import TransitionMenu from "../../src/components/communs/TransitionMenu.vue";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const images = (): Promise<void> => new Promise((ok) => setTimeout(ok, 60));

// Monte un menu (v-if ou v-show) dans TransitionMenu, et un bouton hors du menu.
function monter(opts: { haut?: boolean; show?: boolean } = {}) {
  const ouvert = ref(true);
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const menu = () => h("div", { id: "menu", role: "menu" }, [h("button", { id: "entree" }, "Entrée")]);
  app = createApp({
    render: () => [
      h("button", { id: "dehors" }, "Dehors"),
      h(TransitionMenu, { haut: opts.haut }, () =>
        opts.show
          ? withDirectives(menu(), [[vShow, ouvert.value]])
          : ouvert.value
            ? menu()
            : createCommentVNode("v-if", true),
      ),
    ],
  });
  app.mount(hote);
  const el = (id: string): HTMLElement | null => document.getElementById(id);
  return { ouvert, el };
}

describe("TransitionMenu", () => {
  it("ancré par le bas : « popover-up » ; sinon « popover »", async () => {
    const bas = monter({ haut: true });
    bas.ouvert.value = false;
    await images();
    bas.ouvert.value = true;
    await nextTick();
    expect(bas.el("menu")?.classList.contains("popover-up-enter-active")).toBe(true);
    app?.unmount();
    const haut = monter();
    haut.ouvert.value = false;
    await images();
    haut.ouvert.value = true;
    await nextTick();
    expect(haut.el("menu")?.classList.contains("popover-enter-active")).toBe(true);
  });

  it("le menu qui sort est inerte et lâche le focus qu'il tenait ; rouvert, il redevient actif", async () => {
    const { ouvert, el } = monter({ show: true });
    el("entree")?.focus();
    expect(document.activeElement?.id).toBe("entree");
    ouvert.value = false;
    await nextTick();
    expect(el("menu")?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(document.body);
    await images();
    ouvert.value = true;
    await nextTick();
    expect(el("menu")?.hasAttribute("inert")).toBe(false);
  });

  it("un focus hors du menu reste où il est", async () => {
    const { ouvert, el } = monter();
    el("dehors")?.focus();
    ouvert.value = false;
    await nextTick();
    expect(document.activeElement?.id).toBe("dehors");
  });
});
