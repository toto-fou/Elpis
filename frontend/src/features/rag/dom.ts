// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/dom.ts — page RAG, accès au DOM des composants (focus, clic extérieur) : les gabarits n'ont pas les globaux du navigateur. */

/** Élément qui a le focus. */
export function elementActif(): Element | null {
  return document.activeElement;
}

/** Vrai si le focus est perdu (sur le corps de la page ou nulle part). */
export function focusPerdu(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/** Donne le focus à l'élément d'identifiant `id`, s'il existe. */
export function focaliserId(id: string): void {
  document.getElementById(id)?.focus();
}

/** Écoute les appuis de pointeur (en capture) sur toute la page ; rend la fonction qui retire l'écoute. */
export function surPointeurPage(rappel: (e: Event) => void): () => void {
  document.addEventListener("pointerdown", rappel, true);
  return () => document.removeEventListener("pointerdown", rappel, true);
}

/** Fait défiler le conteneur jusqu'à l'élément d'identifiant `id`, au plus court. */
export function montrerId(id: string): void {
  document.getElementById(id)?.scrollIntoView?.({ block: "nearest" });
}
