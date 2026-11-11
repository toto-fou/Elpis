// SPDX-License-Identifier: MIT
/** frontend/test/editor/instances.test.ts — éditeurs Monaco : options issues des réglages, 50 cycles création / libération sans abonnement, observateur ni éditeur restant, préférences appliquées au panneau droit. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerEditeurs, preferencesEditeur, themeEditeur } from "../../src/features/editor/instances";
import type { EditeurMonaco, MonacoEditeurs, RappelsEditeurs } from "../../src/features/editor/instances";

class Compteurs {
  abonnements = 0;
  editeurs = 0;
  modeles = 0;
  observateurs = 0;
  globaux = 0;
}

function fauxMonaco(c: Compteurs) {
  const options: Array<Record<string, unknown>> = [];
  const abonner = () => {
    c.abonnements++;
    let fait = false;
    return {
      dispose: () => {
        if (!fait) c.abonnements--;
        fait = true;
      },
    };
  };
  const editeur = (o: Record<string, unknown>): EditeurMonaco & { opts: Record<string, unknown> } => {
    c.editeurs++;
    let libere = false;
    const ed = {
      opts: { ...o },
      onDidChangeCursorPosition: abonner,
      onDidChangeModelContent: abonner,
      onDidChangeCursorSelection: abonner,
      onDidChangeModel: abonner,
      onDidChangeModelOptions: abonner,
      onDidBlurEditorText: abonner,
      onDidFocusEditorText: abonner,
      onContextMenu: abonner,
      addCommand: () => null,
      updateOptions: (n: object) => Object.assign(ed.opts, n),
      layout: () => undefined,
      dispose: () => {
        if (!libere) c.editeurs--;
        libere = true;
      },
    };
    options.push(ed.opts);
    return ed;
  };
  const monaco: MonacoEditeurs = {
    editor: {
      create: (_el, o) => editeur(o as Record<string, unknown>),
      createDiffEditor: () => {
        c.editeurs++;
        return {
          getModifiedEditor: () => ({ addCommand: () => null }),
          updateOptions: () => undefined,
          layout: () => undefined,
          dispose: () => {
            c.editeurs--;
          },
        };
      },
      createModel: () => {
        c.modeles++;
        let libere = false;
        return {
          isDisposed: () => libere,
          dispose: () => {
            libere = true;
            c.modeles--;
          },
        };
      },
      onDidChangeMarkers: () => {
        c.globaux++;
        return { dispose: () => undefined };
      },
      setTheme: () => undefined,
    },
    languages: {
      registerDocumentFormattingEditProvider: () => {
        c.globaux++;
        return { dispose: () => undefined };
      },
    },
    KeyMod: { CtrlCmd: 2048, Alt: 512 },
    KeyCode: { KeyS: 49, Backslash: 93 },
  };
  return { monaco, options };
}

const rien = (): undefined => undefined;
const rappels: RappelsEditeurs = {
  curseur: rien,
  contenuPrincipal: rien,
  selection: rien,
  modeleChange: rien,
  optionsModele: rien,
  completer: rien,
  flouPrincipal: rien,
  enregistrer: rien,
  menu: rien,
  focusGauche: rien,
  focusDroit: rien,
  contenuDroit: rien,
  flouDroit: rien,
  enregistrerDroit: rien,
  redimension: rien,
  problemes: rien,
  formaterPython: rien,
};

function elements() {
  const parent = document.createElement("div");
  const principal = document.createElement("div");
  parent.appendChild(principal);
  return { principal, diff: document.createElement("div"), droit: document.createElement("div") };
}

afterEach(() => vi.unstubAllGlobals());

describe("éditeurs Monaco", () => {
  it("préchauffage : un éditeur et un diff créés puis libérés hors écran, sans thème global ; rien une fois les éditeurs créés", async () => {
    vi.resetModules();
    const m = await import("../../src/features/editor/instances");
    const c = new Compteurs();
    const { monaco, options } = fauxMonaco(c);
    const diffs: object[] = [];
    const diff = monaco.editor.createDiffEditor;
    monaco.editor.createDiffEditor = (el, o) => (diffs.push(o), diff(el, o));
    const enfants = document.body.childElementCount;
    m.prechaufferEditeurs(monaco, { editor_font_size: 18 });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ fontSize: 18 });
    expect(options[0]).not.toHaveProperty("theme");
    expect(diffs).toEqual([{ automaticLayout: false }]);
    expect(c.editeurs).toBe(0);
    expect(document.body.childElementCount).toBe(enfants);
    m.prechaufferEditeurs(monaco, {});
    expect(options).toHaveLength(1);

    vi.resetModules();
    const n = await import("../../src/features/editor/instances");
    n.creerEditeurs(monaco, elements(), {}, rappels).liberer();
    const avant = options.length;
    n.prechaufferEditeurs(monaco, {});
    expect(options).toHaveLength(avant);
  });

  it("préférences bornées et thème", () => {
    expect(
      preferencesEditeur({ editor_font_size: 99, editor_tab_size: 0, editor_word_wrap: "x" }),
    ).toMatchObject({
      fontSize: 32,
      tabSize: 4,
      wordWrap: "off",
      lineNumbers: "on",
      minimap: { enabled: false },
    });
    expect(themeEditeur({ editor_dark_mode: false })).toBe("vs");
    expect(themeEditeur(null)).toBe("vs-dark");
  });

  it("50 cycles création / libération : aucun abonnement, observateur, éditeur ni modèle restant ; globaux posés une fois", () => {
    const c = new Compteurs();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {
          c.observateurs++;
        }
        disconnect(): void {
          c.observateurs--;
        }
        unobserve(): void {}
      },
    );
    const { monaco } = fauxMonaco(c);
    for (let i = 0; i < 50; i++) {
      const e = creerEditeurs(monaco, elements(), {}, rappels);
      expect(c.editeurs).toBe(3);
      expect(c.observateurs).toBe(1);
      expect(e.ressources).toBeGreaterThan(10);
      e.liberer();
      e.liberer();
      expect(e.ressources).toBe(0);
      expect(c).toMatchObject({ abonnements: 0, editeurs: 0, modeles: 0, observateurs: 0 });
    }
    expect(c.globaux).toBeLessThanOrEqual(2);
  });

  it("préférences à chaud : appliquées aussi au panneau droit", () => {
    const c = new Compteurs();
    const { monaco, options } = fauxMonaco(c);
    const e = creerEditeurs(monaco, elements(), { editor_font_size: 14 }, rappels);
    e.appliquerPreferences({ editor_font_size: 20, editor_minimap: true });
    expect(options).toHaveLength(2);
    for (const o of options) expect(o).toMatchObject({ fontSize: 20, minimap: { enabled: true } });
    e.liberer();
  });
});
