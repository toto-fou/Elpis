// SPDX-License-Identifier: MIT
/** frontend/test/chat/slash-routine.test.ts — commande /routine du menu « / » : ouvre le cadrage de l'assistant, le texte tapé préremplit l'objectif. */
import * as Vue from "vue";
import { describe, expect, it, vi } from "vitest";

import { creerMenuSlash } from "../../src/features/chat/composeur/slash";
import type { CtxSlash } from "../../src/features/chat/composeur/slash";

function monter(avecAssistant = true) {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputMessage = Vue.ref("");
  const ouvrirAssistant = vi.fn();
  const ctx: CtxSlash = {
    fetchAuth: () => Promise.resolve(null),
    showToast: () => undefined,
    ...(avecAssistant ? { ouvrirAssistant } : {}),
  };
  const menu = creerMenuSlash(Vue, { inputRef: Vue.ref(ta), inputMessage }, ctx);
  return { menu, ouvrirAssistant };
}

describe("/routine", () => {
  it("ouvre le cadrage avec le texte comme objectif", async () => {
    const { menu, ouvrirAssistant } = monter();
    const hit = menu.slashResolve("/routine résumer les tickets chaque lundi");
    expect(hit?.cmd.name).toBe("routine");
    await menu.slashRun(hit);
    expect(ouvrirAssistant).toHaveBeenCalledWith("routine", { objectif: "résumer les tickets chaque lundi" });
  });

  it("sans texte : cadrage vide", async () => {
    const { menu, ouvrirAssistant } = monter();
    await menu.slashRun(menu.slashResolve("/routine"));
    expect(ouvrirAssistant).toHaveBeenCalledWith("routine", { objectif: "" });
  });
});
