// SPDX-License-Identifier: MIT
/** frontend/test/editor/lint.test.ts — lint retardé de l'éditeur : un fichier Python est lu au tir et envoyé au linter, un autre n'est jamais lu (ses marqueurs sont seulement effacés). */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupEditorSave } from "../../src/features/editor/enregistrement";
import { creerEtatEditeur } from "../../src/features/editor/etat";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function monde() {
  const e = creerEtatEditeur();
  e.monacoRef.instance = {} as never;
  const modele = (texte: string) => ({ getValue: vi.fn(() => texte) });
  const models = { "a.py": modele("x = 1\n"), "notes.md": modele("# Titre\n") };
  const marqueurs = vi.fn();
  vi.stubGlobal("monaco", { editor: { setModelMarkers: marqueurs } });
  const fetchAuth = vi.fn(async () => new Response(JSON.stringify({ diagnostics: [] }), { status: 200 }));
  const enr = setupEditorSave(
    e,
    { models, modeles: { ok: () => true }, vis: {}, disque: {} } as never,
    {} as never,
    { showToast: vi.fn(), fetchAuth } as never,
    ref({}),
    () => undefined,
  );
  return { enr, models, marqueurs, fetchAuth };
}

describe("lint retardé", () => {
  it("fichier non Python : le contenu n'est pas lu, ses marqueurs sont effacés", async () => {
    const m = monde();
    m.enr.scheduleLint("notes.md");
    await vi.advanceTimersByTimeAsync(800);
    expect(m.models["notes.md"].getValue).not.toHaveBeenCalled();
    expect(m.marqueurs).toHaveBeenCalledWith(m.models["notes.md"], "ruff", []);
    expect(m.fetchAuth).not.toHaveBeenCalled();
  });

  it("fichier Python : lu une fois au tir, après la dernière demande, et envoyé au linter", async () => {
    const m = monde();
    m.enr.scheduleLint("a.py");
    m.enr.scheduleLint("a.py");
    expect(m.models["a.py"].getValue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(m.models["a.py"].getValue).toHaveBeenCalledTimes(1);
    expect(m.fetchAuth).toHaveBeenCalledTimes(1);
    const corps = (m.fetchAuth.mock.calls[0] as unknown as [string, { body: string }])[1].body;
    expect(JSON.parse(corps)).toMatchObject({ content: "x = 1\n", filename: "a.py" });
  });
});
