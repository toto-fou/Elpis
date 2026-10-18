// SPDX-License-Identifier: MIT
/** packages/bureau/src/image.ts — captures de l'agent bureau : base64 comme Python, taille, signature perceptuelle (dHash 64 bits de Pillow) et recadrage pour l'OCR, calculés dans le thread des images. */
import { ErreurPython, intPy } from "@elpis/commun";
import { urlsafeB64Decode } from "@elpis/securite";
import { nativeSize } from "./detection";
import { imagesBureau, PortNonInstalle } from "./ports";

const NON_ASCII = /\P{ASCII}/u;

/** `base64.b64decode(s)` : hors alphabet ignoré, rembourrage vérifié (`binascii.Error`, une ValueError). */
export function b64decodePy(s: string): Buffer {
  if (NON_ASCII.test(s))
    throw new ErreurPython("ValueError", "string argument should contain only ASCII characters");
  return urlsafeB64Decode(s.replace(/[-_]/g, ""));
}

/** Alphabet standard strict, longueur multiple de 4, rembourrage (`=`, `==`) en fin seulement ; parcours linéaire (images de plusieurs Mo). */
function base64Strict(s: string): boolean {
  if (s.length % 4 !== 0) return false;
  let rembourrage = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d) {
      if (i < s.length - 2) return false;
      rembourrage = true;
    } else if (
      rembourrage ||
      !(
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x30 && c <= 0x39) ||
        c === 0x2b ||
        c === 0x2f
      )
    )
      return false;
  }
  return true;
}

/** `base64.b64decode(s, validate=True)` : alphabet strict et rembourrage exact, sinon ValueError. */
export function b64decodeStrict(s: string): Buffer {
  if (NON_ASCII.test(s))
    throw new ErreurPython("ValueError", "string argument should contain only ASCII characters");
  if (!base64Strict(s)) throw new ErreurPython("ValueError", "Non-base64 digit found");
  return Buffer.from(s, "base64");
}

/** `_strip_data_url` : la partie base64 d'une data-URL, sinon la chaîne telle quelle. */
export function stripDataUrl(s: string): string {
  return s.startsWith("data:") && s.includes(",") ? s.slice(s.indexOf(",") + 1) : s;
}

/** `_png_size` : largeur et hauteur lues sur l'en-tête (PNG, JPEG, WEBP), `[0, 0]` si illisible. */
export function pngSize(octets: Uint8Array): [number, number] {
  return nativeSize(octets);
}

/** `_frame_sig` : dHash 64 bits de Pillow en hexadécimal, calculé dans le thread des images ; `""` si l'image est illisible. */
export async function frameSig(octets: Uint8Array): Promise<string> {
  try {
    return await imagesBureau().signature(octets);
  } catch (e) {
    if (e instanceof PortNonInstalle) throw e;
    return "";
  }
}

/** `_crop_for_region` : capture recadrée sur la boîte (marge de 6 px) pour un OCR ciblé ; la capture entière si la zone est trop petite ou l'image illisible. */
export async function cropForRegion(
  octets: Uint8Array,
  boite: readonly unknown[],
  marge = 6,
): Promise<Uint8Array> {
  try {
    const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => intPy(boite[i]));
    return await imagesBureau().recadrer(
      octets,
      (x1 ?? 0) - marge,
      (y1 ?? 0) - marge,
      (x2 ?? 0) + marge,
      (y2 ?? 0) + marge,
    );
  } catch (e) {
    if (e instanceof PortNonInstalle) throw e;
    return octets;
  }
}
