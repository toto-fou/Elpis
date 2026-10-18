// SPDX-License-Identifier: MIT
/** apps/core/src/llm/registre-caches.ts — registres d'invalidation des caches du moteur (module feuille : chaque cache s'y inscrit à son chargement, sans import croisé). */

const globales = new Map<string, () => number>();
const auChangement = new Map<string, () => void>();

/** Invalidation globale (bouton admin) : `cleResume` du bilan ← nombre d'entrées vidées par le rappel. */
export function surInvalidationGlobale(cleResume: string, rappel: () => number): void {
  globales.set(cleResume, rappel);
}

/** Changement du modèle chargé (chargement ou déchargement réussi). */
export function surChangementDeModele(nom: string, rappel: () => void): void {
  auChangement.set(nom, rappel);
}

/** Entrées vidées par le cache inscrit sous `cleResume` ; 0 s'il est absent ou en échec. */
export function viderInscrit(cleResume: string): number {
  const rappel = globales.get(cleResume);
  if (rappel === undefined) return 0;
  try {
    return rappel();
  } catch {
    return 0;
  }
}

export function viderAuChangement(): void {
  for (const rappel of auChangement.values()) {
    try {
      rappel();
    } catch {
      // un cache en échec ne bloque pas les autres
    }
  }
}
