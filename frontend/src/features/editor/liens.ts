// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/liens.ts — liaisons entre les parties du composant éditeur : services créés d'abord, fonctions croisées résolues à l'appel (table remplie par `setupEditor`). */
import type { Terminal } from "@xterm/xterm";

import type { setupEditorPreview } from "./apercu";
import type { setupEditorStatusBar } from "./barre-etat";
import type { setupEditorDisk } from "./disque";
import type { Modele } from "./etat";
import type { setupEditorSandboxFs } from "./fichiers";
import type { setupEditorGit } from "./git";
import type { PropositionIa } from "./ia";
import type { setupEditorTabMemory } from "./memoire-onglets";
import type { RegistreModeles } from "./modeles";
import type { ServiceSauvegarde } from "./sauvegarde";
import type { setupEditorTerminal } from "../terminal/sessions";
import type { setupEditorViewers } from "./visionneuses";

export interface OptionsEnregistrement {
  silent?: boolean;
  force?: boolean;
  path?: string | null;
  source?: string;
}

export interface OptionsOuverture {
  quiet?: boolean;
}

/** Services de l'éditeur, créés avant ses parties (leurs rappels passent par `LiensEditeur`). */
export interface ServicesEditeur {
  modeles: RegistreModeles<Modele>;
  models: Record<string, Modele>;
  vis: ReturnType<typeof setupEditorViewers>;
  disque: ReturnType<typeof setupEditorDisk>;
  apercu: ReturnType<typeof setupEditorPreview>;
  memoire: ReturnType<typeof setupEditorTabMemory>;
  terminal: ReturnType<typeof setupEditorTerminal>;
  fs: ReturnType<typeof setupEditorSandboxFs>;
  git: ReturnType<typeof setupEditorGit>;
  barre: ReturnType<typeof setupEditorStatusBar>;
  sauvegarde: ServiceSauvegarde;
}

/** Fonctions d'une partie appelées par une autre ; résolues à l'appel. */
export interface LiensEditeur {
  canon(chemin: string): string;
  initMonaco(): Promise<void>;
  openFile(chemin: string, forceReload?: boolean, opts?: OptionsOuverture): Promise<void>;
  switchTab(chemin: string): Promise<void>;
  closeTab(chemin: string, ev?: Event | null, force?: boolean): Promise<void>;
  tabIsDirty(chemin: string | null | undefined): boolean;
  saveCurrentViewState(): void;
  restoreViewStateFor(chemin: string): boolean;
  pushNav(): void;
  scheduleDirtyRefresh(): void;
  scrollTabIntoView(chemin: string | null): void;
  closeTabCtxMenu(): void;
  rememberRecent(chemin: string): void;
  setSplitFile(chemin: string): void;
  exitSplit(): void;
  enterSplitPreview(): void;
  scheduleRenderPane(): void;
  saveEditorContent(opts?: OptionsEnregistrement): Promise<void>;
  scheduleLint(chemin: string, code?: string): void;
  formatPython(
    modele: Modele,
  ): Promise<Array<{ range: ReturnType<Modele["getFullModelRange"]>; text: string }>>;
  loadHistorySession(): Promise<void>;
  isStreamActive(chemin: string | null | undefined): boolean;
  updateDiffView(): void;
  showDiffForMessage(chemin: string, avant: string | null, base?: string): void;
  proposeAiEdit(p: PropositionIa): boolean;
  rejectAiProposal(opts?: { silent?: boolean }): void;
  scheduleScmRefresh(chemin: string): void;
  clearScm(chemin: string): void;
  loadHead(chemin: string, force?: boolean): Promise<string | null>;
  headText(chemin: string): string | null;
  forceLayout(): void;
  robustLayout(): void;
  smoothOpenLayout(): void;
  relayoutDuringTransition(): void;
  closeEditorCtxMenu(): void;
  openEditorCtxMenu(e: MouseEvent): void;
  editorCtxComplete(): Promise<void>;
  monacoConsumesEscape(e: KeyboardEvent): boolean;
  revealActiveInTree(chemin?: string): void;
  scheduleTreeRefreshAfterCommand(): void;
  registerTermLinks(term: Terminal): void;
}
