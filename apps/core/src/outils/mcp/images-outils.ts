// SPDX-License-Identifier: MIT
/** apps/core/src/outils/mcp/images-outils.ts — images rendues par un outil MCP (blocs `image`) : gardées à part, le texte du résultat n'en porte qu'une référence que la boucle échange contre des images vues par le modèle. */
import { randomUUID } from "node:crypto";

import { pyJsonDumps } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";

import { estDict } from "../../python";
import type { Dict } from "../../python";

export interface ImageOutil {
  readonly mime: string;
  readonly data: string;
}

const MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGES_MAX = 4;
const OCTETS_IMAGE_MAX = 6 << 20;
const OCTETS_TOTAL_MAX = 48 << 20;
const DUREE_MS = 10 * 60_000;
const CLE = "_images_ref";

const enAttente = new Map<string, { images: ImageOutil[]; expire: number; octets: number }>();
let octetsEnAttente = 0;

function purger(maintenant: number): void {
  for (const [ref, e] of enAttente)
    if (e.expire <= maintenant || octetsEnAttente > OCTETS_TOTAL_MAX) {
      enAttente.delete(ref);
      octetsEnAttente -= e.octets;
    }
}

/** Blocs `image` d'un `CallToolResult` (types d'image courants, tailles bornées) et le résultat sans eux ; inchangé sans image. */
export function separerImages(resultat: unknown): [unknown, ImageOutil[]] {
  if (!estDict(resultat) || !Array.isArray(resultat["content"])) return [resultat, []];
  const images: ImageOutil[] = [];
  const reste: unknown[] = [];
  for (const bloc of resultat["content"] as unknown[]) {
    const image =
      estDict(bloc) &&
      bloc["type"] === "image" &&
      typeof bloc["data"] === "string" &&
      MIMES.has(String(bloc["mimeType"]));
    if (!image) reste.push(bloc);
    else if (images.length < IMAGES_MAX && (bloc["data"] as string).length <= OCTETS_IMAGE_MAX)
      images.push({ mime: String(bloc["mimeType"]), data: bloc["data"] as string });
  }
  if (reste.length === (resultat["content"] as unknown[]).length) return [resultat, []];
  return [{ ...resultat, content: reste }, images];
}

/** Charge utile d'outil + images → la charge qui porte la référence des images déposées. */
export function deposerImages(charge: unknown, images: readonly ImageOutil[]): unknown {
  if (!images.length) return charge;
  const maintenant = Date.now();
  purger(maintenant);
  const ref = randomUUID();
  const octets = images.reduce((n, i) => n + i.data.length, 0);
  enAttente.set(ref, { images: [...images], expire: maintenant + DUREE_MS, octets });
  octetsEnAttente += octets;
  return estDict(charge) ? { ...charge, [CLE]: ref } : { result: charge, [CLE]: ref };
}

/** Résultat d'outil (texte JSON) → [résultat sans la référence, images] ; dit au modèle s'il les voit. */
export function reprendreImages(resultat: string, voit: boolean): [string, ImageOutil[]] {
  if (!resultat.includes(CLE)) return [resultat, []];
  let charge: unknown;
  try {
    charge = parseJsonPy(resultat);
  } catch {
    return [resultat, []];
  }
  if (!estDict(charge) || typeof charge[CLE] !== "string") return [resultat, []];
  const entree = enAttente.get(charge[CLE]);
  if (entree) {
    enAttente.delete(charge[CLE]);
    octetsEnAttente -= entree.octets;
  }
  const images = entree?.images ?? [];
  const propre: Dict = Object.fromEntries(Object.entries(charge).filter(([k]) => k !== CLE));
  if (images.length)
    propre["images"] = voit
      ? `${images.length} image(s) shown below`
      : `${images.length} image(s) rendered but not shown: the current model cannot read images`;
  return [pyJsonDumps(propre, { ensureAscii: false }), voit ? images : []];
}

/** Message éphémère qui montre au modèle les images d'un outil (élagué comme les captures d'écran). */
export function messageImages(outil: string, images: readonly ImageOutil[]): Dict {
  return {
    role: "user",
    content: [
      { type: "text", text: `Image(s) returned by ${outil}:` },
      ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
    ],
    _ephemeral: true,
  };
}

/** Tests : vide le dépôt. */
export function viderImages(): void {
  enAttente.clear();
  octetsEnAttente = 0;
}
