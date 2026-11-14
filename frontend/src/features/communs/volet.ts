// SPDX-License-Identifier: MIT
/** frontend/src/features/communs/volet.ts — volet coulissant (<Transition name="volet">) : largeur qui glisse avec le geste (posée d'un coup en mouvement réduit), contenu gardé jusqu'à sa sortie, focus passé au volet ou rendu à son déclencheur. */
import { getCurrentScope, nextTick, onScopeDispose, ref, watch } from "vue";
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

// Un volet plus large que ce repère prend plus de temps, jusqu'à ce facteur : à durée égale, l'éditeur irait trois à quatre fois plus vite que les autres volets.
const LARGEUR_REPERE = 550;
const ALLONGE_MAX = 1.5;

const glissements = new WeakMap<Element, Animation>();

type Bloc = () => HTMLElement | null | undefined;
type Depart = readonly [el: HTMLElement, largeur: number, max: string];
const blocs = new Set<Bloc>();
const accompagnements = new WeakMap<HTMLElement, Animation>();
let departs: Depart[] | null = null;

/** Bloc dont la largeur maximale change avec un volet (fil et barre de saisie quand l'éditeur s'ouvre) : elle glisse au rythme du volet au lieu de changer d'un coup. */
export function accompagnerVolets(bloc: Bloc): void {
  blocs.add(bloc);
  if (getCurrentScope()) onScopeDispose(() => blocs.delete(bloc));
}

// Largeur des blocs accompagnés au moment du geste, avant le rendu ; oubliée après lui si aucun volet n'a glissé.
function releverDeparts(): void {
  if (!blocs.size || mouvementReduit()) return;
  departs = [...blocs].flatMap((b) => {
    const el = b();
    return affiche(el) ? [[el, el.getBoundingClientRect().width, el.style.maxWidth] as const] : [];
  });
  void nextTick(() => (departs = null));
}

/** Blocs dont la largeur maximale a changé avec le geste : elle glisse de la largeur d'avant à celle d'après, lue volet presque arrivé, sur la durée et la courbe du volet. */
function accompagner(volet: Animation, suivis: readonly Depart[], duration: number, easing: string): void {
  const changes = suivis.filter(([el, , max]) => el.isConnected && el.style.maxWidth !== max);
  if (!changes.length) return;
  for (const [el] of changes) accompagnements.get(el)?.cancel();
  const t = volet.currentTime;
  volet.currentTime = duration - 0.01;
  const fins = changes.map(([el]) => el.getBoundingClientRect().width);
  volet.currentTime = t;
  changes.forEach(([el, depart], i) =>
    accompagnements.set(
      el,
      el.animate([{ maxWidth: `${depart}px` }, { maxWidth: `${fins[i]}px` }], { duration, easing }),
    ),
  );
}

function finirGlissement(el: Element): void {
  glissements.get(el)?.cancel();
  glissements.delete(el);
  el.classList.remove("volet-anime");
  if (el instanceof HTMLElement) el.style.removeProperty("--volet-duree");
}

// Panneau racine de la transition dont la largeur glisse : pas un rail, pas en mouvement réduit.
function glisse(el: Element): el is HTMLElement {
  return (
    el instanceof HTMLElement &&
    el.classList.contains("elpis-slide-panel") &&
    !mouvementReduit() &&
    typeof el.animate === "function"
  );
}

/** Durée du glissement pour la distance à parcourir, posée sur le panneau : son fondu et le glissement de son contenu (transition « volet ») la suivent. */
function dureeGlissement(el: HTMLElement, distance: number, entree: boolean): number {
  const allonge = Math.min(ALLONGE_MAX, Math.max(1, distance / LARGEUR_REPERE));
  const duree = allonge * (entree ? dureeJeton("--duree-longue", 260) : dureeJeton("--duree", 200));
  el.style.setProperty("--volet-duree", `${duree}ms`);
  return duree;
}

/** Panneau racine de la transition (MCP, Génération, éditeur) : sa largeur glisse de 0 à sa valeur ou l'inverse, plus longtemps s'il est large ; la colonne du chat suit, son contenu garde sa largeur finale. */
function glisserLargeur(el: Element, entree: boolean): void {
  if (!glisse(el)) return;
  const enCours = glissements.has(el);
  const actuelle = el.getBoundingClientRect().width;
  finirGlissement(el);
  const finale = el.getBoundingClientRect().width;
  if (!(finale > 0)) return;
  el.style.setProperty("--volet-largeur", `${finale}px`);
  el.classList.add("volet-anime");
  const depart = entree ? (enCours ? actuelle : 0) : actuelle;
  const arrivee = entree ? finale : 0;
  const duration = dureeGlissement(el, Math.abs(arrivee - depart), entree);
  const easing = courbeVolet();
  const a = el.animate(
    [
      { width: `${depart}px`, minWidth: "0px" },
      { width: `${arrivee}px`, minWidth: "0px" },
    ],
    { duration, easing, fill: entree ? "none" : "forwards" },
  );
  glissements.set(el, a);
  const suivis = departs;
  if (suivis?.length)
    void nextTick(() => glissements.get(el) === a && accompagner(a, suivis, duration, easing));
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
      releverDeparts();
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
      // Avant les classes de sortie : le fondu part avec elles, sa durée doit déjà être celle de la largeur.
      if (glisse(el)) dureeGlissement(el, el.getBoundingClientRect().width, false);
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
