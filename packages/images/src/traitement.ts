// SPDX-License-Identifier: MIT
/** packages/images/src/traitement.ts — pixels des images (Pillow en Python) : refus lus sur l'en-tête, calcul dans un thread de travail (pixels.ts), sur place à défaut. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { reprPy } from "@elpis/commun";
import { journal } from "@elpis/http";

import { ImageError, IMAGE_FORMATS, sniffMime } from "./base";
import { dimensionsImage } from "./dimensions";
import { OPERATIONS, tailleVignette as taillePillow } from "./pixels";
import type { Operation, ReponsePixels, RequetePixels } from "./pixels";

export const SOURCE_MAX_BYTES = 20 * 1024 * 1024;
const SOURCE_MAX_PIXELS = 40_000_000;
export const THUMB_SIDE = 384;
const log = journal("image");

type Attente = { ok: (o: Uint8Array) => void; ko: (e: Error) => void; requete: RequetePixels };
type Thread = { w: Worker; pret: boolean; attentes: Map<number, Attente> };
type Execution = Thread | "sur-place" | null;

let execution: Execution = null;
let suivant = 0;

const surPlace = (r: RequetePixels): Promise<Uint8Array> =>
  (OPERATIONS[r.op] as (...a: unknown[]) => Promise<Uint8Array>)(...r.args);

/** Thread de travail : `pixels.mjs` à côté du bundle (dist), sinon `pixels.ts` (sources) ; `null` si aucun n'est là. */
function demarrer(): Thread | null {
  const url = ["./pixels.mjs", "./pixels.ts"]
    .map((nom) => new URL(nom, import.meta.url))
    .find((u) => u.protocol === "file:" && existsSync(fileURLToPath(u)));
  if (url === undefined) return null;
  const t: Thread = {
    w: new Worker(url, { workerData: { elpis: "pixels" } }),
    pret: false,
    attentes: new Map(),
  };
  t.w.unref();
  t.w.on("message", (m: ReponsePixels) => {
    if ("pret" in m) {
      t.pret = true;
      return;
    }
    const a = t.attentes.get(m.id);
    if (a === undefined) return;
    t.attentes.delete(m.id);
    if (t.attentes.size === 0) t.w.unref();
    if ("resultat" in m) a.ok(m.resultat);
    else a.ko(Object.assign(new Error(m.erreur.message), { name: m.erreur.nom }));
  });
  const arret = (e: Error): void => {
    if (execution !== t) return;
    execution = t.pret ? null : "sur-place";
    const enCours = [...t.attentes.values()];
    t.attentes.clear();
    for (const a of enCours) {
      if (t.pret) a.ko(e);
      else surPlace(a.requete).then(a.ok, a.ko);
    }
  };
  t.w.on("error", arret);
  t.w.on("exit", (code) => arret(new Error(`thread des images arrêté (code ${code})`)));
  return t;
}

/** Démarrage raté : tout passe sur place ; plantage en cours de calcul : le thread repart à l'appel suivant. */
function executer(op: Operation, data: Uint8Array, ...autres: unknown[]): Promise<Uint8Array> {
  execution ??= demarrer() ?? "sur-place";
  const ex = execution;
  if (ex === "sur-place") return surPlace({ id: 0, op, args: [data, ...autres] });
  const copie = new Uint8Array(data);
  const requete: RequetePixels = { id: (suivant += 1), op, args: [copie, ...autres] };
  return new Promise((ok, ko) => {
    if (ex.attentes.size === 0) ex.w.ref();
    ex.attentes.set(requete.id, { ok, ko, requete: { ...requete, args: [data, ...autres] } });
    ex.w.postMessage(requete, [copie.buffer]);
  });
}

/** Signature dHash d'une capture du bureau (`_frame_sig`), calculée hors de la boucle d'événements. */
export async function signatureCapture(data: Uint8Array): Promise<string> {
  return Buffer.from(await executer("signatureCapture", data)).toString("latin1");
}

