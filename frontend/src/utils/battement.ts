// SPDX-License-Identifier: MIT
/** frontend/src/utils/battement.ts — drapeau partagé entre le flux du chat et le fil de conversation : le battement du flux fait glisser le fil vers son bas, il est seul à l'écrire. */

let enCours = false;

export function marquerBattement(actif: boolean): void {
  enCours = actif;
}

export function battementEnCours(): boolean {
  return enCours;
}
