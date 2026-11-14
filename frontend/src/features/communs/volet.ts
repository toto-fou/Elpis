// SPDX-License-Identifier: MIT
/** frontend/src/features/communs/volet.ts — volet coulissant (<Transition name="volet">) : largeur qui glisse avec le geste (posée d'un coup en mouvement réduit), contenu gardé jusqu'à sa sortie, focus passé au volet ou rendu à son déclencheur. */
import { nextTick, ref, watch } from "vue";
import type { Ref } from "vue";

import { mouvementReduit } from "../../platform/mouvement";
import { SELECTEUR_FOCUSABLES } from "../../utils/focus";

export interface CrochetsVolet {
  onBeforeEnter(): void;
  onEnter(el: Element): void;
  onBeforeLeave(el: Element): void;
  onLeave(el: Element): void;
  onAfterLeave(el?: Element): void;
}

// Jetons de mouvement de style.css : une durée en ms (repli si le jeton manque), une courbe.
function dureeJeton(nom: string, repli: number): number {
  const m = /^([\d.]+)(ms|s)$/.exec(getComputedStyle(document.documentElement).getPropertyValue(nom).trim());
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : repli;
}
const courbeVolet = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue("--courbe-volet").trim() || "ease";

const glissements = new WeakMap<Element, Animation>();

function finirGlissement(el: Element): void {
  glissements.get(el)?.cancel();
  glissements.delete(el);
  el.classList.remove("volet-anime");
}

/** Panneau racine de la transition (MCP, Génération, éditeur) : sa largeur glisse de 0 à sa valeur ou l'inverse, la colonne du chat suit ; son contenu garde sa largeur finale. */
function glisserLargeur(el: Element, entree: boolean): void {
  if (!(el instanceof HTMLElement) || !el.classList.contains("elpis-slide-panel")) return;
  if (mouvementReduit() || typeof el.animate !== "function") return;
  const enCours = glissements.has(el);
  const actuelle = el.getBoundingClientRect().width;
  finirGlissement(el);
  const finale = el.getBoundingClientRect().width;
  if (!(finale > 0)) return;
  el.style.setProperty("--volet-largeur", `${finale}px`);
  el.classList.add("volet-anime");
  const depart = entree ? (enCours ? actuelle : 0) : actuelle;
  const a = el.animate(
    [
      { width: `${depart}px`, minWidth: "0px" },
      { width: `${entree ? finale : 0}px`, minWidth: "0px" },
    ],
    {
      duration: entree ? dureeJeton("--duree-longue", 260) : dureeJeton("--duree", 200),
      easing: courbeVolet(),
      fill: entree ? "none" : "forwards",
    },
  );
  glissements.set(el, a);
  // Entrée finie : le panneau reprend sa mise en page ; la sortie est retirée par `onAfterLeave`.
  if (entree) a.addEventListener("finish", () => glissements.get(el) === a && finirGlissement(el));
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
 * `ouvert` : état demandé ; `deplie` reste vrai jusqu'à la fin de la sortie du contenu (le rail réduit ne revient qu'ensuite).
 * `large` : largeur du volet, qui suit le geste tout de suite (sa transition la fait glisser) ; en mouvement réduit elle suit `deplie`.
 * `repli` : partie affichée volet replié (rail réduit), qui reçoit le focus quand son déclencheur a disparu.
 */
export function useVolet(
  ouvert: () => boolean,
  repli?: () => Element | null | undefined,
): { deplie: Ref<boolean>; large: Ref<boolean>; crochets: CrochetsVolet } {
  const deplie = ref(ouvert());
  const large = ref(deplie.value);
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
      large.value = mouvementReduit() ? deplie.value : v;
    },
    { flush: "sync" },
  );
  const crochets: CrochetsVolet = {
    onBeforeEnter() {
      montre = true;
    },
    onEnter(el) {
      glisserLargeur(el, true);
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
    onLeave(el) {
      glisserLargeur(el, false);
    },
    onAfterLeave(el) {
      if (el) finirGlissement(el);
      montre = false;
      if (ouvert()) return;
      deplie.value = false;
      large.value = false;
      if (!rendre) return;
      rendre = false;
      void nextTick(() =>
        focaliser(affiche(declencheur) ? declencheur : repli?.()?.querySelector(SELECTEUR_FOCUSABLES)),
      );
    },
  };
  return { deplie, large, crochets };
}
