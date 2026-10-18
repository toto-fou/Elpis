// SPDX-License-Identifier: MIT
/** apps/core/src/images/base.ts — types communs aux moteurs d'images : erreur à code stable, demande, résultat, base64 et signatures. */
import { strPy, veritePy } from "@elpis/commun";
import { dimensionsImage, IMAGE_FORMATS, ImageError, sniffMime } from "@elpis/images";
import type { Dimensions } from "@elpis/images";

import type { Dict } from "../python";

export { IMAGE_FORMATS, ImageError, sniffMime };
export type { OptionsErreurImage } from "@elpis/images";

export const HINT_ADMIN = "Vérifiez Administration › Modèles et services › Images.";
/** Attente maximale en file (sd-server) ou d'un créneau (service OpenAI), en plus du délai de calcul. */
export const QUEUE_MAX_S = 3600.0;

/** Demande validée ; `initImage` : PNG déjà recadré, « init » = img2img, « ref » = image de référence. */
export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  n: number;
  seed: number;
  negativePrompt: string;
  steps: number;
  initImage: Uint8Array | null;
  strength: number;
  editMode: string;
}

export function imageRequest(
  champs: Partial<ImageRequest> & Pick<ImageRequest, "prompt" | "width" | "height">,
): ImageRequest {
  return {
    n: 1,
    seed: -1,
    negativePrompt: "",
    steps: 0,
    initImage: null,
    strength: 0,
    editMode: "init",
    ...champs,
  };
}

export interface ImageResult {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
  seed: number | null;
  revisedPrompt: string;
  extra: Dict;
}

/** Ce que le moteur sait vraiment : début du calcul (epoch), pourcentage réel, aperçu en data URL. */
export type InfoProgres = { started_at?: number; pct?: number; preview?: string };
/** `on_progress(state, queue_position, info)`. */
export type SuiviProgres = (state: string, queuePosition?: unknown, info?: InfoProgres | null) => unknown;

export interface ModeleImage {
  id: string;
  label: string;
}

export interface ImageProvider {
  capabilities(signal?: AbortSignal): Promise<Dict>;
  listModels(signal?: AbortSignal): Promise<ModeleImage[]>;
  generate(req: ImageRequest, onProgress: SuiviProgres, signal?: AbortSignal): Promise<ImageResult[]>;
}

/** Horloges en secondes : monotone (durées, délais) et murale (epoch, comparée à celle du moteur). */
export interface Horloges {
  monotone(): number;
  murale(): number;
}

export const HORLOGES_SYSTEME: Horloges = {
  monotone: () => performance.now() / 1000,
  murale: () => Date.now() / 1000,
};

export function dataUrl(png: Uint8Array): string {
  return "data:image/png;base64," + Buffer.from(png).toString("base64");
}

const BASE64_CANONIQUE = /^[A-Za-z0-9+/]*={0,2}$/;
const HORS_ALPHABET = /[^A-Za-z0-9+/=]/g;
const NON_ASCII = /[\u0080-\uffff]/;

/** `binascii.a2b_base64(s, strict_mode=False)` : caractères hors alphabet ignorés, arrêt au remplissage complet. */
function a2bBase64(s: string): Uint8Array {
  if (s.length % 4 === 0 && BASE64_CANONIQUE.test(s)) return Buffer.from(s, "base64");
  const t = s.replace(HORS_ALPHABET, "");
  let [donnees, apres, fin, complet] = [0, 0, t.length, false];
  for (const m of t.matchAll(/=+/g)) {
    donnees += m.index - apres;
    apres = m.index + m[0].length;
    const quad = donnees % 4;
    if (quad === 3 || (quad === 2 && m[0].length >= 2)) {
      [fin, complet] = [m.index, true];
      break;
    }
  }
  const utiles = t.slice(0, fin).replaceAll("=", "");
  if (!complet && utiles.length % 4 === 1)
    throw new Error(
      `Invalid base64-encoded string: number of data characters (${utiles.length}) cannot be 1 more than a multiple of 4`,
    );
  if (!complet && utiles.length % 4 !== 0) throw new Error("Incorrect padding");
  return Buffer.from(utiles, "base64");
}

/** Base64 brut ou data URL → octets ; `ImageError` (engine) si illisible ou non ASCII. */
export function decodeB64(value: unknown): Uint8Array {
  let s = strPy(veritePy(value) ? value : "");
  if (s.startsWith("data:") && s.includes(",")) s = s.slice(s.indexOf(",") + 1);
  try {
    if (NON_ASCII.test(s)) throw new Error("string argument should contain only ASCII characters");
    return a2bBase64(s);
  } catch (e) {
    throw new ImageError("Image illisible renvoyée par le moteur.", {
      code: "engine",
      detail: e instanceof Error ? e.message : String(e),
      cause: e,
    });
  }
}

/** Taille réelle (en-tête seulement) ; `fallback` si illisible : le moteur peut arrondir la taille demandée. */
export function imageDims(data: Uint8Array, fallback: Dimensions): Dimensions {
  return dimensionsImage(data, IMAGE_FORMATS) ?? fallback;
}

/** Base64 (ou octets) d'un moteur → résultat vérifié (signature d'image exigée). */
export function toResult(
  raw: unknown,
  fallback: Dimensions,
  options: { seed?: number | null; revisedPrompt?: string } = {},
): ImageResult {
  const data = raw instanceof Uint8Array ? raw : decodeB64(raw);
  const mime = sniffMime(data);
  if (!mime) throw new ImageError("Le moteur a renvoyé autre chose qu'une image.", { code: "engine" });
  const [width, height] = imageDims(data, fallback);
  return {
    data,
    mime,
    width,
    height,
    seed: options.seed ?? null,
    revisedPrompt: options.revisedPrompt ?? "",
    extra: {},
  };
}
