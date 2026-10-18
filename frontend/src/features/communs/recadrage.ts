// SPDX-License-Identifier: MIT
/** frontend/src/features/communs/recadrage.ts — calculs du recadrage d'une image dans un cadre carré (zoom, déplacement, quart de tour, ajuster, remplir) et format de sortie, sans DOM. */

export interface Dimensions {
  readonly largeur: number;
  readonly hauteur: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type QuartDeTour = 0 | 90 | 180 | 270;

/** Image (dimensions décodées) dans un cadre de `cadre` px d'écran : son centre est à (x, y) du centre du cadre, à `echelle` px d'écran par px d'image. */
export interface EtatRecadrage {
  readonly image: Dimensions;
  readonly cadre: number;
  readonly rotation: QuartDeTour;
  readonly echelle: number;
  readonly x: number;
  readonly y: number;
}

export interface Transformation {
  readonly tx: number;
  readonly ty: number;
  readonly angle: number;
  readonly echelle: number;
}

export type ActionClavier =
  | { readonly type: "deplacer"; readonly dx: number; readonly dy: number }
  | { readonly type: "zoom"; readonly facteur: number }
  | { readonly type: "annuler" };

export type TypeSortie = "image/png" | "image/webp";

/** Côté maximal de l'image gardée en mémoire : une photo plus grande est d'abord réduite. */
export const COTE_DECODAGE_MAX = 4096;
/** Côté de l'image envoyée, en pixels. */
export const COTE_SORTIE = 512;
/** Zoom maximal, en multiple de l'échelle « Remplir ». */
export const ZOOM_MAX = 8;
export const PAS_ZOOM = 1.1;
export const PAS_DEPLACEMENT = 10;
export const PAS_DEPLACEMENT_LARGE = 50;

const limiter = (v: number, jeu: number): number => Math.min(jeu, Math.max(-jeu, v)) + 0;

export function borneDecodage(d: Dimensions, max: number = COTE_DECODAGE_MAX): Dimensions {
  const cote = Math.max(d.largeur, d.hauteur);
  if (cote <= max) return { largeur: d.largeur, hauteur: d.hauteur };
  const k = max / cote;
  return {
    largeur: Math.max(1, Math.round(d.largeur * k)),
    hauteur: Math.max(1, Math.round(d.hauteur * k)),
  };
}

export function dimensionsTournees(e: Pick<EtatRecadrage, "image" | "rotation">): Dimensions {
  return e.rotation % 180 === 0 ? e.image : { largeur: e.image.hauteur, hauteur: e.image.largeur };
}

/** Échelle où l'image couvre tout le cadre. */
export function echelleRemplir(e: Pick<EtatRecadrage, "image" | "rotation" | "cadre">): number {
  const d = dimensionsTournees(e);
  return Math.max(e.cadre / d.largeur, e.cadre / d.hauteur);
}

/** Échelle où l'image entière tient dans le cadre. */
export function echelleAjuster(e: Pick<EtatRecadrage, "image" | "rotation" | "cadre">): number {
  const d = dimensionsTournees(e);
  return Math.min(e.cadre / d.largeur, e.cadre / d.hauteur);
}

export function bornesZoom(e: Pick<EtatRecadrage, "image" | "rotation" | "cadre">): {
  min: number;
  max: number;
} {
  return { min: echelleAjuster(e), max: echelleRemplir(e) * ZOOM_MAX };
}

/** Échelle ramenée dans ses bornes ; sur chaque axe, l'image couvre le cadre si elle le dépasse, reste dedans sinon. */
export function borner(e: EtatRecadrage): EtatRecadrage {
  const { min, max } = bornesZoom(e);
  const echelle = Math.min(max, Math.max(min, e.echelle));
  const d = dimensionsTournees(e);
  const jeuX = Math.abs(d.largeur * echelle - e.cadre) / 2;
  const jeuY = Math.abs(d.hauteur * echelle - e.cadre) / 2;
  return { ...e, echelle, x: limiter(e.x, jeuX), y: limiter(e.y, jeuY) };
}

export function remplir(e: EtatRecadrage): EtatRecadrage {
  return borner({ ...e, echelle: echelleRemplir(e), x: 0, y: 0 });
}

export function ajuster(e: EtatRecadrage): EtatRecadrage {
  return borner({ ...e, echelle: echelleAjuster(e), x: 0, y: 0 });
}

/** État d'ouverture : cadre couvert, image centrée, sans rotation. */
export function etatInitial(image: Dimensions, cadre: number): EtatRecadrage {
  return remplir({ image, cadre, rotation: 0, echelle: 1, x: 0, y: 0 });
}

/** Zoom autour d'un foyer (relatif au centre du cadre) : le point de l'image sous le foyer reste en place. */
export function zoomer(e: EtatRecadrage, echelle: number, foyer: Point = { x: 0, y: 0 }): EtatRecadrage {
  const { min, max } = bornesZoom(e);
  const cible = Math.min(max, Math.max(min, echelle));
  const k = cible / e.echelle;
  return borner({ ...e, echelle: cible, x: foyer.x + (e.x - foyer.x) * k, y: foyer.y + (e.y - foyer.y) * k });
}

export function zoomerPar(e: EtatRecadrage, facteur: number, foyer?: Point): EtatRecadrage {
  return zoomer(e, e.echelle * facteur, foyer);
}

export function deplacer(e: EtatRecadrage, dx: number, dy: number): EtatRecadrage {
  return borner({ ...e, x: e.x + dx, y: e.y + dy });
}

/** Quart de tour autour du centre du cadre (1 : sens horaire, -1 : antihoraire). */
export function tourner(e: EtatRecadrage, sens: 1 | -1): EtatRecadrage {
  const rotation = ((((e.rotation + 90 * sens) % 360) + 360) % 360) as QuartDeTour;
  const x = sens === 1 ? -e.y : e.y;
  const y = sens === 1 ? e.x : -e.x;
  return borner({ ...e, rotation, x, y });
}

/** Position du curseur de zoom, de 0 à 1, en échelle logarithmique entre les bornes. */
export function niveauZoom(e: EtatRecadrage): number {
  const { min, max } = bornesZoom(e);
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, Math.log(e.echelle / min) / Math.log(max / min)));
}

