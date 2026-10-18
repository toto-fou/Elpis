// SPDX-License-Identifier: MIT
/** frontend/src/utils/depot.ts — horodatage du dernier dépôt traité : un dépôt sur un dossier de l'arbre ou une zone dédiée n'est pas retraité par la zone parente. */

let dernierDepot = 0;

export function marquerDepotTraite(): void {
  dernierDepot = Date.now();
}

/** Vrai si un dépôt a été traité il y a moins de `ms` millisecondes. */
export function depotDejaTraite(ms: number): boolean {
  return dernierDepot > 0 && Date.now() - dernierDepot < ms;
}
