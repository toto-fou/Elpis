// SPDX-License-Identifier: MIT
/** apps/core/test/images/fabrique.ts — images de test sans module natif : PNG (pngjs), JPEG (jpeg-js, orientation Exif ajoutée), lecture des PNG produits. */
import { decode as decoderJpeg, encode as encoderJpeg } from "jpeg-js";
import pngjs from "pngjs";

export type Rvba = readonly [number, number, number, number];
type Peintre = (x: number, y: number) => Rvba;

const uni =
  (c: Rvba): Peintre =>
  () =>
    c;

function rvba(w: number, h: number, couleur: Rvba | Peintre): Buffer {
  const peindre = typeof couleur === "function" ? couleur : uni(couleur);
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(peindre(x, y), (y * w + x) * 4);
  return d;
}

/** PNG 8 bits : RGB, ou RGBA si `alpha`. */
export function png(w: number, h: number, couleur: Rvba | Peintre, alpha = false): Buffer {
  const type = alpha ? 6 : 2;
  return pngjs.PNG.sync.write(
    { width: w, height: h, data: rvba(w, h, couleur) },
    { colorType: type, inputColorType: 6, inputHasAlpha: true },
  );
}

/** Segment APP1 Exif (TIFF « MM ») portant la seule orientation. */
function exif(orientation: number): Buffer {
  const tiff = Buffer.from([
    ...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8],
    ...[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0],
    ...[0, 0, 0, 0],
  ]);
  const corps = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const tete = Buffer.from([0xff, 0xe1, 0, 0]);
  tete.writeUInt16BE(corps.length + 2, 2);
  return Buffer.concat([tete, corps]);
}

/** JPEG (jpeg-js) ; `orientation` ajoute un segment Exif juste après SOI. */
export function jpeg(
  w: number,
  h: number,
  couleur: Rvba | Peintre,
  qualite = 95,
  orientation?: number,
): Buffer {
  const brut = encoderJpeg({ width: w, height: h, data: rvba(w, h, couleur) }, qualite).data;
  return orientation === undefined
    ? brut
    : Buffer.concat([brut.subarray(0, 2), exif(orientation), brut.subarray(2)]);
}

/** PNG relu : taille, type de couleur et pixel (x, y) en RVBA. */
export function lirePng(octets: Uint8Array) {
  const p = pngjs.PNG.sync.read(Buffer.from(octets));
  const d = p.data as Uint8Array;
  return {
    largeur: p.width,
    hauteur: p.height,
    type: p.colorType,
    pixel: (x: number, y: number): number[] => [
      ...d.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4),
    ],
  };
}

/** JPEG relu : taille et nombre de composantes (SOF). */
export function lireJpeg(octets: Uint8Array): { largeur: number; hauteur: number; composantes: number } {
  const r = decoderJpeg(octets, { useTArray: true });
  let composantes = 0;
  for (let i = 2; i + 4 < octets.length;) {
    const m = octets[i + 1] ?? 0;
    const n = ((octets[i + 2] ?? 0) << 8) | (octets[i + 3] ?? 0);
    if (m >= 0xc0 && m <= 0xc3) {
      composantes = octets[i + 9] ?? 0;
      break;
    }
    i += 2 + n;
  }
  return { largeur: r.width, hauteur: r.height, composantes };
}

/** WebP : alpha annoncé (VP8X, ou bit du VP8L). */
export function webpAvecAlpha(octets: Uint8Array): boolean {
  const type = Buffer.from(octets.subarray(12, 16)).toString("latin1");
  if (type === "VP8X") return ((octets[20] ?? 0) & 0x10) !== 0;
  return type === "VP8L" && ((octets[24] ?? 0) & 0x10) !== 0;
}
