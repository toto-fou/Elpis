// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/etat.ts — état du composant éditeur : refs de l'interface, éditeurs Monaco (non réactifs), tables par chemin (contenu disque, états de vue, flux en cours). */
import { computed, markRaw, ref } from "vue";
import type { Ref } from "vue";
import type * as M from "monaco-editor";

import type { ConflitDisque, CopieAssistant } from "./disque";
import type { MenuContexteEditeur } from "./ia";
import type { ReglagesEditeur } from "./instances";
import type { OngletEditeur } from "./onglets";
import type { NoeudArbre } from "./schemas-bac";

export type Modele = M.editor.ITextModel;
export type EditeurCode = M.editor.IStandaloneCodeEditor;
export type EditeurDiff = M.editor.IStandaloneDiffEditor;
export type FetchAuth = (url: string, init?: RequestInit, soft?: boolean) => Promise<Response | null>;

/** Éditeurs vivants : objets tiers jamais proxifiés, remis à `null` à la libération. */
export interface RefMonaco {
  instance: EditeurCode | null;
  instance2: EditeurCode | null;
  diff: EditeurDiff | null;
  initPromise: Promise<void> | null;
  originalModel: Modele | null;
}

export interface Utilisateur {
  id?: string | number;
  username?: string;
  [cle: string]: unknown;
}

export interface Choix {
  id: string;
  label: string;
  tone: string;
}

/** Contexte fourni par la racine historique (app.js) : getters lus à l'appel. */
export interface CtxEditeur {
  showToast(message: string, type?: string): void;
  fetchAuth: FetchAuth;
  openConfirm(
    titre: string,
    texte: string,
    danger?: boolean,
    ok?: string,
    annuler?: string,
  ): Promise<boolean>;
  openPrompt(titre: string, valeur: string, indice?: string): Promise<string | null | undefined>;
  openChoice?: (titre: string, texte: string, choix: Choix[]) => Promise<string | null | undefined>;
  insertIntoChat?: (texte: string) => void;
  attachFileToChat?: (chemin: string) => unknown;
  handleSessionExpired?: () => unknown;
  readonly showSidebar: Ref<boolean>;
  readonly features?:
    Ref<{ office_preview?: boolean; [cle: string]: unknown } | null | undefined> | undefined;
  readonly availableModels?: Ref<string[]> | null | undefined;
  readonly activeModelIds?: Ref<string[]> | null | undefined;
}

export interface RefsPartagees {
  user: Ref<Utilisateur | null>;
  settings: Ref<ReglagesEditeur>;
}

export interface Quota {
  used_mb: number;
  quota_mb: number;
  pct: number;
  [cle: string]: unknown;
}

/** Barre d'onglets (composant OngletsEditeur) : mesure et défilement. */
export interface CommandesBarreOnglets {
  mesurer(): void;
  defiler(chemin: string | null): void;
}

export interface MenuOngletEtat {
  show: boolean;
  x: number;
  y: number;
  path: string;
}

/** Écriture en flux de l'assistant dans un onglet. */
export interface EtatFlux {
  path: string;
  kind: string;
  createdTab: boolean;
  preSnapshot: string;
  preOriginal: string | undefined;
  preKnown?: boolean;
  curLine: number;
  curCol: number;
  startLineStream: number;
  active: boolean;
  userGrabbed: boolean;
  pendingChunk?: string;
  _flushScheduled?: boolean;
  _scrollDisp: M.IDisposable | null;
  _lastInternalAction: number;
}

/** Remplace l'entrée `chemin` d'une table réactive (objet neuf à chaque mutation) ; `null` la retire. */
export function poserDans<T>(r: Ref<Record<string, T>>, chemin: string, valeur: T | null): void {
  const suivant = { ...r.value };
  if (valeur == null) delete suivant[chemin];
  else suivant[chemin] = valeur;
  r.value = suivant;
}

