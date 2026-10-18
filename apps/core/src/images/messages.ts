// SPDX-License-Identifier: MIT
/** apps/core/src/images/messages.ts — champs « image » des messages du chat, assainis à chaque aller-retour : références refaites depuis l'id, demande, méta, erreur, légende lue par le modèle (shared_infra/image/messages.py). */
import {
  arrondiPy,
  estDict,
  floatPy,
  FlottantPy,
  prefixePy,
  rstripPy,
  splitPy,
  stripPy,
  texteOu,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { urlFor, validId } from "./magasin";

/** Plafond des références d'un message : au-delà de ce qu'un tour peut produire. */
export const MAX_REFS = 64;
const CAPTION_PROMPT_MAX = 300;
const ERROR_CODES: readonly string[] = [
  "unavailable",
  "forbidden",
  "invalid",
  "timeout",
  "busy",
  "refused",
  "engine",
  "cancelled",
  "too_large",
];
/** Champs du message assistant qui portent des images (live et rechargement). */
export const MESSAGE_FIELDS = [
  "generated_images",
  "tool_images",
  "revised_prompt",
  "image_meta",
  "image_error",
] as const;

/** Légende persistée : le fil la montre sous l'image, le modèle la lit aux tours suivants à la place de l'image. */
export function caption(prompt: string, n: number): string {
  let p = splitPy(prompt || "").join(" ");
  if (Array.from(p).length > CAPTION_PROMPT_MAX) p = rstripPy(prefixePy(p, CAPTION_PROMPT_MAX)) + "…";
  const tete = n <= 1 ? "Image générée" : `${n} images générées`;
  return `[${tete} : « ${p} »]`;
}

export function failureCaption(message: string): string {
  return `[Échec de la génération d'image : ${message}]`;
}

function entier(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function nombre(v: unknown): number | null {
  return typeof v === "number" || v instanceof FlottantPy ? floatPy(v) : null;
}

/** Références d'images venues du client : champs connus, URL refaites. */
export function sanitizeRefs(value: unknown): Dict[] {
  const out: Dict[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value.slice(0, MAX_REFS)) {
    if (!estDict(item) || !validId(item["id"])) continue;
    const iid = item["id"];
    const ref: Dict = { id: iid, url: urlFor(iid), thumb_url: urlFor(iid, { thumb: true }) };
    for (const k of ["width", "height", "seed"]) {
      const v = entier(item[k]);
      if (v !== null) ref[k] = v;
    }
    const mime = item["mime"];
    if (typeof mime === "string" && ["image/png", "image/jpeg", "image/webp"].includes(mime))
      ref["mime"] = mime;
    out.push(ref);
  }
  return out;
}

/** Options d'un message « Images » (demande de l'utilisateur). */
export function sanitizeRequest(value: unknown): Dict | null {
  if (!estDict(value)) return null;
  const out: Dict = {};
  const size = prefixePy(texteOu(value["size"], ""), 16);
  if (size) out["size"] = size;
  for (const k of ["n", "seed", "steps", "side"]) {
    const v = entier(value[k]);
    if (v !== null) out[k] = v;
  }
  const ratio = value["ratio"];
  if (typeof ratio === "string" && ratio.length > 0 && Array.from(ratio).length <= 8) out["ratio"] = ratio;
  const neg = value["negative_prompt"];
  if (typeof neg === "string" && stripPy(neg)) out["negative_prompt"] = prefixePy(stripPy(neg), 2000);
  if (value["enhance"] === true) out["enhance"] = true;
  const st = nombre(value["strength"]);
  if (st !== null && st >= 0.05 && st <= 1.0) out["strength"] = versFlottantPy(arrondiPy(st, 2));
  if (validId(value["ref_image_id"])) out["ref_image_id"] = value["ref_image_id"];
  const model = value["model"];
  if (typeof model === "string" && stripPy(model)) out["model"] = prefixePy(stripPy(model), 200);
  return out;
}

export function sanitizeMeta(value: unknown): Dict | null {
  if (!estDict(value)) return null;
  const out: Dict = {};
  if (typeof value["model"] === "string") out["model"] = prefixePy(value["model"], 200);
  const d = nombre(value["duration_s"]);
  if (d !== null && d >= 0 && d < 86400) out["duration_s"] = versFlottantPy(arrondiPy(d, 1));
  return Object.keys(out).length ? out : null;
}

export function sanitizeError(value: unknown): Dict | null {
  if (value === true) return { code: "engine", message: "", retryable: true };
  if (!estDict(value)) return null;
  const code = ERROR_CODES.includes(value["code"] as string) ? value["code"] : "engine";
  return {
    code,
    message: prefixePy(texteOu(value["message"], ""), 400),
    retryable: value["retryable"] !== false,
  };
}

/** Recopie dans `dst` les champs « image » assainis de `src`. */
export function copyFields(src: Dict, dst: Dict): void {
  if (src["role"] === "user") {
    const req = sanitizeRequest(src["image_request"]);
    if (req !== null) dst["image_request"] = req;
    return;
  }
  if (src["role"] !== "assistant") return;
  for (const k of ["generated_images", "tool_images"]) {
    const refs = sanitizeRefs(src[k]);
    if (refs.length) dst[k] = refs;
  }
  const rp = src["revised_prompt"];
  if (typeof rp === "string" && stripPy(rp)) dst["revised_prompt"] = prefixePy(stripPy(rp), 2000);
  const meta = sanitizeMeta(src["image_meta"]);
  if (meta) dst["image_meta"] = meta;
  const err = sanitizeError(src["image_error"]);
  if (err) dst["image_error"] = err;
}

/** Un tour est « image » parce que le DERNIER message user porte `image_request`. */
export function isImageRequest(message: unknown): boolean {
  return estDict(message) && estDict(message["image_request"]);
}
