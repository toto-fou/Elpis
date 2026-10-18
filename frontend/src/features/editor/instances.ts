// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/instances.ts — éditeurs Monaco de l'éditeur (principal, diff, panneau droit) : options issues des réglages, abonnements et observateur possédés puis libérés ensemble, préférences et thème appliqués à chaud. */
import { markRaw } from "vue";

export interface Jetable {
  dispose(): void;
}

export interface ReglagesEditeur {
  enable_editor?: boolean;
  enable_preview?: boolean;
  editor_ratio?: number;
  editor_auto_save?: string;
  editor_edit_highlight?: boolean;
  editor_follow_active?: boolean;
  editor_persist_tabs?: boolean;
  auto_open_editor_on_write?: boolean;
  sandbox_path_display?: string;
  editor_dark_mode?: boolean;
  editor_font_size?: unknown;
  editor_font_family?: unknown;
  editor_tab_size?: unknown;
  editor_insert_spaces?: boolean;
  editor_word_wrap?: unknown;
  editor_minimap?: unknown;
  editor_line_numbers?: boolean;
  [cle: string]: unknown;
}

export interface PreferencesEditeur {
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: "off" | "on" | "bounded";
  minimap: { enabled: boolean };
  lineNumbers: "off" | "on";
}

const POLICES_SECOURS = ', "Fira Code", "Cascadia Code", Consolas, monospace';

/** Préférences bornées (taille 8 à 32, tabulation 1 à 8), police de secours ajoutée. */
export function preferencesEditeur(s: ReglagesEditeur | null | undefined): PreferencesEditeur {
  const r = s || {};
  const retour = r.editor_word_wrap;
  return {
    fontSize: Math.max(8, Math.min(32, Number(r.editor_font_size) || 14)),
    fontFamily: String(r.editor_font_family || "JetBrains Mono") + POLICES_SECOURS,
    tabSize: Math.max(1, Math.min(8, Number(r.editor_tab_size) || 4)),
    insertSpaces: r.editor_insert_spaces !== false,
    wordWrap: retour === "on" || retour === "bounded" ? retour : "off",
    minimap: { enabled: !!r.editor_minimap },
    lineNumbers: r.editor_line_numbers === false ? "off" : "on",
  };
}

/** Thème sombre par défaut (l'éditeur l'a toujours été). */
export function themeEditeur(s: ReglagesEditeur | null | undefined): "vs" | "vs-dark" {
  return s && s.editor_dark_mode === false ? "vs" : "vs-dark";
}

interface EvenementMenu {
  event: { preventDefault(): void; stopPropagation(): void; browserEvent: MouseEvent };
}

export interface EditeurMonaco extends Jetable {
  onDidChangeCursorPosition(fn: () => void): Jetable;
  onDidChangeModelContent(fn: () => void): Jetable;
  onDidChangeCursorSelection(fn: () => void): Jetable;
  onDidChangeModel(fn: () => void): Jetable;
  onDidChangeModelOptions(fn: () => void): Jetable;
  onDidBlurEditorText(fn: () => void): Jetable;
  onDidFocusEditorText(fn: () => void): Jetable;
  onContextMenu(fn: (e: EvenementMenu) => void): Jetable;
  addCommand(touches: number, fn: () => void): unknown;
  updateOptions(o: object): void;
  layout(): void;
}

export interface EditeurDiffMonaco extends Jetable {
  getModifiedEditor(): { addCommand(touches: number, fn: () => void): unknown };
  updateOptions(o: object): void;
  layout(): void;
}

type ModeleJetable = Jetable & { isDisposed(): boolean };

export interface MonacoEditeurs<
  E extends EditeurMonaco = EditeurMonaco,
  D extends EditeurDiffMonaco = EditeurDiffMonaco,
  Mo extends ModeleJetable = ModeleJetable,
> {
  editor: {
    create(el: HTMLElement, o: object): E;
    createDiffEditor(el: HTMLElement, o: object): D;
    createModel(texte: string, langue: string): Mo;
    onDidChangeMarkers(fn: () => void): Jetable;
    setTheme(nom: string): void;
  };
  languages: { registerDocumentFormattingEditProvider(langue: string, p: object): Jetable };
  KeyMod: { CtrlCmd: number; Alt: number };
  KeyCode: { KeyS: number; Backslash: number };
}

export interface RappelsEditeurs<Mo = unknown> {
  curseur(): void;
  contenuPrincipal(): void;
  selection(): void;
  modeleChange(): void;
  optionsModele(): void;
  completer(): void;
  flouPrincipal(): void;
  enregistrer(): void;
  menu(e: MouseEvent): void;
  focusGauche(): void;
  focusDroit(): void;
  contenuDroit(): void;
  flouDroit(): void;
  enregistrerDroit(): void;
  redimension(): void;
  problemes(): void;
  formaterPython(modele: Mo): unknown;
}

export interface ElementsEditeurs {
  principal: HTMLElement;
  diff: HTMLElement | null;
  droit: HTMLElement | null;
}

export interface Editeurs<
  E extends EditeurMonaco = EditeurMonaco,
  D extends EditeurDiffMonaco = EditeurDiffMonaco,
  Mo extends ModeleJetable = ModeleJetable,
> {
  instance: E;
  instance2: E | null;
  diff: D | null;
  originalModel: Mo | null;
  /** Abonnements, observateur et éditeurs vivants (0 après `liberer`). */
  readonly ressources: number;
  appliquerPreferences(s: ReglagesEditeur | null | undefined): void;
  mettreEnPage(): void;
  liberer(): void;
}