export function creerEtatEditeur() {
  const activeTabPath = ref<string | null>(null);
  const showHiddenFiles = ref(false);
  try {
    showHiddenFiles.value = localStorage.getItem("elpis.showHiddenFiles") === "1";
  } catch {
    /* stockage interdit */
  }
  return {
    showEditor: ref(false),
    showExplorer: ref(true),
    explorerWidth: ref(224),
    editorFullscreen: ref(false),
    splitView: ref(false),
    splitTabPath: ref<string | null>(null),
    activePane: ref<"left" | "right">("left"),
    splitRatio: ref(50),
    splitMode: ref<"code" | "preview" | "render">("code"),
    showEscapeHint: ref(false),
    showEditorMore: ref(false),
    diskConflicts: ref<Record<string, ConflitDisque>>({}),
    assistantStash: ref<Record<string, CopieAssistant>>({}),
    sandboxFiles: ref<NoeudArbre[]>([]),
    sandboxQuota: ref<Quota>({ used_mb: 0, quota_mb: 5120, pct: 0 }),
    isLoadingFiles: ref(false),
    showHiddenFiles,
    fileInput: ref<HTMLInputElement | null>(null),
    openTabs: ref<OngletEditeur[]>([]),
    activeTabPath,
    breadcrumbSegments: computed(() => {
      const p = activeTabPath.value;
      if (!p) return [];
      const parts = String(p).split("/").filter(Boolean);
      let prefixe = "";
      return parts.map((name, i) => {
        prefixe = prefixe ? prefixe + "/" + name : name;
        return { name, prefix: prefixe, isLast: i === parts.length - 1 };
      });
    }),
    isEditorDirty: ref(false),
    isTypingEffect: ref(false),
    editorFilePath: ref(""),
    isDiffView: ref(false),
    editorMode: ref<"code" | "preview">("code"),
    diffBase: ref("saved"),
    sandboxSearch: ref(""),
    sandboxSearchResults: ref<Array<{ path: string; line?: number | null; [cle: string]: unknown }>>([]),
    isSearchingSandbox: ref(false),
    sandboxSearchMode: ref("content"),
    sandboxFileInput: ref<HTMLInputElement | null>(null),
    sandboxFolderInput: ref<HTMLInputElement | null>(null),
    showImportMenu: ref(false),
    fimLoading: ref(false),
    fimGhostText: ref(""),
    editorCtxMenu: ref<MenuContexteEditeur>({
      show: false,
      x: 0,
      y: 0,
      hasSelection: false,
      selectionText: "",
      lineCount: 0,
    }),
    mdPreview: ref(false),
    svgPreview: ref(false),
    tabCtxMenu: ref<MenuOngletEtat>({ show: false, x: 0, y: 0, path: "" }),
    dirtyTabs: ref(new Set<string>()),
    tabStripRef: ref<CommandesBarreOnglets | null>(null),
    hiddenTabsCount: ref(0),
    showTabsOverflow: ref(false),
    monacoRef: markRaw<RefMonaco>({
      instance: null,
      instance2: null,
      diff: null,
      initPromise: null,
      originalModel: null,
    }),
    /** Chemin → contenu disque connu (base du « modifié »). */
    originalFileContent: {} as Record<string, string | undefined>,
    tabViewStates: Object.create(null) as Record<string, M.editor.ICodeEditorViewState>,
    /** Chemins dont l'écriture en flux a été interrompue éditeur fermé : relus à la réouverture. */
    pathsNeedingReload: new Set<string>(),
    /** Chemins dont la dernière ouverture a échoué pour une cause passagère (pas un 404). */
    openTransientFail: new Set<string>(),
    writeStreams: Object.create(null) as Record<string, EtatFlux>,
    /** Prochain enregistrement de ces chemins = « restauration » d'une version de l'historique. */
    restorePending: new Set<string>(),
  };
}

export type EtatEditeur = ReturnType<typeof creerEtatEditeur>;