export function echelleDuNiveau(e: EtatRecadrage, niveau: number): number {
  const { min, max } = bornesZoom(e);
  return min * Math.pow(max / min, Math.min(1, Math.max(0, niveau)));
}

/** Dessin sur un canevas carré de `cote` px centré sur le cadre, qui y occupe `cadreSurCanevas` px : translation, rotation, puis échelle. */
export function transformation(
  e: EtatRecadrage,
  cote: number,
  cadreSurCanevas: number = cote,
): Transformation {
  const k = cadreSurCanevas / e.cadre;
  return {
    tx: cote / 2 + e.x * k,
    ty: cote / 2 + e.y * k,
    angle: (e.rotation * Math.PI) / 180,
    echelle: e.echelle * k,
  };
}

/** Touches de la fenêtre : flèches (Maj : pas large), + et - pour le zoom, Échap pour annuler. */
export function actionClavier(touche: string, maj: boolean): ActionClavier | null {
  const pas = maj ? PAS_DEPLACEMENT_LARGE : PAS_DEPLACEMENT;
  switch (touche) {
    case "ArrowLeft":
      return { type: "deplacer", dx: -pas, dy: 0 };
    case "ArrowRight":
      return { type: "deplacer", dx: pas, dy: 0 };
    case "ArrowUp":
      return { type: "deplacer", dx: 0, dy: -pas };
    case "ArrowDown":
      return { type: "deplacer", dx: 0, dy: pas };
    case "+":
    case "=":
      return { type: "zoom", facteur: PAS_ZOOM };
    case "-":
    case "_":
      return { type: "zoom", facteur: 1 / PAS_ZOOM };
    case "Escape":
      return { type: "annuler" };
    default:
      return null;
  }
}

/** Vrai si un pixel RGBA n'est pas entièrement opaque. */
export function aDeLaTransparence(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] ?? 255) < 255) return true;
  return false;
}

/** PNG si l'image garde de la transparence (zones vides du cadre comprises), WebP sinon. */
export function typeSortie(transparent: boolean): TypeSortie {
  return transparent ? "image/png" : "image/webp";
}

export function nomSortie(type: string, base: string): string {
  const ext = type === "image/webp" ? "webp" : type === "image/jpeg" ? "jpg" : "png";
  return `${base}.${ext}`;
}
