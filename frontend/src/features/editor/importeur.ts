// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/importeur.ts — import vers le bac de la page, branché par la racine : l'arbre et l'éditeur y déposent fichiers et dossiers. */

export interface Importeur {
  fichiers(fichiers: FileList | readonly File[], dossier: string): Promise<void>;
  entrees(entrees: readonly FileSystemEntry[], dossier: string): Promise<void>;
}

let actuel: Importeur | null = null;

export function brancherImporteur(importeur: Importeur | null): void {
  actuel = importeur;
}

/** L'importeur de la page, absent sur la console. */
export function importeur(): Importeur | null {
  return actuel;
}
