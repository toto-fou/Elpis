// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/barre-etat.ts — barre d'état de l'éditeur (curseur, sélection, langage, indentation réelle, encodage, fins de ligne) et liste des problèmes (marqueurs Monaco) du fichier actif. */
import { computed, nextTick, ref, watch } from "vue";
import type { Ref } from "vue";
import type * as M from "monaco-editor";

import type { FormatDisque } from "./disque";
import type { ReglagesEditeur } from "./instances";
import { langageDe } from "./langages";

export interface Probleme {
  sev: "error" | "warning";
  line: number;
  col: number;
  message: string;
  source: string;
}

export interface RefsBarreEtat {
  settings: Ref<ReglagesEditeur>;
  activeTabPath: Ref<string | null>;
  splitView: Ref<boolean>;
  activePane: Ref<string>;
  showEditor: Ref<boolean>;
  isEditorDirty: Ref<boolean>;
  readonly monacoRef: { instance: M.editor.ICodeEditor | null; instance2: M.editor.ICodeEditor | null };
  readonly models: Record<string, M.editor.ITextModel>;
  readonly fileFormats: Record<string, FormatDisque | undefined>;
}

export interface RappelsBarreEtat {
  modeleOk(chemin: string): boolean;
  lectureSeule(chemin: string): boolean;
  estModifie(chemin: string): boolean;
  rafraichirModifies(): void;
  toast(message: string): void;
}

/** Marqueurs Monaco → problèmes (avertissements et erreurs), erreurs d'abord puis par ligne. */
export function problemesDe(marqueurs: readonly M.editor.IMarker[]): Probleme[] {
  return marqueurs
    .filter((m) => m.severity >= 4)
    .map((m): Probleme => ({
      sev: m.severity >= 8 ? "error" : "warning",
      line: m.startLineNumber,
      col: m.startColumn,
      message: m.message,
      source: m.source || "",
    }))
    .sort((a, b) => (a.sev === b.sev ? a.line - b.line : a.sev === "error" ? -1 : 1));
}

