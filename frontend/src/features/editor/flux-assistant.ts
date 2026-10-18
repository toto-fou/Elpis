// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/flux-assistant.ts — écritures de l'assistant dans l'éditeur : contenu complet (`updateEditor`) ou flux d'un outil d'écriture (`stream*`, lots coalescés par image, une étape d'annulation par flux), copie de secours des modifications non enregistrées, lignes modifiées surlignées. */
import { nextTick } from "vue";
import type { Ref } from "vue";
import type * as M from "monaco-editor";

import { journal } from "../../platform/journal";
import { editionMinimale } from "./ecriture-modele";
import type { CtxEditeur, EtatEditeur, EtatFlux, Modele } from "./etat";
import { poserDans } from "./etat";
import type { ReglagesEditeur } from "./instances";
import { langageDe } from "./langages";
import type { LectureDisque } from "./disque";
import type { LiensEditeur, ServicesEditeur } from "./liens";

export interface DisqueEcrit extends LectureDisque {
  mtime?: number | null;
  sha?: string | null;
}

export interface OptionsFluxEcriture {
  append?: boolean;
  preloadContent?: string | null;
}

export interface SpecEdition {
  action?: string;
  old_str?: string;
  start_line?: number | string;
  end_line?: number | string;
  preloadContent?: string | null;
}

export interface OptionsFinFlux {
  success?: boolean;
  finalContent?: string;
  disk?: DisqueEcrit | null;
}

const LOT_MIN = 2;
const LOT_MAX = 4096;
/** Taille de lot ≈ arriéré / RATTRAPAGE : la vitesse visible suit celle d'émission. */
const RATTRAPAGE = 3;

/** Taille du prochain lot à appliquer pour un arriéré donné. */
export function tailleLot(arriere: number): number {
  return Math.min(arriere, Math.max(LOT_MIN, Math.min(LOT_MAX, Math.ceil(arriere / RATTRAPAGE))));
}

/** Position après insertion de `fragment` à (ligne, col). */
export function avancer(ligne: number, col: number, fragment: string): { ligne: number; col: number } {
  const nl = (fragment.match(/\n/g) || []).length;
  if (!nl) return { ligne, col: col + fragment.length };
  return { ligne: ligne + nl, col: fragment.length - fragment.lastIndexOf("\n") };
}

