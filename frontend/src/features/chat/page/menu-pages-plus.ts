// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/menu-pages-plus.ts — sous-menu « Plus » du volet latéral : pages secondaires (RAG, Studio, Remote code) selon les droits du compte, et sa position à droite du volet. */

/** Page rangée sous « Plus ». */
export interface PagePlus {
  readonly vue: "rag" | "studio" | "code";
  readonly libelle: string;
  readonly titre: string;
  readonly icone: string;
}

/** Droits qui font apparaître une page du sous-menu. */
export interface DroitsPlus {
  readonly rag: boolean;
  readonly opencode: boolean;
}

/** Les pages du sous-menu, dans l'ordre d'affichage. */
export const PAGES_PLUS: readonly PagePlus[] = [
  { vue: "rag", libelle: "RAG", titre: "RAG", icone: "ph-books" },
  {
    vue: "studio",
    libelle: "Studio",
    titre: "Studio d'annotation — captures d'écran et annotation (vision)",
    icone: "ph-bounding-box",
  },
  {
    vue: "code",
    libelle: "Remote code",
    titre: "Remote code — sessions opencode déportées",
    icone: "ph-terminal-window",
  },
];

/** Pages visibles pour ce compte : RAG avec le droit RAG, Remote code avec opencode, Studio toujours. */
export function pagesPlus(d: DroitsPlus): PagePlus[] {
  return PAGES_PLUS.filter((p) => (p.vue === "rag" ? d.rag : p.vue === "code" ? d.opencode : true));
}

/** Page du sous-menu affichée en ce moment, ou null. */
export function pagePlusActive(vue: string, pages: readonly PagePlus[]): PagePlus | null {
  return pages.find((p) => p.vue === vue) ?? null;
}

/** Position du sous-menu : à droite du volet, première entrée alignée sur le déclencheur, sans sortir de la fenêtre. */
export function positionPlus(
  hautDeclencheur: number,
  bordVolet: number,
  hauteurMenu: number,
  hauteurFenetre: number,
): { left: number; top: number } {
  const top = Math.max(8, Math.min(hautDeclencheur - 5, hauteurFenetre - hauteurMenu - 8));
  return { left: bordVolet + 6, top };
}

/** Position du sous-menu pour ce déclencheur : bord droit du volet qui le contient, hauteur de la fenêtre. */
export function placerPlus(declencheur: HTMLElement, hauteurMenu: number): { left: number; top: number } {
  const r = declencheur.getBoundingClientRect();
  const bord = declencheur.closest("aside")?.getBoundingClientRect().right ?? r.right;
  return positionPlus(r.top, bord, hauteurMenu, window.innerHeight);
}

/** Écoute l'appui de pointeur (en capture) et le redimensionnement de la fenêtre ; rend la fonction qui retire les écoutes. */
export function ecouterFermeture(surPointeur: (e: Event) => void, surRedimension: () => void): () => void {
  document.addEventListener("pointerdown", surPointeur, true);
  window.addEventListener("resize", surRedimension);
  return () => {
    document.removeEventListener("pointerdown", surPointeur, true);
    window.removeEventListener("resize", surRedimension);
  };
}

/** Élément qui a le focus. */
export function elementActif(): Element | null {
  return document.activeElement;
}

/** Vrai si le focus est perdu (sur le corps de la page ou nulle part). */
export function focusPerdu(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}