export function setupEditorStatusBar(refs: RefsBarreEtat, r: RappelsBarreEtat) {
  const {
    settings,
    activeTabPath,
    splitView,
    activePane,
    showEditor,
    isEditorDirty,
    monacoRef,
    models,
    fileFormats,
  } = refs;
  const statusCursor = ref({ line: 1, col: 1 });
  const statusLineCount = ref(0);
  const statusEol = ref("LF");
  const statusSelection = ref("");
  const statusModelIndent = ref("");
  const activeProblems = ref<Probleme[]>([]);
  const showProblems = ref(false);

  /** En vue scindée, la barre suit le panneau focalisé. */
  const editeurSuivi = (): M.editor.ICodeEditor | null =>
    splitView.value && activePane.value === "right" && monacoRef.instance2
      ? monacoRef.instance2
      : monacoRef.instance;

  function _updateStatusExtras(): void {
    const ed = editeurSuivi();
    const modele = ed?.getModel();
    if (!ed || !modele) return;
    try {
      statusEol.value = modele.getEOL() === "\r\n" ? "CRLF" : "LF";
      const o = modele.getOptions();
      statusModelIndent.value =
        (o.insertSpaces ? "Espaces" : "Tabs") +
        " : " +
        (o.insertSpaces ? o.indentSize || o.tabSize : o.tabSize);
      let n = 0;
      for (const sel of ed.getSelections() ?? []) n += modele.getValueLengthInRange(sel);
      statusSelection.value = n ? n + " sélectionné" + (n > 1 ? "s" : "") : "";
    } catch {
      /* modèle libéré */
    }
  }

  function _updateStatusFromEditor(): void {
    const ed = editeurSuivi();
    if (!ed) return;
    try {
      const pos = ed.getPosition();
      if (pos) statusCursor.value = { line: pos.lineNumber, col: pos.column };
      const modele = ed.getModel();
      if (modele) statusLineCount.value = modele.getLineCount();
    } catch {
      /* modèle libéré */
    }
    _updateStatusExtras();
  }

  function _detectIndentation(modele: M.editor.ITextModel | null | undefined): void {
    if (!modele) return;
    try {
      const s = settings.value || {};
      modele.detectIndentation(
        s.editor_insert_spaces !== false,
        Math.max(1, Math.min(8, Number(s.editor_tab_size) || 4)),
      );
    } catch {
      /* modèle libéré */
    }
  }

  /** Conversion explicite des fins de ligne : annulable, l'onglet devient modifié. */
  function toggleEol(): void {
    const modele = monacoRef.instance?.getModel();
    const chemin = activeTabPath.value;
    const monaco = window.monaco;
    if (!modele || !chemin || !monaco || r.lectureSeule(chemin)) return;
    try {
      const versCrlf = modele.getEOL() !== "\r\n";
      modele.pushEOL(versCrlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      r.rafraichirModifies();
      if (activeTabPath.value === chemin) isEditorDirty.value = r.estModifie(chemin);
      _updateStatusExtras();
      r.toast("Fins de ligne : " + (versCrlf ? "CRLF" : "LF") + " (à enregistrer)");
    } catch {
      /* modèle libéré */
    }
  }

  function _refreshProblems(): void {
    const p = activeTabPath.value;
    const monaco = window.monaco;
    const modele = p ? models[p] : undefined;
    if (!p || !modele || !r.modeleOk(p) || !monaco) {
      activeProblems.value = [];
    } else {
      try {
        activeProblems.value = problemesDe(monaco.editor.getModelMarkers({ resource: modele.uri }));
      } catch {
        activeProblems.value = [];
      }
    }
    if (!activeProblems.value.length) showProblems.value = false;
  }

  function goToProblem(pb: Probleme | null | undefined): void {
    showProblems.value = false;
    const ed = monacoRef.instance;
    if (!ed || !pb) return;
    const pos = { lineNumber: pb.line, column: pb.col || 1 };
    try {
      ed.setPosition(pos);
      ed.revealPositionInCenter(pos);
      ed.focus();
    } catch {
      /* éditeur libéré */
    }
  }

  const statusLanguage = computed(() => {
    const p = activeTabPath.value;
    return p ? langageDe(p) : "plaintext";
  });
  /** Indentation détectée du fichier, à défaut celle des réglages. */
  const statusIndent = computed(() => {
    if (statusModelIndent.value) return statusModelIndent.value;
    const s = settings.value || {};
    const taille = Math.max(1, Math.min(8, Number(s.editor_tab_size) || 4));
    return (s.editor_insert_spaces !== false ? "Espaces" : "Tabs") + " : " + taille;
  });
  const formatActif = (): FormatDisque | undefined => fileFormats[activeTabPath.value ?? ""];
  const statusEncoding = computed(() => {
    const f = formatActif();
    if (!f) return "UTF-8";
    return f.lossy ? "Non UTF-8" : f.bom ? "UTF-8 BOM" : "UTF-8";
  });
  const statusEolMixed = computed(() => {
    const f = formatActif();
    return !!f && (f.eol === "mixed" || f.eol === "cr");
  });
  const problemCounts = computed(() => ({
    errors: activeProblems.value.filter((x) => x.sev === "error").length,
    warnings: activeProblems.value.filter((x) => x.sev === "warning").length,
  }));

  watch(showEditor, (v) => {
    if (v && monacoRef.instance) _updateStatusFromEditor();
  });
  watch(activeTabPath, () => {
    void nextTick(_refreshProblems);
  });

  return {
    statusCursor,
    statusLineCount,
    statusLanguage,
    statusIndent,
    statusEol,
    statusSelection,
    statusEncoding,
    statusEolMixed,
    toggleEol,
    activeProblems,
    showProblems,
    problemCounts,
    goToProblem,
    _updateStatusFromEditor,
    _updateStatusExtras,
    _detectIndentation,
    _refreshProblems,
  };
}
