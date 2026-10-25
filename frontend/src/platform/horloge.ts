// SPDX-License-Identifier: MIT
/** frontend/src/platform/horloge.ts — heure du serveur vue du navigateur : écart d'horloge estimé par l'en-tête `Date` des réponses, pour mesurer une durée depuis un horodatage du serveur. */

// L'en-tête `Date` est à la seconde près : un écart plus petit que ce seuil est du bruit, pas un décalage.
const SEUIL_S = 2;
let ecartS = 0;

/** Retient l'écart entre l'heure du serveur (en-tête `Date`) et celle du navigateur ; ignoré s'il manque ou est illisible. */
export function noterHeureServeur(entete: string | null | undefined, recuA = Date.now()): void {
  if (!entete) return;
  const t = Date.parse(entete);
  if (!Number.isFinite(t)) return;
  const e = (t - recuA) / 1000;
  if (Math.abs(e) < SEUIL_S) ecartS = 0;
  else if (Math.abs(e - ecartS) >= SEUIL_S / 2) ecartS = e;
}

/** Secondes d'époque à l'heure du serveur. */
export function maintenantServeurS(): number {
  return Date.now() / 1000 + ecartS;
}

/** Remet l'écart à zéro (tests). */
export function oublierHeureServeur(): void {
  ecartS = 0;
}