/** Capture du bureau recadrée pour l'OCR (`_crop_for_region`), hors de la boucle d'événements. */
export function recadrerCapture(
  data: Uint8Array,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<Uint8Array> {
  return executer("recadrerCapture", data, x1, y1, x2, y2);
}

/** Où tournent les calculs : thread de travail, sur place (thread indisponible), ou rien de lancé encore. */
export function modePixels(): "thread" | "sur-place" | "inactif" {
  return execution === null ? "inactif" : execution === "sur-place" ? "sur-place" : "thread";
}

/** Tests : impose l'exécution sur place (`true`) ou rend la main au thread (`false`). */
export async function pixelsSurPlace(oui: boolean): Promise<void> {
  const ex = execution;
  execution = oui ? "sur-place" : null;
  if (ex !== null && ex !== "sur-place") await ex.w.terminate();
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Image source d'une édition → PNG RGB exactement `width × height`, recadrée au centre (cover) ; `ImageError` invalid (400) sinon. */
export async function prepareSource(data: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (data.length === 0 || data.length > SOURCE_MAX_BYTES)
    throw new ImageError("Image source trop lourde (20 Mo au plus).", { code: "invalid", status: 400 });
  if (sniffMime(data) === null)
    throw new ImageError("Image source : PNG, JPEG ou WEBP seulement.", { code: "invalid", status: 400 });
  const dims = dimensionsImage(data, IMAGE_FORMATS);
  if (dims === null)
    throw new ImageError("Image source illisible.", {
      code: "invalid",
      status: 400,
      detail: "en-tête refusé",
    });
  if (dims[0] * dims[1] > SOURCE_MAX_PIXELS)
    throw new ImageError("Image source trop grande.", { code: "invalid", status: 400 });
  try {
    return await executer("preparerSource", data, width, height);
  } catch (e) {
    throw new ImageError("Image source illisible.", {
      code: "invalid",
      status: 400,
      detail: reprPy(message(e)),
      cause: e,
    });
  }
}

/** Taille de `Image.thumbnail((côté, côté))` : rapport gardé, chaque côté arrondi au plus juste (≥ 1), jamais agrandie. */
export const tailleVignette = (w: number, h: number, cote = THUMB_SIDE): [number, number] =>
  taillePillow(w, h, cote);

/** Vignette WebP (qualité 80) de la grille et de la galerie ; `null` si l'image ne se décode pas. */
export async function vignette(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (dimensionsImage(data, IMAGE_FORMATS) === null) throw new Error("en-tête refusé");
    return await executer("vignetter", data, THUMB_SIDE);
  } catch (e) {
    log.info(`vignette impossible : ${message(e)}`);
    return null;
  }
}

/** Capture plus large que `largeurMax` → PNG à cette largeur (hauteur `int(h × ratio)`) ; rend aussi la largeur envoyée. */
export async function reduireLargeur(
  png: Uint8Array,
  largeurMax: number,
  largeurNative: number,
): Promise<{ octets: Uint8Array; largeur: number }> {
  if (largeurNative <= largeurMax || largeurNative <= 0) return { octets: png, largeur: largeurNative || 0 };
  try {
    if (dimensionsImage(png) === null) throw new Error("en-tête refusé");
    return { octets: await executer("reduireEnPng", png, largeurMax), largeur: largeurMax };
  } catch (e) {
    log.debug(`[detect] downscale skipped: ${message(e)}`);
    return { octets: png, largeur: largeurNative };
  }
}

/** Capture PNG → JPEG réduit à `largeurMax` (`_downscale_screenshot` de la vision) ; `null` sur échec. */
export async function reduireCapture(
  png: Uint8Array,
  largeurMax: number,
  qualite: number,
): Promise<Uint8Array | null> {
  try {
    if (dimensionsImage(png) === null) throw new Error("en-tête refusé");
    return await executer("reduireEnJpeg", png, largeurMax, qualite);
  } catch (e) {
    log.warn(`[vision] Downscale échoué: ${message(e)}`);
    return null;
  }
}
