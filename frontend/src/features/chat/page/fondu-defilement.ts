// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/fondu-defilement.ts — fondu haut/bas d'une liste qui défile : classes fade-top et fade-bottom selon la position (masque dégradé de style.css). */

/** Branche le fondu sur `el` (défilement, taille, contenu) ; rend la fonction qui le détache. */
export function fonduDefilement(el: HTMLElement): () => void {
  let image: number | null = null;
  const appliquer = (): void => {
    image = null;
    el.classList.toggle("fade-top", el.scrollTop > 6);
    el.classList.toggle("fade-bottom", el.scrollTop + el.clientHeight < el.scrollHeight - 6);
  };
  // Une mise à jour par image au plus pendant le défilement.
  const planifier = (): void => {
    image ??= requestAnimationFrame(appliquer);
  };
  el.addEventListener("scroll", planifier, { passive: true });
  const taille = typeof ResizeObserver !== "undefined" ? new ResizeObserver(planifier) : null;
  taille?.observe(el);
  const contenu = typeof MutationObserver !== "undefined" ? new MutationObserver(planifier) : null;
  contenu?.observe(el, { childList: true, subtree: true });
  appliquer();
  return () => {
    el.removeEventListener("scroll", planifier);
    taille?.disconnect();
    contenu?.disconnect();
    if (image !== null) cancelAnimationFrame(image);
    image = null;
  };
}
