// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/brouillons.ts — saisies d'une page qui s'enregistrent hors de la barre (clé, mot de passe, sauvegarde distante) : déclarées pour que la sortie de page ne les perde pas en silence. */
import { reactive } from "vue";

export interface Brouillon {
  readonly id: string;
  readonly page: string;
  readonly label: string;
  enCours(): boolean;
  enregistrer(): Promise<boolean>;
  abandonner(): void;
}

const declares = reactive<Record<string, Brouillon>>({});

/** Déclare (ou remplace) un brouillon hors barre. */
export function declarerBrouillon(b: Brouillon): void {
  declares[b.id] = b;
}

export function brouillonsEnCours(page: string): Brouillon[] {
  return Object.values(declares).filter((b) => b.page === page && b.enCours());
}

export function oublierBrouillons(): void {
  for (const k of Object.keys(declares)) delete declares[k];
}
