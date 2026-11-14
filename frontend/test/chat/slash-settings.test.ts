// SPDX-License-Identifier: MIT
/** frontend/test/chat/slash-settings.test.ts — commande /settings : ouvre un onglet ou une partie (`secrets:git`), accepte un ancien identifiant d'onglet sans le proposer, refuse un inconnu. */
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerMenuSlash } from "../../src/features/chat/composeur/slash";
import type { CtxSlash } from "../../src/features/chat/composeur/slash";

afterEach(() => {
  document.body.innerHTML = "";
});

function monter() {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputRef = Vue.ref<HTMLTextAreaElement | null>(ta);
  const inputMessage = Vue.ref("");
  const toasts: string[] = [];
  const openSettingsTab = vi.fn(async () => undefined);
  const ctx: CtxSlash = {
    fetchAuth: () => Promise.resolve(null),
    showToast: (m) => toasts.push(m),
    openSettingsTab,
  };
  const menu = creerMenuSlash(Vue, { inputRef, inputMessage }, ctx);
  const taper = (texte: string): void => {
    inputMessage.value = texte;
    ta.value = texte;
    ta.setSelectionRange(texte.length, texte.length);
    menu.onInput();
  };
  const lancer = (texte: string): Promise<void> => menu.slashRun(menu.slashResolve(texte));
  return { menu, taper, lancer, toasts, openSettingsTab };
}

describe("commande /settings", () => {
  it("propose « Comptes Git » comme une partie de Secrets, plus l'ancien onglet", () => {
    const b = monter();
    b.taper("/settings git");
    const valeurs = b.menu.slashList.value.map((v) => (v as { value?: string }).value);
    expect(valeurs).toContain("secrets:git");
    expect(valeurs).not.toContain("connectors");
  });

  it("ouvre la partie, l'ancien identifiant tapé à la main aussi ; un inconnu est refusé", async () => {
    const b = monter();
    await b.lancer("/settings secrets:git");
    expect(b.openSettingsTab).toHaveBeenLastCalledWith("secrets:git");
    await b.lancer("/settings connectors");
    expect(b.openSettingsTab).toHaveBeenLastCalledWith("connectors");
    await b.lancer("/settings connexions");
    expect(b.openSettingsTab).toHaveBeenLastCalledWith("connexions");
    expect(b.toasts).toEqual([]);
    await b.lancer("/settings zzz");
    expect(b.openSettingsTab).toHaveBeenCalledTimes(3);
    expect(b.toasts.join(" ")).toContain("Onglet inconnu : zzz");
  });
});
