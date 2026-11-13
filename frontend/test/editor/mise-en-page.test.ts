// SPDX-License-Identifier: MIT
/** frontend/test/editor/mise-en-page.test.ts — mise en page de Monaco : une seule mise en page immédiate (ni passes différées ni boucle d'images, l'observateur de taille suit les transitions), aucune pendant l'ouverture du panneau. */
import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerEtatEditeur } from "../../src/features/editor/etat";
import { setupEditorLayout } from "../../src/features/editor/mise-en-page";

let images = 0;
beforeEach(() => {
  vi.useFakeTimers();
  images = 0;
  vi.stubGlobal("requestAnimationFrame", () => ++images);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function monde() {
  const e = creerEtatEditeur();
  const layout = { instance: vi.fn(), diff: vi.fn(), instance2: vi.fn() };
  e.monacoRef.instance = { layout: layout.instance } as never;
  e.monacoRef.diff = { layout: layout.diff } as never;
  e.monacoRef.instance2 = { layout: layout.instance2 } as never;
  const scope = effectScope();
  const page = scope.run(() =>
    setupEditorLayout(e, () => ref(true), {
      sauverVue: vi.fn(),
      restaurerVue: () => true,
      modeleOk: () => true,
      modele: () => undefined,
      preparerConteneur: () => Promise.resolve(),
      echapPourMonaco: () => false,
    }),
  )!;
  const total = (): number =>
    layout.instance.mock.calls.length + layout.diff.mock.calls.length + layout.instance2.mock.calls.length;
  return { e, page, layout, total, scope };
}

describe("mise en page de Monaco", () => {
  it("robustLayout : principal et diff tout de suite, panneau droit en vue scindée, rien après", () => {
    const m = monde();
    m.page.robustLayout();
    expect([m.layout.instance, m.layout.diff, m.layout.instance2].map((f) => f.mock.calls.length)).toEqual([
      1, 1, 0,
    ]);
    m.e.splitView.value = true;
    m.page.robustLayout();
    expect(m.layout.instance2).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(m.total()).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    m.scope.stop();
  });

  it("plein écran : entrée et sortie sans boucle d'images ; la sortie met en page une fois après le rendu", async () => {
    const m = monde();
    m.page.toggleEditorFullscreen();
    expect(m.e.editorFullscreen.value).toBe(true);
    expect(images).toBe(0);
    expect(m.total()).toBe(0);
    m.page.toggleEditorFullscreen();
    await nextTick();
    expect(m.layout.instance).toHaveBeenCalledTimes(1);
    m.page.toggleEditorFullscreen();
    m.page.exitEditorFullscreen();
    await nextTick();
    expect(m.layout.instance).toHaveBeenCalledTimes(2);
    expect(images).toBe(0);
    m.page.libererMiseEnPage();
    m.scope.stop();
  });

  it("pendant l'ouverture du panneau, aucune mise en page ; une seule à la fin de la transition", () => {
    const m = monde();
    m.e.showEditor.value = true;
    m.page._smoothOpenLayout();
    m.page.robustLayout();
    expect(m.total()).toBe(0);
    vi.advanceTimersByTime(300);
    expect(m.layout.instance).toHaveBeenCalledTimes(1);
    m.scope.stop();
  });
});
