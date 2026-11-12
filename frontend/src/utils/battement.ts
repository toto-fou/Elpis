// SPDX-License-Identifier: MIT
/** frontend/src/utils/battement.ts — drapeau partagé entre le flux du chat et le fil de conversation : un battement écrit en ce moment le bas du fil. */

let enCours = false;

export function marquerBattement(actif: boolean): void {
  enCours = actif;
}

export function battementEnCours(): boolean {
  return enCours;
}
