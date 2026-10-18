// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/mise-en-page.ts — mise en page de Monaco : passes après transition, ouverture fluide du panneau (observateur neutralisé pendant l'animation), plein écran et sa sortie par Échap. */
import { nextTick, watch } from "vue";
import type { Ref } from "vue";

import { journal } from "../../platform/journal";
import type { EtatEditeur, Modele } from "./etat";

export interface RappelsMiseEnPage {
  sauverVue(): void;
  restaurerVue(chemin: string): boolean;
  modeleOk(chemin: string): boolean;
  modele(chemin: string): Modele | undefined;
  preparerConteneur(): Promise<unknown>;
  echapPourMonaco(e: KeyboardEvent): boolean;
}

export function setupEditorLayout(e: EtatEditeur, showSidebar: () => Ref<boolean>, r: RappelsMiseEnPage) {
  const { monacoRef, showEditor, splitView, editorFullscreen, showEscapeHint, showEditorMore } = e;

  function _forceLayout(): void {
    monacoRef.instance?.layout();
    monacoRef.diff?.layout();
    if (monacoRef.instance2 && splitView.value) monacoRef.instance2.layout();
  }

  // Verrou d'ouverture : pendant l'animation de largeur du panneau, ni l'observateur ni robustLayout ne mettent en page.
  let ouverture = false;
  let reglageOuverture: ReturnType<typeof setTimeout> | null = null;
  let passes: Array<ReturnType<typeof setTimeout>> = [];
  let passesAffichage: Array<ReturnType<typeof setTimeout>> = [];
  let imageTransition: number | null = null;
  let minuterieIndice: ReturnType<typeof setTimeout> | null = null;

  /** Mise en page immédiate puis passes à 50, 150, 320 et 600 ms (transitions CSS) ; les passes précédentes sont annulées. */
  function robustLayout(): void {
    if (ouverture) return;
    _forceLayout();
    for (const id of passes) clearTimeout(id);
    passes = [50, 150, 320, 600].map((t) =>
      setTimeout(() => {
        try {
          monacoRef.instance?.layout();
        } catch {
          /* éditeur libéré */
        }
        try {
          if (monacoRef.instance2 && splitView.value) monacoRef.instance2.layout();
        } catch {
          /* éditeur libéré */
        }
      }, t),
    );
  }

  /** Ouverture fluide : observateur neutralisé pendant la transition, une seule mise en page à la fin. */
  function _smoothOpenLayout(): void {
    ouverture = true;
    if (reglageOuverture) clearTimeout(reglageOuverture);
    reglageOuverture = setTimeout(() => {
      reglageOuverture = null;
      ouverture = false;
      if (!showEditor.value) return;
      _forceLayout();
    }, 300);
  }

  function annulerPassesAffichage(): void {
    for (const id of passesAffichage) clearTimeout(id);
    passesAffichage = [];
  }

  watch(showEditor, async (visible) => {
    annulerPassesAffichage();
    if (!visible) {
      ouverture = false;
      if (reglageOuverture) {
        clearTimeout(reglageOuverture);
        reglageOuverture = null;
      }
      r.sauverVue();
      if (e.isTypingEffect.value && e.activeTabPath.value) e.pathsNeedingReload.add(e.activeTabPath.value);
      return;
    }
    r.preparerConteneur().catch((err: unknown) => journal.avertir("[editor] sandbox init au mount:", err));
    await nextTick();
    _smoothOpenLayout();
    // Filet unique : un modèle perdu par Monaco est rattaché après la transition.
    passesAffichage.push(
      setTimeout(() => {
        if (!showEditor.value) return;
        const ed = monacoRef.instance;
        const chemin = e.activeTabPath.value;
        if (!ed || !chemin || !r.modeleOk(chemin)) return;
        const m = r.modele(chemin);
        try {
          if (m && ed.getModel() !== m) {
            ed.setModel(m);
            r.restaurerVue(chemin);
            _forceLayout();
          }
        } catch {
          /* éditeur libéré */
        }
      }, 330),
    );
  });

  /** Mise en page à chaque image pendant ~320 ms (transition de largeur) ; une seule boucle à la fois. */
  function _relayoutMonacoDuringTransition(duree = 320): void {
    if (imageTransition != null) {
      cancelAnimationFrame(imageTransition);
      imageTransition = null;
    }
    const debut = performance.now();
    const pas = (): void => {
      imageTransition = null;
      try {
        monacoRef.instance?.layout();
      } catch {
        /* éditeur libéré */
      }
      if (performance.now() - debut < duree) imageTransition = requestAnimationFrame(pas);
    };
    imageTransition = requestAnimationFrame(pas);
  }

  function toggleEditorFullscreen(): void {
    editorFullscreen.value = !editorFullscreen.value;
    if (editorFullscreen.value) {
      showSidebar().value = false;
      showEscapeHint.value = true;
      if (minuterieIndice) clearTimeout(minuterieIndice);
      minuterieIndice = setTimeout(() => {
        showEscapeHint.value = false;
      }, 2500);
    } else {
      showEscapeHint.value = false;
      if (minuterieIndice) {
        clearTimeout(minuterieIndice);
        minuterieIndice = null;
      }
      void nextTick(() => robustLayout());
    }
    _relayoutMonacoDuringTransition();
  }

  /** Sortie du plein écran par la cascade Échap d'app.js. */
  function exitEditorFullscreen(): void {
    if (!editorFullscreen.value) return;
    editorFullscreen.value = false;
    void nextTick(() => robustLayout());
    _relayoutMonacoDuringTransition();
  }

  // Repli seulement : la cascade Échap d'app.js est l'autorité (événement marqué) ; Monaco et le menu « + » passent d'abord.
  function echapPleinEcran(ev: KeyboardEvent): void {
    if (ev.key !== "Escape" || !editorFullscreen.value) return;
    if ((ev as KeyboardEvent & { _elpisCascadeSaw?: boolean })._elpisCascadeSaw) return;
    if (r.echapPourMonaco(ev)) return;
    if (showEditorMore.value) {
      showEditorMore.value = false;
      return;
    }
    exitEditorFullscreen();
  }
  let echapBranche = false;
  function _bindFullscreenEsc(): void {
    if (echapBranche) return;
    document.addEventListener("keydown", echapPleinEcran);
    echapBranche = true;
  }
  _bindFullscreenEsc();

  /** Minuteries, boucle d'images et écoute d'Échap retirées ; l'écoute est rebranchée au prochain `initMonaco`. */
  function libererMiseEnPage(): void {
    annulerPassesAffichage();
    ouverture = false;
    if (reglageOuverture) {
      clearTimeout(reglageOuverture);
      reglageOuverture = null;
    }
    for (const id of passes) clearTimeout(id);
    passes = [];
    if (imageTransition != null) {
      cancelAnimationFrame(imageTransition);
      imageTransition = null;
    }
    document.removeEventListener("keydown", echapPleinEcran);
    echapBranche = false;
  }

  return {
    _forceLayout,
    robustLayout,
    _smoothOpenLayout,
    enOuverture: (): boolean => ouverture,
    _relayoutMonacoDuringTransition,
    toggleEditorFullscreen,
    exitEditorFullscreen,
    _bindFullscreenEsc,
    libererMiseEnPage,
  };
}
