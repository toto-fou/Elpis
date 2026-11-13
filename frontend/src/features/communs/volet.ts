// SPDX-License-Identifier: MIT
/** frontend/src/features/communs/volet.ts — volet coulissant (<Transition name="volet">) : largeur tenue jusqu'à la sortie du contenu, focus passé au volet ou rendu à son déclencheur. */
import { nextTick, ref, watch } from "vue";
import type { Ref } from "vue";

import { SELECTEUR_FOCUSABLES } from "../../utils/focus";

export interface CrochetsVolet {
  onBeforeEnter(): void;
  onEnter(el: Element): void;
  onBeforeLeave(el: Element): void;
  onAfterLeave(): void;
}

// Élément affiché (style seul, sans mise en page) ; vrai là où l'API manque.
function affiche(el: Element | null | undefined): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && (el.checkVisibility?.() ?? true);
}

function focaliser(el: Element | null | undefined): void {
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
}

function actif(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * `ouvert` : état demandé ; `deplie` reste vrai jusqu'à la fin de la sortie du contenu (la largeur se replie ensuite).
 * `repli` : partie affichée volet replié (rail réduit), qui reçoit le focus quand son déclencheur a disparu.
 */
export function useVolet(
  ouvert: () => boolean,
  repli?: () => Element | null | undefined,
): { deplie: Ref<boolean>; crochets: CrochetsVolet } {
  const deplie = ref(ouvert());
  let montre = deplie.value;
  let declencheur: HTMLElement | null = null;
  let quitte: HTMLElement | null = null;
  let rendre = false;
  // Lu au geste, avant le rendu : la largeur est juste dès la première image et l'élément actif est encore celui de l'utilisateur.
  watch(
    ouvert,
    (v) => {
      if (v) declencheur = actif();
      else quitte = actif();
      if (v || !montre) deplie.value = v;
    },
    { flush: "sync" },
  );
  const crochets: CrochetsVolet = {
    onBeforeEnter() {
      montre = true;
    },
    onEnter(el) {
      if (declencheur && !el.contains(declencheur) && !affiche(declencheur))
        focaliser(el.querySelector(SELECTEUR_FOCUSABLES));
    },
    onBeforeLeave(el) {
      rendre = !!quitte && el.contains(quitte);
      if (rendre && declencheur && !el.contains(declencheur) && affiche(declencheur)) {
        focaliser(declencheur);
        rendre = false;
      }
    },
    onAfterLeave() {
      montre = false;
      if (ouvert()) return;
      deplie.value = false;
      if (!rendre) return;
      rendre = false;
      void nextTick(() =>
        focaliser(affiche(declencheur) ? declencheur : repli?.()?.querySelector(SELECTEUR_FOCUSABLES)),
      );
    },
  };
  return { deplie, crochets };
}
