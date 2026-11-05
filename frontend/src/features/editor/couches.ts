// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/couches.ts — menus de l'éditeur lié au skin : pile fermée d'abord par Échap, accès au DOM (élément actif, explorateur posé sur le code). */

const couches: (() => void)[] = [];

/** Menu ouvert : fermé le premier par Échap ; la fonction rendue le retire. */
export function empilerCouche(fermer: () => void): () => void {
  couches.push(fermer);
  return () => {
    const i = couches.lastIndexOf(fermer);
    if (i >= 0) couches.splice(i, 1);
  };
}

/** Échap de la cascade globale : ferme le menu du dessus ; faux s'il n'y en a pas. */
export function fermerCoucheOuverte(): boolean {
  const dessus = couches[couches.length - 1];
  if (!dessus) return false;
  dessus();
  return true;
}

/** Suit la largeur de l'élément ; la fonction rendue arrête le suivi. */
export function suivreLargeur(el: Element, rappel: (largeur: number) => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  const obs = new ResizeObserver((e) => rappel(e[0]?.contentRect.width ?? 0));
  obs.observe(el);
  return () => obs.disconnect();
}

/** Décale un menu pour qu'il reste dans le cadre qui le rogne (colonne ou fenêtre étroites). */
export function garderDansCadre(menu: HTMLElement | null): void {
  const cadre = menu?.closest(".elpis-ed-corps, [data-editor-root]");
  if (!menu || !cadre) return;
  menu.style.translate = "";
  const m = menu.getBoundingClientRect();
  const c = cadre.getBoundingClientRect();
  const marge = 6;
  const ecart =
    m.left < c.left + marge
      ? c.left + marge - m.left
      : m.right > c.right - marge
        ? c.right - marge - m.right
        : 0;
  if (ecart) menu.style.translate = `${Math.round(ecart)}px`;
}

export function elementActif(): Element | null {
  return document.activeElement;
}

/** Vrai quand l'explorateur est posé par-dessus le code (fenêtre étroite). */
export function explorateurSuperpose(): boolean {
  const el = document.querySelector(".elpis-ed-explorateur");
  return !!el && getComputedStyle(el).position === "absolute";
}
