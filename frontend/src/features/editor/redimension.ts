// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/redimension.ts — glissements de redimensionnement de l'éditeur : hauteur du terminal, largeur de l'explorateur, partage éditeur/chat (porté de `editor/_resize.js`). */
import { ref } from "vue";
import type { Ref } from "vue";

import type { ReglagesEditeur } from "./instances";

export interface RefsRedimension {
  terminalHeight: Ref<number>;
  explorerWidth: Ref<number>;
  settings: Ref<ReglagesEditeur>;
  readonly monacoRef: { instance: { layout(): void } | null };
}

export interface RappelsRedimension {
  /** Ajustement du terminal actif, relu à chaque mouvement (l'onglet actif peut changer). */
  ajustement(): { fit(): void } | null;
}

type Pointeur = MouseEvent | TouchEvent;

const coord = (e: Pointeur | Event, axe: "clientX" | "clientY"): number => {
  if ("touches" in e) return (e as TouchEvent).touches[0]?.[axe] ?? 0;
  return (e as MouseEvent)[axe] || 0;
};

/** Écoute de fin de glissement : souris, toucher, et les « relâchements manqués » (perte de focus, onglet masqué, pointeur hors fenêtre). */
function suivreGlissement(deplacer: (e: Event) => void, finir: () => void): () => void {
  document.addEventListener("mousemove", deplacer);
  document.addEventListener("mouseup", finir);
  document.addEventListener("touchmove", deplacer);
  document.addEventListener("touchend", finir);
  window.addEventListener("blur", finir);
  document.addEventListener("visibilitychange", finir);
  document.addEventListener("pointerup", finir);
  return () => {
    document.removeEventListener("mousemove", deplacer);
    document.removeEventListener("mouseup", finir);
    document.removeEventListener("touchmove", deplacer);
    document.removeEventListener("touchend", finir);
    window.removeEventListener("blur", finir);
    document.removeEventListener("visibilitychange", finir);
    document.removeEventListener("pointerup", finir);
  };
}

function curseurPage(curseur: string): void {
  document.body.style.cursor = curseur;
  document.body.style.userSelect = curseur ? "none" : "";
}

/** Une position par image : la souris envoie plus de mouvements que l'écran n'affiche d'images ; `vider` applique la dernière tout de suite. */
export function parImage(appliquer: (position: number) => void): {
  pousser(position: number): void;
  vider(): void;
} {
  let attente: number | null = null;
  let image = 0;
  const jouer = (): void => {
    image = 0;
    if (attente === null) return;
    const p = attente;
    attente = null;
    appliquer(p);
  };
  return {
    pousser(position) {
      attente = position;
      if (!image) image = requestAnimationFrame(jouer);
    },
    vider() {
      if (image) cancelAnimationFrame(image);
      jouer();
    },
  };
}

export function setupEditorResize(refs: RefsRedimension, r: RappelsRedimension) {
  const { terminalHeight, explorerWidth, settings, monacoRef } = refs;
  const mettreEnPage = (): void => {
    try {
      monacoRef.instance?.layout();
    } catch {
      /* éditeur libéré */
    }
  };
  const ajuster = (): void => {
    try {
      r.ajustement()?.fit();
    } catch {
      /* terminal démonté */
    }
  };

  // Pendant le glissement, les observateurs de taille de Monaco et du terminal suivent à chaque image ; mise en page complète au relâchement.
  let terminalY = 0;
  let terminalH = 0;
  let finTerminal: (() => void) | null = null;
  function terminalResizeStart(e: Pointeur): void {
    e.preventDefault();
    terminalY = coord(e, "clientY");
    terminalH = terminalHeight.value;
    const hauteur = parImage((y) => {
      terminalHeight.value = Math.max(120, Math.min(600, terminalH + (terminalY - y)));
    });
    const deplacer = (ev: Event): void => hauteur.pousser(coord(ev, "clientY"));
    const finir = (): void => {
      if (!finTerminal) return;
      finTerminal();
      finTerminal = null;
      hauteur.vider();
      curseurPage("");
      mettreEnPage();
      ajuster();
    };
    finTerminal?.();
    finTerminal = suivreGlissement(deplacer, finir);
    curseurPage("ns-resize");
  }

  let explorateurX = 0;
  let explorateurW = 0;
  let finExplorateur: (() => void) | null = null;
  function explorerResizeStart(e: Pointeur): void {
    e.preventDefault();
    explorateurX = coord(e, "clientX");
    explorateurW = explorerWidth.value;
    const largeur = parImage((x) => {
      explorerWidth.value = Math.max(160, Math.min(500, explorateurW + (x - explorateurX)));
    });
    const deplacer = (ev: Event): void => largeur.pousser(coord(ev, "clientX"));
    const finir = (): void => {
      if (!finExplorateur) return;
      finExplorateur();
      finExplorateur = null;
      largeur.vider();
      curseurPage("");
      mettreEnPage();
    };
    finExplorateur?.();
    finExplorateur = suivreGlissement(deplacer, finir);
    curseurPage("col-resize");
  }

  // Partage éditeur/chat : ratio réécrit seulement quand sa valeur arrondie change, mise en page coalescée par image.
  const editorSplitDragging = ref(false);
  let partageX = 0;
  let partageDepart = 0;
  let partageCourant = 0;
  let imagePrevue = false;
  let finPartage: (() => void) | null = null;
  function editorSplitStart(e: Pointeur): void {
    e.preventDefault();
    editorSplitDragging.value = true;
    partageX = coord(e, "clientX");
    partageDepart = Number(settings.value.editor_ratio) || 50;
    partageCourant = partageDepart;
    const deplacer = (ev: Event): void => {
      if (!editorSplitDragging.value) return;
      const ecart = ((partageX - coord(ev, "clientX")) / window.innerWidth) * 100;
      const ratio = Math.round(Math.max(20, Math.min(80, partageDepart + ecart)));
      if (ratio === partageCourant) return;
      partageCourant = ratio;
      settings.value.editor_ratio = ratio;
      if (imagePrevue) return;
      imagePrevue = true;
      requestAnimationFrame(() => {
        imagePrevue = false;
        mettreEnPage();
      });
    };
    const finir = (): void => {
      if (!editorSplitDragging.value) return;
      editorSplitDragging.value = false;
      finPartage?.();
      finPartage = null;
      curseurPage("");
      mettreEnPage();
      ajuster();
    };
    finPartage?.();
    finPartage = suivreGlissement(deplacer, finir);
    curseurPage("col-resize");
  }

  return { editorSplitDragging, terminalResizeStart, explorerResizeStart, editorSplitStart };
}
