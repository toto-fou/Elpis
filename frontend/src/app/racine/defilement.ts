// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/defilement.ts — défilement du fil de chat : geste de l'utilisateur (remonter coupe le suivi automatique), distance au bas, verrou des défilements programmés. */
import { ref, watch } from "vue";
import type { Ref } from "vue";

const LOIN_DU_BAS_PX = 240;
// 1,5 s couvre le pire défilement programmé observé (révélation Monaco sur un gros fichier).
const VERROU_MS = 1500;

export interface SourceDefilement {
  readonly conteneur: () => HTMLElement | null | undefined;
  readonly isUserScrolling: Ref<boolean>;
  onChatScroll?: () => unknown;
}

export function creerDefilementChat(src: SourceDefilement) {
  // Booléen (seuil) et non distance : la racine n'est re-rendue que quand il bascule.
  const chatAwayFromBottom = ref(false);
  let verrouJusqua = 0;
  let dernierHaut = 0;
  let toucheY = 0;
  let detacher: (() => void) | null = null;

  const distance = (el: HTMLElement): number => el.scrollHeight - el.scrollTop - el.clientHeight;

  function brancher(el: HTMLElement): () => void {
    dernierHaut = el.scrollTop;
    const surDefilement = (): void => {
      // Position toujours suivie, même verrouillée : le bouton « descendre » dépend de la position.
      const dist = distance(el);
      chatAwayFromBottom.value = dist > LOIN_DU_BAS_PX;
      if (Date.now() < verrouJusqua) {
        dernierHaut = el.scrollTop;
        return;
      }
      const remonte = el.scrollTop < dernierHaut;
      dernierHaut = el.scrollTop;
      if (remonte && dist > 120) src.isUserScrolling.value = true;
      else if (dist <= 30) src.isUserScrolling.value = false;
      src.onChatScroll?.();
    };
    // Intention de l'utilisateur (molette, toucher, clavier) : coupe le suivi même pendant le verrou d'un flux.
    const assezHaut = (): boolean => el.scrollHeight > el.clientHeight + 10;
    const surMolette = (e: WheelEvent): void => {
      if (e.deltaY < 0 && assezHaut()) src.isUserScrolling.value = true;
    };
    const surToucher = (e: TouchEvent): void => {
      toucheY = e.touches[0]?.clientY ?? 0;
    };
    const surGlisser = (e: TouchEvent): void => {
      if ((e.touches[0]?.clientY ?? 0) - toucheY > 10 && assezHaut()) src.isUserScrolling.value = true;
    };
    const surTouche = (e: KeyboardEvent): void => {
      if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") src.isUserScrolling.value = true;
    };
    el.addEventListener("scroll", surDefilement, { passive: true });
    el.addEventListener("wheel", surMolette, { passive: true });
    el.addEventListener("touchstart", surToucher, { passive: true });
    el.addEventListener("touchmove", surGlisser, { passive: true });
    el.addEventListener("keydown", surTouche);
    // Le contenu grandit ou rétrécit sans événement de défilement : viewport et colonne observés.
    const obs = new ResizeObserver(() => {
      chatAwayFromBottom.value = distance(el) > LOIN_DU_BAS_PX;
    });
    obs.observe(el);
    if (el.firstElementChild) obs.observe(el.firstElementChild);
    chatAwayFromBottom.value = distance(el) > LOIN_DU_BAS_PX;
    return () => {
      el.removeEventListener("scroll", surDefilement);
      el.removeEventListener("wheel", surMolette);
      el.removeEventListener("touchstart", surToucher);
      el.removeEventListener("touchmove", surGlisser);
      el.removeEventListener("keydown", surTouche);
      obs.disconnect();
    };
  }

  // Un élément recréé est rebranché ; l'ancien est détaché d'abord (pas d'écoutes en double).
  watch(src.conteneur, (el) => {
    detacher?.();
    detacher = el ? brancher(el) : null;
  });

  /** Défilements programmés (bas du fil, révélation dans l'éditeur) : non pris pour un geste. */
  function verrouillerDefilementAuto(): void {
    verrouJusqua = Date.now() + VERROU_MS;
  }

  return { chatAwayFromBottom, verrouillerDefilementAuto };
}
