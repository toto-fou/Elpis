// SPDX-License-Identifier: MIT
/** frontend/src/utils/focus.ts — focus des fenêtres : garde (mémorise puis restitue l'élément actif) et piège Tab. */

export interface GardeFocus {
  remember(): void;
  restore(): void;
}

export const SELECTEUR_FOCUSABLES =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Mémorise l'élément actif à l'ouverture d'une fenêtre et le refocalise à la fermeture s'il est encore là. */
export function gardeFocus(): GardeFocus {
  let memorise: HTMLElement | null = null;
  return {
    remember() {
      memorise = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    restore() {
      if (memorise && document.contains(memorise)) {
        try {
          memorise.focus();
        } catch {
          /* élément devenu inerte : rien à restituer */
        }
      }
      memorise = null;
    },
  };
}

/** Tab et Maj+Tab bouclent dans `conteneur`, sur ses éléments visibles. */
export function piegerTab(e: KeyboardEvent, conteneur: HTMLElement | null): void {
  if (!conteneur || e.key !== "Tab") return;
  const items = [...conteneur.querySelectorAll<HTMLElement>(SELECTEUR_FOCUSABLES)].filter(
    (el) => el.offsetParent !== null,
  );
  const premier = items[0];
  const dernier = items[items.length - 1];
  if (!premier || !dernier) return;
  const actif = document.activeElement;
  if (e.shiftKey && (actif === premier || !conteneur.contains(actif))) {
    e.preventDefault();
    dernier.focus();
  } else if (!e.shiftKey && actif === dernier) {
    e.preventDefault();
    premier.focus();
  }
}
