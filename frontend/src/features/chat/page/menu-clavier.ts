// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/menu-clavier.ts — clavier des menus ARIA du chat : entrées propres d'un `role="menu"` (sous-menus exclus), flèches, Début et Fin. */

const SELECTEUR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** Entrées du menu lui-même, dans l'ordre, sans celles de ses sous-menus ni des parties masquées. */
export function entreesMenu(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(SELECTEUR)].filter(
    (el) => el.closest('[role="menu"]') === menu && !el.closest("[hidden]"),
  );
}

/** Déplace le focus (flèches haut et bas en boucle, Début, Fin) ; vrai si la touche est consommée. */
export function naviguerMenu(e: KeyboardEvent, menu: HTMLElement): boolean {
  const items = entreesMenu(menu);
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let cible: HTMLElement | undefined;
  if (e.key === "ArrowDown") cible = items[(i + 1) % items.length];
  else if (e.key === "ArrowUp") cible = items[(i - 1 + items.length) % items.length];
  else if (e.key === "Home") cible = items[0];
  else if (e.key === "End") cible = items[items.length - 1];
  if (!cible) return false;
  e.preventDefault();
  cible.focus();
  return true;
}

export function focusPremiere(menu: HTMLElement | null | undefined): void {
  if (menu) entreesMenu(menu)[0]?.focus();
}

/** Vrai si le focus est dans l'élément (un menu qui va se fermer rend alors le focus à son bouton). */
export const contientFocus = (el: HTMLElement | null | undefined): boolean =>
  !!el?.contains(document.activeElement);

export const elementActif = (): HTMLElement | null =>
  document.activeElement instanceof HTMLElement ? document.activeElement : null;
