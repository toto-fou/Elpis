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
  onLeave(el: Element, fin: () => void): void;
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
type Depart = readonly [el: HTMLElement, largeur: number, conteneur: number, max: string];
const blocs = new Set<Bloc>();
const accompagnements = new WeakMap<HTMLElement, Animation>();
let departs: Depart[] | null = null;

/** Bloc dont la largeur maximale change avec un volet (fil et barre de saisie quand l'éditeur s'ouvre) : elle glisse au rythme du volet au lieu de changer d'un coup. */
export function accompagnerVolets(bloc: Bloc): void {
  blocs.add(bloc);
  if (getCurrentScope()) onScopeDispose(() => blocs.delete(bloc));
}

// Largeur des blocs accompagnés, de leur conteneur et règle en vigueur au moment du geste, avant le rendu ; oubliées après lui si aucun volet n'a glissé.
function releverDeparts(): void {
  departs = null;
  if (!blocs.size || mouvementReduit()) return;
  const releves = [...blocs].flatMap((b) => {
    const el = b();
    if (!affiche(el)) return [];
    const parent = el.parentElement;
    const s = parent && getComputedStyle(parent);
    const conteneur =
      parent && s ? parent.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) : 0;
    return [[el, el.getBoundingClientRect().width, conteneur, el.style.maxWidth] as const];
  });
  departs = releves;
  setTimeout(() => departs === releves && (departs = null), 0);
}

/** Blocs dont la règle de largeur maximale a changé avec le geste : elle glisse de leur largeur d'avant à la règle d'après, sur la durée et la courbe du volet. Règle en part du conteneur : le départ est cette part plus l'écart en pixels, qui seul s'efface — la largeur avance droit et suit le conteneur, autres volets compris. */
function accompagner(suivis: readonly Depart[], duration: number, easing: string): void {
  for (const [el, largeur, conteneur, max] of suivis) {
    const fin = el.style.maxWidth;
    if (!el.isConnected || !fin || fin === max) continue;
    accompagnements.get(el)?.cancel();
    const ecart = largeur - (fin.endsWith("%") ? (parseFloat(fin) / 100) * conteneur : 0);
    const debut = fin.endsWith("%") ? `calc(${fin} + ${Math.round(ecart * 100) / 100}px)` : `${largeur}px`;
    accompagnements.set(el, el.animate([{ maxWidth: debut }, { maxWidth: fin }], { duration, easing }));
  }
}

function finirGlissement(el: Element): void {
  glissements.get(el)?.cancel();
  glissements.delete(el);
  if (!(el instanceof HTMLElement)) return;
  el.style.removeProperty("--volet-duree");
  delete el.dataset["voletCouvrant"];
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

/** Panneau racine de la transition (MCP, Génération, éditeur) : sa largeur glisse de 0 à sa valeur ou l'inverse, plus longtemps s'il est large ; la colonne du chat suit, son contenu garde sa largeur finale (`--volet-largeur`). */
function glisserLargeur(el: Element, entree: boolean, auGeste = 0): Animation | null {
  if (!glisse(el)) return null;
  const enCours = glissements.has(el);
  const actuelle = el.getBoundingClientRect().width;
  finirGlissement(el);
  const finale = el.getBoundingClientRect().width;
  if (!(finale > 0)) return null;
  // Sortie : depuis la largeur vue au geste si le rendu l'a réduite d'un coup (éditeur fermé en plein écran) ; il couvrait la page, il se rétracte hors du flux, au-dessus du chat déjà à sa place.
  const depart = entree ? (enCours ? actuelle : 0) : Math.max(actuelle, auGeste);
  if (!entree && auGeste > finale + 1) el.dataset["voletCouvrant"] = "";
  el.style.setProperty("--volet-largeur", `${Math.max(finale, depart)}px`);
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
  if (suivis?.length) void nextTick(() => glissements.get(el) === a && accompagner(suivis, duration, easing));
  // Entrée finie : le panneau reprend sa mise en page ; la sortie est retirée par `onAfterLeave`.
  if (entree) a.addEventListener("finish", () => glissements.get(el) === a && finirGlissement(el));
  return a;
}

// Durée de la transition CSS posée sur un élément, délai compris (ms).
function dureeTransition(el: Element): number {
  const s = getComputedStyle(el);
  const ms = (v: string): number => Math.max(0, ...v.split(",").map((x) => parseFloat(x) * 1000 || 0));
  return ms(s.transitionDuration) + ms(s.transitionDelay);
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
 * `panneau` : panneau qui peut être plus large au geste qu'après le rendu (éditeur en plein écran) ; sa sortie part de cette largeur.
 */
export function useVolet(
  ouvert: () => boolean,
  repli?: () => Element | null | undefined,
  panneau?: () => Element | null | undefined,
): { deplie: Ref<boolean>; large: Ref<boolean>; crochets: CrochetsVolet } {
  const deplie = ref(ouvert());
  const large = ref(deplie.value);
  let montre = deplie.value;
  let declencheur: HTMLElement | null = null;
  let quitte: HTMLElement | null = null;
  let rendre = false;
  let auGeste = 0;
  // Lu au geste, avant le rendu : la largeur est juste dès la première image et l'élément actif est encore celui de l'utilisateur.
  watch(
    ouvert,
    (v) => {
      releverDeparts();
      const p = v ? null : panneau?.();
      auGeste = p && glisse(p) ? p.getBoundingClientRect().width : 0;
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
      if (glisse(el)) dureeGlissement(el, Math.max(el.getBoundingClientRect().width, auGeste), false);
      rendre = !!quitte && el.contains(quitte);
      if (rendre && declencheur && !el.contains(declencheur) && affiche(declencheur)) {
        focaliser(declencheur);
        rendre = false;
      }
    },
    onLeave(el, fin) {
      // La sortie finit avec la largeur (un fondu repris en cours de route finirait avant elle) ; sans glissement, avec la transition de la racine.
      const a = glisserLargeur(el, false, auGeste);
      if (a) void a.finished.then(fin, () => undefined);
      else setTimeout(fin, dureeTransition(el));
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
