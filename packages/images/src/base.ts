// SPDX-License-Identifier: MIT
/** packages/images/src/base.ts — formats lus, signature d'un en-tête et erreur d'image à code stable. */
import type { FormatImage } from "./dimensions";

/** Formats lus par l'application (sources jointes, réponses des moteurs, vignettes). */
export const IMAGE_FORMATS: readonly FormatImage[] = ["PNG", "JPEG", "WEBP"];

const RETRYABLE = new Set(["unavailable", "timeout", "busy", "engine", "cancelled"]);

export type OptionsErreurImage = { code?: string; detail?: string; status?: number | null; cause?: unknown };

/** Codes : unavailable, forbidden, invalid, timeout, busy, refused, engine, cancelled, too_large ; `detail` reste au journal. */
export class ImageError extends Error {
  override name = "ImageError";
  readonly code: string;
  readonly detail: string;
  readonly status: number | null;

  constructor(message: string, options: OptionsErreurImage = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? "engine";
    this.detail = options.detail ?? "";
    this.status = options.status ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  /** Forme de l'événement `image_error` et du champ du message. */
  payload(): { code: string; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function sniffMime(data: Uint8Array): string | null {
  const a = (...o: number[]): boolean => o.every((x, i) => data[i] === x);
  if (data.length >= 8 && a(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (data.length >= 3 && a(0xff, 0xd8, 0xff)) return "image/jpeg";
  const texte = (debut: number, fin: number): string => String.fromCharCode(...data.subarray(debut, fin));
  if (texte(0, 4) === "RIFF" && texte(8, 12) === "WEBP") return "image/webp";
  return null;
}
