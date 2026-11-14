// SPDX-License-Identifier: MIT
/** frontend/test/editor/theme-differe.test.ts — thème de l'éditeur : posé tout de suite quand l'éditeur est affiché, au prochain affichage quand il est masqué. */
import { effectScope, nextTick, ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupEditor } from "../../src/features/editor/editeur";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("éditeur masqué : un changement de thème attend son affichage ; affiché, il est posé aussitôt", async () => {
  const setTheme = vi.fn();
  vi.stubGlobal("monaco", { editor: { setTheme, defineTheme: vi.fn() } });
  const settings = ref<Record<string, unknown>>({ enable_editor: true, editor_dark_mode: true });
  const portee = effectScope();
  const ed = portee.run(() =>
    setupEditor(
      new GestionnaireSession(),
      { user: ref({ id: 1, username: "a" }), settings },
      {
        showToast: () => {},
        fetchAuth: () => Promise.resolve(null),
        openConfirm: () => Promise.resolve(true),
        openPrompt: () => Promise.resolve(null),
        showSidebar: ref(true),
      },
    ),
  )!;
  settings.value = { ...settings.value, editor_dark_mode: false };
  await nextTick();
  await nextTick();
  expect(setTheme).not.toHaveBeenCalled();
  ed.showEditor.value = true;
  await nextTick();
  expect(setTheme.mock.calls).toEqual([["vs"]]);
  settings.value = { ...settings.value, editor_dark_mode: true };
  await nextTick();
  await nextTick();
  expect(setTheme.mock.calls).toEqual([["vs"], ["vs-dark"]]);
  ed.showEditor.value = false;
  await nextTick();
  portee.stop();
});
