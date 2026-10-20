// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/focus-volet.ts — focus d'un volet : il entre dans le volet à l'ouverture et retourne à ce qui l'avait à la fermeture. */

export function creerGardeFocus() {
  let appelant: HTMLElement | null = null;
  return {
    /** Mémorise l'élément focalisé (hors du volet) puis donne le focus à `cible`. */
    entrer(volet: HTMLElement | null, cible: HTMLElement | null): void {
      const actif = document.activeElement;
      appelant = actif instanceof HTMLElement && !volet?.contains(actif) ? actif : null;
      cible?.focus();
    },
    /** Rend le focus à l'élément mémorisé, s'il est toujours dans la page. */
    sortir(): void {
      const a = appelant;
      appelant = null;
      if (a?.isConnected) a.focus();
    },
  };
}