// Une fois par page (Monaco est global) : formateur Python et suivi des marqueurs.
let globauxEnregistres = false;

function options(p: PreferencesEditeur, theme: string): Record<string, unknown> {
  return {
    value: "",
    language: "plaintext",
    theme,
    automaticLayout: false,
    minimap: p.minimap,
    glyphMargin: true,
    fontSize: p.fontSize,
    fontFamily: p.fontFamily,
    lineHeight: 22,
    lineNumbers: p.lineNumbers,
    tabSize: p.tabSize,
    insertSpaces: p.insertSpaces,
    wordWrap: p.wordWrap,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    padding: { top: 12, bottom: 12 },
    bracketPairColorization: { enabled: true },
    contextmenu: false,
    stickyScroll: { enabled: true, maxLineCount: 5 },
  };
}

/** Crée les trois éditeurs ; tout ce qu'ils posent (abonnements, observateur) est libéré par `liberer`. */
export function creerEditeurs<E extends EditeurMonaco, D extends EditeurDiffMonaco, Mo extends ModeleJetable>(
  monaco: MonacoEditeurs<E, D, Mo>,
  el: ElementsEditeurs,
  reglages: ReglagesEditeur | null | undefined,
  r: RappelsEditeurs<Mo>,
): Editeurs<E, D, Mo> {
  const prefs = preferencesEditeur(reglages);
  const theme = themeEditeur(reglages);
  const jetables: Jetable[] = [];
  const garder = (j: Jetable): void => {
    jetables.push(j);
  };
  const ctrlS = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS;

  const instance = markRaw(
    monaco.editor.create(el.principal, {
      ...options(prefs, theme),
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      renderWhitespace: "selection",
      "semanticHighlighting.enabled": true,
      suggest: { showWords: false },
    }),
  );
  garder(instance.onDidChangeCursorPosition(r.curseur));
  garder(instance.onDidChangeModelContent(r.contenuPrincipal));
  garder(instance.onDidChangeCursorSelection(r.selection));
  garder(instance.onDidChangeModel(r.modeleChange));
  garder(instance.onDidChangeModelOptions(r.optionsModele));
  instance.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Backslash, r.completer);
  if (!globauxEnregistres) {
    globauxEnregistres = true;
    try {
      monaco.languages.registerDocumentFormattingEditProvider("python", {
        provideDocumentFormattingEdits: (m: Mo) => r.formaterPython(m),
      });
    } catch {
      /* langue absente */
    }
    try {
      monaco.editor.onDidChangeMarkers(() => r.problemes());
    } catch {
      /* API absente */
    }
  }
  garder(instance.onDidBlurEditorText(r.flouPrincipal));
  instance.addCommand(ctrlS, r.enregistrer);
  garder(
    instance.onContextMenu((e) => {
      e.event.preventDefault();
      e.event.stopPropagation();
      r.menu(e.event.browserEvent);
    }),
  );

  let diff: D | null = null;
  let originalModel: Mo | null = null;
  if (el.diff) {
    diff = markRaw(
      monaco.editor.createDiffEditor(el.diff, {
        theme,
        automaticLayout: false,
        originalEditable: false,
        readOnly: false,
        renderSideBySide: true,
      }),
    );
    originalModel = markRaw(monaco.editor.createModel("", "plaintext"));
    diff.getModifiedEditor().addCommand(ctrlS, r.enregistrer);
  }
  garder(instance.onDidFocusEditorText(r.focusGauche));

  let instance2: E | null = null;
  if (el.droit) {
    instance2 = markRaw(monaco.editor.create(el.droit, options(prefs, theme)));
    garder(instance2.onDidFocusEditorText(r.focusDroit));
    garder(instance2.onDidChangeCursorPosition(r.curseur));
    garder(instance2.onDidChangeModelContent(r.contenuDroit));
    garder(instance2.onDidBlurEditorText(r.flouDroit));
    instance2.addCommand(ctrlS, r.enregistrerDroit);
    garder(
      instance2.onContextMenu((e) => {
        e.event.preventDefault();
        e.event.stopPropagation();
      }),
    );
  }

  let observateur: ResizeObserver | null = null;
  const conteneur = el.principal.parentElement;
  if (typeof ResizeObserver !== "undefined" && conteneur) {
    observateur = new ResizeObserver(() => r.redimension());
    observateur.observe(conteneur);
  }

  let libere = false;
  return {
    instance,
    instance2,
    diff,
    originalModel,
    get ressources() {
      if (libere) return 0;
      return jetables.length + (observateur ? 1 : 0) + 1 + (instance2 ? 1 : 0) + (diff ? 1 : 0);
    },
    /** Préférences sur les trois éditeurs, le panneau droit compris (il gardait les anciennes). */
    appliquerPreferences(s) {
      const p = preferencesEditeur(s);
      for (const ed of [instance, instance2, diff]) {
        try {
          ed?.updateOptions(p);
        } catch {
          /* éditeur libéré */
        }
      }
    },
    /** Mise en page explicite (`automaticLayout: false`) : minimap et retour à la ligne recalculés. */
    mettreEnPage() {
      try {
        instance.layout();
        diff?.layout();
      } catch {
        /* éditeur libéré */
      }
    },
    liberer() {
      if (libere) return;
      libere = true;
      observateur?.disconnect();
      observateur = null;
      for (const j of jetables.splice(0)) {
        try {
          j.dispose();
        } catch {
          /* déjà libéré */
        }
      }
      for (const j of [originalModel, instance, instance2, diff]) {
        try {
          if (j && !("isDisposed" in j && j.isDisposed())) j.dispose();
        } catch {
          /* déjà libéré */
        }
      }
    },
  };
}
