// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/domaine.ts — domaine de l'éditeur injecté dans ses composants SFC : surface de `setupEditor` plus les clés de la racine historique (app.js) que ses gabarits lisent. */
import { inject, onMounted, provide } from "vue";
import type { InjectionKey, ShallowUnwrapRef } from "vue";

import { journal } from "../../platform/journal";
import type { SurfaceEditeur } from "./editeur";
import type { ReglagesEditeur } from "./instances";

export interface ProgressionImport {
  active: boolean;
  phase: string;
  pct: number;
  files_done: number;
  total_files: number;
  current_file: string;
  skipped: number;
}

export interface ConnecteurGit {
  id: string | number;
  host?: string;
  label?: string;
  [cle: string]: unknown;
}

/** Clés de la racine (app.js, réglages, chat) lues par les gabarits de l'éditeur. */
export interface RacineEditeur {
  settings: ReglagesEditeur;
  uploadProgress: ProgressionImport;
  explorerDragOver: boolean;
  onExplorerDragOver(): void;
  onExplorerDragLeave(): void;
  handleExplorerDrop(ev: DragEvent): unknown;
  cancelSandboxUpload(): unknown;
  openContextMenu(ev: MouseEvent | KeyboardEvent, type: string, item: unknown): void;
  openSettings(): unknown;
  settingsTab: string;
  renderMarkdown(source: string): string;
  gitConnectors: ConnecteurGit[];
  loadGitConnectors(): unknown;
}

/** Surface vue des gabarits : refs déballées, fonctions internes (`_…`) retirées. */
export type DomaineEditeur = ShallowUnwrapRef<Omit<SurfaceEditeur, `_${string}`>> & RacineEditeur;

export const CLE_EDITEUR: InjectionKey<DomaineEditeur> = Symbol("elpis:editeur");

/** Clés de la racine, complètes à la compilation ; `showEditor` témoigne de la surface de `setupEditor`. */
const CLES: Readonly<Record<keyof RacineEditeur | "showEditor", true>> = {
  settings: true,
  uploadProgress: true,
  explorerDragOver: true,
  onExplorerDragOver: true,
  onExplorerDragLeave: true,
  handleExplorerDrop: true,
  cancelSandboxUpload: true,
  openContextMenu: true,
  openSettings: true,
  settingsTab: true,
  renderMarkdown: true,
  gitConnectors: true,
  loadGitConnectors: true,
  showEditor: true,
};

/** Lit le domaine fourni par un ancêtre ; son absence est une erreur de montage. */
export function domaineEditeur(): DomaineEditeur {
  const valeur = inject(CLE_EDITEUR, null);
  if (valeur === null) throw new Error("domaine de l'éditeur non fourni");
  return valeur;
}

export function clesAbsentesEditeur(racine: object): string[] {
  return Object.keys(CLES).filter((k) => !(k in racine));
}

/** Fournit le domaine depuis la racine historique ; à appeler dans son `setup`. */
export function fournirDomaineEditeur(racine: object): void {
  provide(CLE_EDITEUR, racine as DomaineEditeur);
  onMounted(() => {
    const absentes = clesAbsentesEditeur(racine);
    if (absentes.length) journal.avertir(`[éditeur] domaine : absent de la racine : ${absentes.join(", ")}`);
  });
}
