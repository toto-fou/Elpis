// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/bulle.ts — bulle d'une source : ouverte au survol ou au focus d'une pastille après un court délai, gardée ouverte quand le pointeur passe dessus, fermée par Échap ou en quittant. */
import { ref, shallowRef } from "vue";
import type { SourceCiteeRag } from "@elpis/contracts";

export interface AncreBulle {
  readonly gauche: number;
  readonly haut: number;
  readonly bas: number;
  readonly droite: number;
}

export interface EtatBulle {
  readonly source: SourceCiteeRag;
  readonly ancre: AncreBulle;
  /** Pastille qui l'a ouverte : elle porte `aria-describedby` tant que la bulle existe. */
  readonly el: HTMLElement;
  /** « Voir dans le document » : celui qui a posé la pastille sait quelles sources la visionneuse parcourt. */
  readonly voir: () => void;
}

export interface DepsBulle {
  /** Délais en ms (ouverture, fermeture) ; injectés par les tests. */
  readonly delais?: { readonly ouvrir: number; readonly fermer: number };
}

export const ID_BULLE_SOURCE = "rag-bulle-source";

const LARGEUR_BULLE = 420;
const MARGE_BULLE = 12;
const HAUTEUR_BULLE = 260;

/** Style de la bulle : sous la pastille, alignée dans l'écran ; au-dessus si le bas manque de place. */
export function positionBulle(
  ancre: AncreBulle,
  largeurFenetre: number,
  hauteurFenetre: number,
): Record<string, string> {
  const largeur = Math.min(LARGEUR_BULLE, largeurFenetre - 2 * MARGE_BULLE);
  const gauche = Math.max(MARGE_BULLE, Math.min(ancre.gauche - 24, largeurFenetre - largeur - MARGE_BULLE));
  const placeBas = hauteurFenetre - ancre.bas;
  const enHaut = placeBas < HAUTEUR_BULLE && ancre.haut > placeBas;
  return enHaut
    ? { left: `${gauche}px`, bottom: `${hauteurFenetre - ancre.haut + 8}px`, width: `${largeur}px` }
    : { left: `${gauche}px`, top: `${ancre.bas + 8}px`, width: `${largeur}px` };
}

/** Style de la bulle dans la fenêtre courante. */
export function positionDansFenetre(ancre: AncreBulle): Record<string, string> {
  return positionBulle(ancre, window.innerWidth, window.innerHeight);
}

/** Un défilement ou un redimensionnement déplacerait la pastille sous la bulle : `fermer` est appelé. Rend le désabonnement. */
export function fermerQuandLaPageBouge(fermer: () => void): () => void {
  window.addEventListener("resize", fermer);
  document.addEventListener("scroll", fermer, true);
  return () => {
    window.removeEventListener("resize", fermer);
    document.removeEventListener("scroll", fermer, true);
  };
}

export function creerBulle(dep: DepsBulle = {}) {
  const delais = dep.delais ?? { ouvrir: 140, fermer: 180 };
  const etat = shallowRef<EtatBulle | null>(null);
  const survolee = ref(false);
  let ouverteA = 0;
  let minOuvrir: ReturnType<typeof setTimeout> | null = null;
  let minFermer: ReturnType<typeof setTimeout> | null = null;

  const arreter = (): void => {
    if (minOuvrir !== null) clearTimeout(minOuvrir);
    if (minFermer !== null) clearTimeout(minFermer);
    minOuvrir = null;
    minFermer = null;
  };

  function decrocher(): void {
    const e = etat.value;
    if (e?.el.getAttribute("aria-describedby") === ID_BULLE_SOURCE) e.el.removeAttribute("aria-describedby");
  }

  function fermer(): void {
    arreter();
    decrocher();
    survolee.value = false;
    etat.value = null;
  }

  function survol(source: SourceCiteeRag, el: HTMLElement, voir: () => void): void {
    arreter();
    if (etat.value?.el === el && etat.value.source.n === source.n) return;
    minOuvrir = setTimeout(
      () => {
        minOuvrir = null;
        const r = el.getBoundingClientRect();
        decrocher();
        ouverteA = Date.now();
        el.setAttribute("aria-describedby", ID_BULLE_SOURCE);
        etat.value = {
          source,
          el,
          voir,
          ancre: { gauche: r.left, haut: r.top, bas: r.bottom, droite: r.right },
        };
      },
      etat.value === null ? delais.ouvrir : 0,
    );
  }

  /** Le pointeur ou le focus quitte la pastille : la bulle reste le temps d'y aller. */
  function sortie(): void {
    if (minOuvrir !== null) {
      clearTimeout(minOuvrir);
      minOuvrir = null;
    }
    if (etat.value === null || survolee.value) return;
    if (minFermer !== null) clearTimeout(minFermer);
    minFermer = setTimeout(() => {
      minFermer = null;
      if (!survolee.value) fermer();
    }, delais.fermer);
  }

  function entrerBulle(): void {
    survolee.value = true;
    if (minFermer !== null) clearTimeout(minFermer);
    minFermer = null;
  }

  function quitterBulle(): void {
    survolee.value = false;
    sortie();
  }

  /** La page défile ou change de taille : une bulle ouverte quitte sa pastille et se ferme ; une ouverture en attente suit la pastille (sa position est lue à l'ouverture). Un défilement du geste qui vient d'ouvrir la bulle (focus clavier amenant la pastille à l'écran) ne la ferme pas. */
  function pageBouge(): void {
    if (etat.value !== null && Date.now() - ouverteA > 400) fermer();
  }

  /** Échap : ferme la bulle ; vrai si elle était ouverte. */
  function echap(): boolean {
    if (etat.value === null) return false;
    fermer();
    return true;
  }

  return { etat, survol, sortie, entrerBulle, quitterBulle, fermer, pageBouge, echap };
}

export type SurfaceBulle = ReturnType<typeof creerBulle>;