const prochaineImage = (fn: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

export function setupEditorAssistantWrites(
  e: EtatEditeur,
  s: ServicesEditeur,
  l: LiensEditeur,
  ctx: CtxEditeur,
  settings: Ref<ReglagesEditeur>,
) {
  const {
    monacoRef,
    openTabs,
    activeTabPath,
    originalFileContent,
    isEditorDirty,
    writeStreams,
    assistantStash,
  } = e;
  const { modeles, models, vis, disque, apercu } = s;
  const modelOk = (p: string | null | undefined): boolean => !!p && modeles.ok(p);
  const range = (a: number, b: number, c: number, d: number): M.Range | null =>
    window.monaco ? new window.monaco.Range(a, b, c, d) : null;
  const pousser = (m: Modele, edits: M.editor.IIdentifiedSingleEditOperation[]): void => {
    m.pushEditOperations([], edits, () => null);
  };
  const arretAnnulation = (m: Modele | undefined): void => {
    try {
      if (m && !m.isDisposed()) m.pushStackElement();
    } catch {
      /* modèle libéré */
    }
  };

  /** Surligne 3 s les lignes modifiées (réglage « surbrillance des lignes éditées »). */
  function _flashChangedLines(m: Modele, plage: { startLine: number; endLine: number } | null): void {
    const ed = monacoRef.instance;
    const monaco = window.monaco;
    if (!ed || !plage || !monaco) return;
    if (ed.getModel() !== m) return;
    if (settings.value?.editor_edit_highlight === false) return;
    const decos: M.editor.IModelDeltaDecoration[] = [];
    for (let ln = plage.startLine; ln <= plage.endLine; ln++) {
      decos.push({
        range: new monaco.Range(ln, 1, ln, 1),
        options: {
          isWholeLine: true,
          className: "elpis-changed-line-highlight",
          linesDecorationsClassName: "elpis-changed-line-gutter",
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    let ids: string[] = [];
    try {
      ids = ed.deltaDecorations([], decos);
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        const cur = monacoRef.instance;
        if (!cur || !ids.length || m.isDisposed() || cur.getModel() !== m) return;
        cur.deltaDecorations(ids, []);
      } catch {
        /* éditeur libéré */
      }
    }, 3200);
  }

  /** L'assistant va réécrire `chemin` : les modifications non enregistrées de l'onglet sont copiées (bandeau Restaurer). */
  function _stashBeforeAssistantWrite(chemin: string): void {
    const m = models[chemin];
    if (!m || !modelOk(chemin) || !l.tabIsDirty(chemin)) return;
    const avant = assistantStash.value[chemin];
    if (avant && isStreamActive(chemin)) return;
    const cur = m.getValue();
    if (avant && avant.content === cur) return;
    poserDans(assistantStash, chemin, { content: cur, ts: Date.now() });
  }

  /** Éditeur ouvert (sauf réglage contraire), onglet actif et modèle prêts pour une écriture de l'assistant. */
  async function _ensureFileInEditor(chemin: string, initial: string): Promise<Modele | null> {
    if (!settings.value.enable_editor) return null;
    if (vis.officeIsViewerPath(chemin)) return null;
    if (!e.showEditor.value) {
      if (settings.value.auto_open_editor_on_write === false) return null;
      e.showEditor.value = true;
      e.showExplorer.value = false;
      await nextTick();
      void s.fs.loadSandboxFiles();
    }
    await l.initMonaco();
    const ed = monacoRef.instance;
    if (!ed) return null;
    e.editorMode.value = "code";
    if (!openTabs.value.find((t) => t.path === chemin))
      openTabs.value.push({ path: chemin, name: chemin.split("/").pop() ?? chemin });
    activeTabPath.value = chemin;
    e.editorFilePath.value = chemin;
    if (!modelOk(chemin)) {
      modeles.liberer(chemin);
      try {
        modeles.assurer(chemin, initial || "", langageDe(chemin));
      } catch (err) {
        journal.avertir("[editor] _ensureModel a échoué pour", chemin, err);
        return null;
      }
    }
    const m = models[chemin];
    if (m && modelOk(chemin)) {
      try {
        ed.setModel(m);
      } catch {
        /* éditeur libéré */
      }
    }
    l.robustLayout();
    return m && modelOk(chemin) ? m : null;
  }

  /** Contenu complet écrit par l'assistant (repli sans flux) : édition minimale, lignes surlignées. */
  async function updateEditor(
    cheminBrut: string,
    contenu: string,
    disqueEcrit?: DisqueEcrit | null,
  ): Promise<void> {
    const chemin = l.canon(cheminBrut);
    const d = disqueEcrit || {};
    if (!settings.value.enable_editor) return;
    if (vis.officeIsViewerPath(chemin)) {
      await vis.editorRefreshViewer(chemin);
      return;
    }
    if (!e.showEditor.value) {
      if (settings.value.auto_open_editor_on_write === false) return;
      e.showEditor.value = true;
      e.showExplorer.value = false;
      await nextTick();
      void s.fs.loadSandboxFiles();
    }
    await l.initMonaco();
    const ed = monacoRef.instance;
    if (!ed) return;
    e.editorMode.value = "code";
    if (!openTabs.value.find((t) => t.path === chemin))
      openTabs.value.push({ path: chemin, name: chemin.split("/").pop() ?? chemin });
    activeTabPath.value = chemin;
    e.editorFilePath.value = chemin;
    _stashBeforeAssistantWrite(chemin);
    originalFileContent[chemin] = contenu;
    poserDans(e.diskConflicts, chemin, null);
    if (!modelOk(chemin)) {
      modeles.liberer(chemin);
      modeles.assurer(chemin, contenu, langageDe(chemin));
    }
    const m = models[chemin];
    if (m && modelOk(chemin)) {
      try {
        ed.setModel(m);
      } catch {
        /* éditeur libéré */
      }
    }
    l.robustLayout();
    if (!m || m.isDisposed()) return;
    disque._syncModelEol(m, d.eol);
    const actuel = m.getValue();
    if (actuel === contenu) {
      disque._adoptDisk(chemin, d);
      isEditorDirty.value = false;
      apercu.refreshPreview();
      if (chemin.toLowerCase().endsWith(".html")) apercu.previewPath.value = chemin;
      return;
    }
    const plage = editionMinimale(m, actuel, contenu);
    disque._adoptDisk(chemin, d);
    isEditorDirty.value = false;
    if (plage) _flashChangedLines(m, plage);
    try {
      const cur = monacoRef.instance;
      if (cur && cur.getModel() === m) {
        if (plage) cur.revealLineInCenter(plage.startLine);
        else cur.revealPositionInCenter({ lineNumber: 1, column: 1 });
      }
    } catch {
      /* éditeur libéré */
    }
    apercu.refreshPreview();
    if (chemin.toLowerCase().endsWith(".html")) apercu.previewPath.value = chemin;
  }

  // Défilement par l'utilisateur pendant le flux : le suivi automatique s'arrête (200 ms après une action interne).
  function suivreDefilement(etat: EtatFlux): void {
    const ed = monacoRef.instance;
    if (!ed) return;
    etat._lastInternalAction = Date.now();
    etat._scrollDisp = ed.onDidScrollChange(() => {
      if (!etat.active) return;
      if (Date.now() - (etat._lastInternalAction || 0) < 200) return;
      etat.userGrabbed = true;
    });
  }
  const actionInterne = (etat: EtatFlux): void => {
    etat._lastInternalAction = Date.now();
  };
  function montrerCurseur(etat: EtatFlux): void {
    const ed = monacoRef.instance;
    if (etat.userGrabbed || !ed) return;
    const m = models[etat.path];
    if (!m || m.isDisposed() || ed.getModel() !== m) return;
    try {
      actionInterne(etat);
      ed.revealPosition({ lineNumber: etat.curLine, column: etat.curCol });
    } catch {
      /* éditeur libéré */
    }
  }
  function libererEtat(chemin: string, etat: EtatFlux | undefined): void {
    if (!etat) return;
    try {
      etat._scrollDisp?.dispose();
    } catch {
      /* déjà libéré */
    }
    etat._scrollDisp = null;
    etat.active = false;
    if (writeStreams[chemin] === etat) delete writeStreams[chemin];
  }
  function demarrer(etat: EtatFlux, debutLigne: number, debutCol: number): void {
    writeStreams[etat.path] = etat;
    e.isTypingEffect.value = true;
    // Seul l'onglet écrit perd son « modifié ».
    if (activeTabPath.value === etat.path) isEditorDirty.value = false;
    suivreDefilement(etat);
    try {
      actionInterne(etat);
      monacoRef.instance?.revealPositionInCenter({ lineNumber: debutLigne, column: debutCol });
    } catch {
      /* éditeur libéré */
    }
  }

  /** Prépare l'écriture en flux d'un fichier complet (`append` : à la suite) ; faux si impossible. */
  async function streamOpenForWrite(cheminBrut: string, opts: OptionsFluxEcriture = {}): Promise<boolean> {
    let chemin = cheminBrut;
    try {
      chemin = l.canon(cheminBrut);
      if (!chemin || !settings.value.enable_editor) return false;
      const ajout = !!opts.append;
      if (writeStreams[chemin]?.active) await streamFinalize(chemin, { success: false });
      const ongletExistait = openTabs.value.some((t) => t.path === chemin);
      const existant = models[chemin];
      const avantConnu = (!!existant && !existant.isDisposed()) || typeof opts.preloadContent === "string";
      _stashBeforeAssistantWrite(chemin);
      const m = await _ensureFileInEditor(chemin, opts.preloadContent || "");
      if (!m) return false;
      const avant = m.getValue();
      arretAnnulation(m);
      const avantOrig = originalFileContent[chemin];
      let ligne: number;
      let col: number;
      if (ajout) {
        ligne = m.getLineCount();
        col = m.getLineMaxColumn(ligne);
      } else {
        try {
          const derniere = m.getLineCount();
          const r = range(1, 1, derniere, m.getLineMaxColumn(derniere));
          if (!r) return false;
          pousser(m, [{ range: r, text: "" }]);
        } catch {
          return false;
        }
        ligne = 1;
        col = 1;
      }
      demarrer(
        {
          path: chemin,
          kind: ajout ? "write_append" : "write_full",
          createdTab: !ongletExistait,
          preSnapshot: avant,
          preOriginal: avantOrig,
          preKnown: avantConnu,
          curLine: ligne,
          curCol: col,
          startLineStream: ligne,
          active: true,
          userGrabbed: false,
          _scrollDisp: null,
          _lastInternalAction: Date.now(),
        },
        ligne,
        col,
      );
      return true;
    } catch (err) {
      journal.avertir("[editor] streamOpenForWrite a échoué pour", chemin, err);
      e.isTypingEffect.value = false;
      libererEtat(chemin, writeStreams[chemin]);
      return false;
    }
  }

  /** Prépare l'écriture en flux d'une édition (`str_replace`, `replace`, `insert`) ; faux si la zone est introuvable. */
  async function streamLocateEdit(cheminBrut: string, spec: SpecEdition = {}): Promise<boolean> {
    let chemin = cheminBrut;
    try {
      chemin = l.canon(cheminBrut);
      if (!chemin || !settings.value.enable_editor) return false;
      const action = (spec.action || "").toLowerCase();
      if (writeStreams[chemin]?.active) await streamFinalize(chemin, { success: false });
      const ongletExistait = openTabs.value.some((t) => t.path === chemin);
      _stashBeforeAssistantWrite(chemin);
      const m = await _ensureFileInEditor(chemin, spec.preloadContent || "");
      if (!m) return false;
      const avant = m.getValue();
      arretAnnulation(m);
      const avantOrig = originalFileContent[chemin];
      let ligne = 1;
      let col = 1;
      try {
        if (action === "str_replace") {
          const ancien = String(spec.old_str || "");
          if (!ancien || !avant) return false;
          const r = m.findMatches(ancien, true, false, true, null, false)[0]?.range;
          if (!r) return false;
          pousser(m, [{ range: r, text: "" }]);
          ligne = r.startLineNumber;
          col = r.startColumn;
        } else if (action === "replace") {
          const debut = Math.max(1, parseInt(String(spec.start_line), 10) || 1);
          const fin = Math.max(debut, parseInt(String(spec.end_line), 10) || debut);
          const n = m.getLineCount();
          const a = Math.min(debut, n);
          const b = Math.min(fin, n);
          const r = range(a, 1, b, m.getLineMaxColumn(b));
          if (!r) return false;
          pousser(m, [{ range: r, text: "" }]);
          ligne = a;
          col = 1;
        } else if (action === "insert") {
          let debut = parseInt(String(spec.start_line), 10);
          if (isNaN(debut)) debut = 0;
          const n = m.getLineCount();
          if (debut === 0) {
            ligne = 1;
            col = 1;
          } else if (debut === -1 || debut > n) {
            const derniere = Math.max(n, 1);
            const finCol = m.getLineMaxColumn(derniere);
            if (m.getLineContent(derniere).length > 0) {
              const r = range(derniere, finCol, derniere, finCol);
              if (!r) return false;
              pousser(m, [{ range: r, text: "\n" }]);
              ligne = derniere + 1;
              col = 1;
            } else {
              ligne = derniere;
              col = 1;
            }
          } else {
            ligne = Math.min(debut, n);
            col = 1;
          }
        } else {
          return false;
        }
      } catch {
        return false;
      }
      demarrer(
        {
          path: chemin,
          kind: "edit_" + action,
          createdTab: !ongletExistait,
          preSnapshot: avant,
          preOriginal: avantOrig,
          curLine: ligne,
          curCol: col,
          startLineStream: ligne,
          active: true,
          userGrabbed: false,
          _scrollDisp: null,
          _lastInternalAction: Date.now(),
        },
        ligne,
        col,
      );
      return true;
    } catch (err) {
      journal.avertir("[editor] streamLocateEdit a échoué pour", chemin, err);
      e.isTypingEffect.value = false;
      libererEtat(chemin, writeStreams[chemin]);
      return false;
    }
  }

  function streamWriteChunk(chemin: string, fragment: string): void {
    const etat = writeStreams[l.canon(chemin)];
    if (!etat || !etat.active || !fragment) return;
    etat.pendingChunk = (etat.pendingChunk || "") + fragment;
    planifierLot(etat);
  }

  function appliquerFragment(etat: EtatFlux, fragment: string): boolean {
    const m = models[etat.path];
    if (!m || m.isDisposed()) {
      etat.active = false;
      return false;
    }
    actionInterne(etat);
    try {
      const r = range(etat.curLine, etat.curCol, etat.curLine, etat.curCol);
      if (!r) return false;
      pousser(m, [{ range: r, text: fragment, forceMoveMarkers: true }]);
    } catch {
      etat.active = false;
      return false;
    }
    const pos = avancer(etat.curLine, etat.curCol, fragment);
    etat.curLine = pos.ligne;
    etat.curCol = pos.col;
    montrerCurseur(etat);
    return true;
  }

  function planifierLot(etat: EtatFlux): void {
    if (etat._flushScheduled) return;
    etat._flushScheduled = true;
    prochaineImage(() => {
      etat._flushScheduled = false;
      if (!etat.active) {
        etat.pendingChunk = "";
        return;
      }
      const tampon = etat.pendingChunk || "";
      if (!tampon) return;
      const n = tailleLot(tampon.length);
      etat.pendingChunk = tampon.substring(n);
      appliquerFragment(etat, tampon.substring(0, n));
      if (etat.pendingChunk.length > 0 && etat.active) planifierLot(etat);
    });
  }

  function viderSync(etat: EtatFlux): void {
    if (!etat.pendingChunk) return;
    const tampon = etat.pendingChunk;
    etat.pendingChunk = "";
    if (etat.active) appliquerFragment(etat, tampon);
  }

  /** Clôt le flux : échec = retour au contenu d'avant (onglet créé par le flux retiré) ; succès = réconciliation avec le contenu final. */
  async function streamFinalize(cheminBrut: string, opts: OptionsFinFlux = {}): Promise<void> {
    const chemin = l.canon(cheminBrut);
    const etat = writeStreams[chemin];
    if (!etat) return;
    const succes = opts.success !== false;
    try {
      if (succes) {
        const limite = Date.now() + 2000;
        while (etat.active && (etat.pendingChunk || etat._flushScheduled) && Date.now() < limite) {
          await new Promise<void>((r) => prochaineImage(() => r()));
        }
        viderSync(etat);
      }
      libererEtat(chemin, etat);
      if (!succes && etat.createdTab) {
        modeles.liberer(chemin);
        delete originalFileContent[chemin];
        openTabs.value = openTabs.value.filter((t) => t.path !== chemin);
        if (activeTabPath.value === chemin) {
          const dernier = openTabs.value[openTabs.value.length - 1];
          if (dernier) {
            try {
              await l.switchTab(dernier.path);
            } catch {
              /* onglet disparu */
            }
          } else {
            activeTabPath.value = null;
            e.editorFilePath.value = "";
            try {
              monacoRef.instance?.setModel(null);
            } catch {
              /* éditeur libéré */
            }
          }
        }
        isEditorDirty.value = false;
        apercu.refreshPreview();
        return;
      }
      const m = models[chemin];
      if (!m || m.isDisposed()) return;
      if (!succes) {
        const actuel = m.getValue();
        if (actuel !== etat.preSnapshot) editionMinimale(m, actuel, etat.preSnapshot || "");
        if (etat.preOriginal !== undefined) originalFileContent[chemin] = etat.preOriginal;
        poserDans(assistantStash, chemin, null);
        l.scheduleDirtyRefresh();
        if (activeTabPath.value === chemin) isEditorDirty.value = false;
        if (activeTabPath.value === chemin || apercu.previewPath.value === chemin) apercu.refreshPreview();
        return;
      }
      if (typeof opts.finalContent === "string") {
        disque._syncModelEol(m, opts.disk?.eol);
        const actuel = m.getValue();
        if (actuel !== opts.finalContent) editionMinimale(m, actuel, opts.finalContent);
        disque._adoptDisk(chemin, opts.disk || {});
      } else {
        originalFileContent[chemin] = m.getValue();
        poserDans(e.diskConflicts, chemin, null);
        disque.checkExternalModsSoon(300);
      }
      if (activeTabPath.value === chemin) isEditorDirty.value = false;
      l.scheduleDirtyRefresh();
      l.scheduleScmRefresh(chemin);
      try {
        const fin = Math.min(Math.max(etat.curLine, etat.startLineStream || 1), m.getLineCount());
        const debut = Math.max(1, Math.min(etat.startLineStream || 1, fin));
        _flashChangedLines(m, { startLine: debut, endLine: fin });
      } catch {
        /* modèle libéré */
      }
      if (activeTabPath.value === chemin || apercu.previewPath.value === chemin) apercu.refreshPreview();
      if (activeTabPath.value === chemin && chemin.toLowerCase().endsWith(".html"))
        apercu.previewPath.value = chemin;
    } finally {
      e.isTypingEffect.value = false;
      arretAnnulation(models[chemin]);
      libererEtat(chemin, writeStreams[chemin] === etat ? etat : undefined);
    }
  }

  function isStreamActive(chemin: string | null | undefined): boolean {
    return !!writeStreams[l.canon(chemin || "")]?.active;
  }

  function getStreamPreSnapshot(chemin: string): string | null {
    const etat = writeStreams[l.canon(chemin)];
    return etat && etat.preKnown !== false ? etat.preSnapshot : null;
  }

  function capturePreWrite(chemin: string): string | null {
    const m = chemin ? models[chemin] : undefined;
    if (!m || m.isDisposed()) return null;
    try {
      return m.getValue();
    } catch {
      return null;
    }
  }

  /** Flux en cours abandonnés (fin de session, éditeur désactivé). */
  function libererFlux(): void {
    for (const p of Object.keys(writeStreams)) libererEtat(p, writeStreams[p]);
  }

  return {
    _flashChangedLines,
    updateEditor,
    streamOpenForWrite,
    streamLocateEdit,
    streamWriteChunk,
    streamFinalize,
    isStreamActive,
    getStreamPreSnapshot,
    capturePreWrite,
    libererFlux,
  };
}
