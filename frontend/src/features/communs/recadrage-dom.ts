// SPDX-License-Identifier: MIT
/** frontend/src/features/communs/recadrage-dom.ts — décodage borné de l'image choisie, dessin du recadrage sur un canevas et fichier de sortie (PNG ou WebP). */
import {
  aDeLaTransparence,
  borneDecodage,
  COTE_DECODAGE_MAX,
  nomSortie,
  transformation,
  typeSortie,
} from "./recadrage";
import type { Dimensions, EtatRecadrage } from "./recadrage";

export interface ImageDecodee {
  readonly source: CanvasImageSource;
  readonly dimensions: Dimensions;
}

/** Poids maximal du fichier choisi, avant tout décodage. */
export const POIDS_MAX = 40 * 1024 * 1024;

export class ErreurRecadrage extends Error {}

/** Image prête à dessiner (EXIF appliqué par le navigateur) ; l'adresse temporaire est libérée dans tous les cas. */
async function chargerImage(fichier: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(fichier);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new ErreurRecadrage("Image illisible : choisissez un fichier PNG, JPEG, WebP ou GIF.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Décode le fichier puis le réduit à `max` px de côté au plus, pour borner la mémoire des étapes suivantes. */
export async function decoderImage(fichier: Blob, max: number = COTE_DECODAGE_MAX): Promise<ImageDecodee> {
  if (fichier.size > POIDS_MAX) throw new ErreurRecadrage("Image trop lourde : 40 Mo au plus.");
  const img = await chargerImage(fichier);
  const origine = { largeur: img.naturalWidth, hauteur: img.naturalHeight };
  if (!origine.largeur || !origine.hauteur) throw new ErreurRecadrage("Image sans dimensions.");
  const dimensions = borneDecodage(origine, max);
  if (dimensions.largeur === origine.largeur && dimensions.hauteur === origine.hauteur)
    return { source: img, dimensions };
  const reduite = document.createElement("canvas");
  reduite.width = dimensions.largeur;
  reduite.height = dimensions.hauteur;
  const ctx = reduite.getContext("2d");
  if (!ctx) throw new ErreurRecadrage("Canevas indisponible dans ce navigateur.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, dimensions.largeur, dimensions.hauteur);
  return { source: reduite, dimensions };
}

/** Dessine l'image recadrée sur un canevas carré de `cote` px dont le cadre occupe `cadreSurCanevas` px au centre. */
export function dessiner(
  ctx: CanvasRenderingContext2D,
  image: ImageDecodee,
  etat: EtatRecadrage,
  cote: number,
  cadreSurCanevas: number = cote,
): void {
  const t = transformation(etat, cote, cadreSurCanevas);
  const { largeur, hauteur } = image.dimensions;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cote, cote);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(t.tx, t.ty);
  ctx.rotate(t.angle);
  ctx.scale(t.echelle, t.echelle);
  ctx.drawImage(image.source, -largeur / 2, -hauteur / 2, largeur, hauteur);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function versBlob(canevas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canevas.toBlob(
      (b) => (b ? resolve(b) : reject(new ErreurRecadrage("Export de l'image impossible."))),
      type,
      0.92,
    );
  });
}

/** Fichier carré de `cote` px : PNG s'il reste de la transparence, WebP sinon (PNG si le navigateur n'encode pas le WebP). */
export async function exporterRecadrage(
  image: ImageDecodee,
  etat: EtatRecadrage,
  cote: number,
  base: string,
): Promise<File> {
  const canevas = document.createElement("canvas");
  canevas.width = cote;
  canevas.height = cote;
  const ctx = canevas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new ErreurRecadrage("Canevas indisponible dans ce navigateur.");
  dessiner(ctx, image, etat, cote);
  const transparent = aDeLaTransparence(ctx.getImageData(0, 0, cote, cote).data);
  const blob = await versBlob(canevas, typeSortie(transparent));
  return new File([blob], nomSortie(blob.type, base), { type: blob.type || "image/png" });
}

/** Dessin à la prochaine image d'animation ; rend de quoi l'annuler. */
export function planifierDessin(f: () => void): () => void {
  const id = requestAnimationFrame(f);
  return () => cancelAnimationFrame(id);
}

export function densitePixels(): number {
  return window.devicePixelRatio || 1;
}

export function elementActif(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Écoute du clavier en capture sur la fenêtre, avant les écoutes du document ; rend de quoi la retirer. */
export function ecouterClavierFenetre(f: (ev: KeyboardEvent) => void): () => void {
  window.addEventListener("keydown", f, true);
  return () => window.removeEventListener("keydown", f, true);
}
