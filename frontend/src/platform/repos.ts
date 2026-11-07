// SPDX-License-Identifier: MIT
/** frontend/src/platform/repos.ts — travaux reportés au premier moment de repos du navigateur : les bibliothèques lourdes se chargent avant le premier geste qui les demande. */

/** Lance `tache` quand le navigateur est au repos, au plus tard après `delai` ms. */
export function auRepos(tache: () => void, delai = 3000): void {
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(() => tache(), { timeout: delai });
  else setTimeout(tache, Math.min(delai, 1500));
}
