// SPDX-License-Identifier: MIT
/** frontend/test/editor/ctrl-s-monaco.test.ts — Ctrl+S reçu par Monaco (commande unique, après le raccourci de la fenêtre) : rien pour un fichier qui n'est pas affiché à côté en vue scindée ou qui n'est pas modifié. */
import { effectScope, nextTick, ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { setupEditor } from "../../src/features/editor/editeur";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function fauxMonaco(commandes: Array<[number, () => void]>) {
  const jetable = () => ({ dispose: () => undefined });
  const editeur = () => ({
    onDidChangeCursorPosition: jetable,
    onDidChangeModelContent: jetable,
    onDidChangeCursorSelection: jetable,
    onDidChangeModel: jetable,
    onDidChangeModelOptions: jetable,
    onDidBlurEditorText: jetable,
    onDidFocusEditorText: jetable,
    onContextMenu: jetable,
    addCommand: (touches: number, fn: () => void) => commandes.push([touches, fn]),
    updateOptions: () => undefined,
    layout: () => undefined,
    setModel: () => undefined,
    getModel: () => null,
    focus: () => undefined,
    dispose: () => undefined,
  });
  return {
    editor: {
      create: editeur,
      createDiffEditor: () => ({
        getModifiedEditor: editeur,
        updateOptions: () => undefined,
        layout: () => undefined,
        dispose: () => undefined,
      }),
      createModel: () => ({ isDisposed: () => false, dispose: () => undefined }),
      onDidChangeMarkers: jetable,
      setTheme: () => undefined,
      defineTheme: () => undefined,
    },
    languages: {
      getLanguages: () => [{ id: "robotframework" }],
      registerDocumentFormattingEditProvider: jetable,
    },
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyS: 49, Backslash: 93 },
  };
}

it("vue scindée refermée, ou fichier d'à côté non modifié : la commande Monaco n'enregistre rien", async () => {
  document.body.innerHTML =
    '<div id="monaco-editor"></div><div id="monaco-diff-editor"></div><div id="monaco-editor-2"></div>';
  const commandes: Array<[number, () => void]> = [];
  vi.stubGlobal("monaco", fauxMonaco(commandes));
  const toasts: string[] = [];
  const requetes: string[] = [];
  const portee = effectScope();
  const ed = portee.run(() =>
    setupEditor(
      new GestionnaireSession(),
      { user: ref({ id: 1, username: "a" }), settings: ref({ enable_editor: true }) },
      {
        showToast: (m: string) => void toasts.push(m),
        fetchAuth: (url: string) => {
          requetes.push(url);
          return Promise.resolve(null);
        },
        openConfirm: () => Promise.resolve(true),
        openPrompt: () => Promise.resolve(null),
        showSidebar: ref(true),
      },
    ),
  )!;
  await ed.initMonaco();
  await nextTick();
  const ctrlS = commandes.filter(([touches]) => touches === (2048 | 49));
  expect(ctrlS).toHaveLength(1);
  const etat = ed as unknown as Record<string, { value: unknown }> & { exitSplit(): void };
  etat["activeTabPath"]!.value = "a.py";
  etat["splitView"]!.value = true;
  etat["splitTabPath"]!.value = "b.py";
  toasts.length = 0;
  requetes.length = 0;
  // Affiché à côté mais sans modification : rien à écrire, aucun second message.
  ctrlS[0]![1]();
  await new Promise((r) => setTimeout(r, 0));
  // Vue scindée refermée : son fichier reste connu de l'éditeur, il n'est plus enregistré.
  etat.exitSplit();
  await nextTick();
  expect(etat["splitTabPath"]!.value).toBe("b.py");
  ctrlS[0]![1]();
  await new Promise((r) => setTimeout(r, 0));
  expect(toasts).toEqual([]);
  expect(requetes).toEqual([]);
  portee.stop();
});
