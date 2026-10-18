// SPDX-License-Identifier: MIT
/** apps/core/src/llm/vision.ts — capacité vision d'un modèle (entrée `/v1/models` ou sonde de la cible) et dernière capture par chat. */
import { readFile } from "node:fs/promises";

import { strPy } from "@elpis/commun";
import { config } from "@elpis/config";

import { journal } from "../journal";
import { estDict } from "../python";
import type { Dict } from "../python";
import { ClientHttp, delais, sansBarresFinales } from "./client-http";
import {
  LAST_SCREENSHOT,
  VISION_CAPABILITY_CACHE,
  VISION_JPEG_QUALITY,
  VISION_MAX_WIDTH,
  VISION_MODEL_PATTERNS,
} from "./constantes";
import { getPy, inPy, iterExige } from "./dict-py";
import { currentEngine } from "./moteurs";
import type { EngineRef } from "./moteurs";
import { images } from "./ports";

const log = journal("vision");

function vrai(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return estDict(v) ? Object.keys(v).length > 0 : true;
}

function ou<T>(v: unknown, defaut: T): unknown {
  return vrai(v) ? v : defaut;
}

/** Vision déclarée par une entrée `/v1/models` (les formes successives de llama.cpp). */
export function entryHasVision(entry: unknown): boolean {
  return (
    getPy(entry, "multimodal") === true ||
    inPy("vision", ou(getPy(entry, "capabilities"), [])) ||
    inPy("image", ou(getPy(entry, "modalities"), [])) ||
    vrai(getPy(ou(getPy(entry, "meta"), {}), "has_mmproj"))
  );
}

/** L'entrée porte-t-elle des métadonnées de capacité (seulement pour un modèle chargé) ? */
export function entryHasCapabilityMeta(entry: Dict): boolean {
  if (
    Object.hasOwn(entry, "multimodal") ||
    Object.hasOwn(entry, "capabilities") ||
    Object.hasOwn(entry, "modalities")
  )
    return true;
  const meta = getPy(entry, "meta");
  return estDict(meta) && Object.keys(meta).length > 0;
}

function parNom(nom: string): boolean {
  const l = nom.toLowerCase();
  return VISION_MODEL_PATTERNS.some((p) => l.includes(p));
}

/** Vision d'un modèle depuis son entrée déjà téléchargée, sans réseau ; jamais de rétrogradation sans métadonnées. */
export function visionFlagFromEntry(entry: Dict): boolean {
  const idBrut = getPy(entry, "id");
  const nom = strPy(vrai(idBrut) ? idBrut : "");
  if (!nom) return false;
  let vision = entryHasVision(entry);
  if (!vision) vision = parNom(nom);
  const avant = VISION_CAPABILITY_CACHE.get(nom);
  if (avant === true && !vision && !entryHasCapabilityMeta(entry)) vision = true;
  VISION_CAPABILITY_CACHE.set(nom, vision);
  if (vision && avant !== true) log.info(`Modèle ${nom} détecté comme vision-capable`);
  return vision;
}

/** Vision d'un modèle : cache, puis `/v1/models` du serveur de la cible, puis motif du nom. */
export async function modelSupportsVision(modelName: string): Promise<boolean> {
  if (!modelName) return false;
  let eng: EngineRef | null;
  try {
    eng = currentEngine();
  } catch {
    eng = null;
  }
  const cle = eng !== null ? eng.cacheKey(modelName) : modelName;
  const connu = VISION_CAPABILITY_CACHE.get(cle);
  if (connu !== undefined) return connu;
  let vision = false;
  try {
    let baseV1: string;
    let entetes: Record<string, string> | null = null;
    if (eng === null || eng.isBuiltin) {
      let base = sansBarresFinales(config.LLAMA_URL);
      if (base.endsWith("/chat/completions")) base = base.slice(0, -"/chat/completions".length);
      baseV1 = base.endsWith("/v1") ? base : base + "/v1";
    } else {
      baseV1 = eng.baseRoot + "/v1";
      const h = eng.headerDict();
      entetes = Object.keys(h).length > 0 ? h : null;
    }
    const c = new ClientHttp({ delais: delais(3.0) });
    try {
      const r = await c.get(`${baseV1}/models`, { headers: entetes });
      if (r.statusCode === 200) {
        for (const m of iterExige(getPy(r.json(), "data", []))) {
          if (getPy(m, "id") === modelName) {
            vision = entryHasVision(m);
            break;
          }
        }
      }
    } finally {
      await c.aclose();
    }
  } catch (e) {
    log.debug(`/v1/models query failed: ${String(e)}`);
  }
  if (!vision) vision = parNom(modelName);
  VISION_CAPABILITY_CACHE.set(cle, vision);
  if (vision) log.info(`Modèle ${modelName} détecté comme vision-capable`);
  return vision;
}

/** PNG → JPEG réduit à `VISION_MAX_WIDTH` ; sans traitement d'images installé, le PNG passe tel quel (comme sans Pillow). */
export async function downscaleScreenshot(png: Uint8Array): Promise<Uint8Array | null> {
  let port;
  try {
    port = images();
  } catch {
    log.warn("traitement d'images non installé, capture non réduite");
    return png;
  }
  try {
    return await port.reduireCapture(png, VISION_MAX_WIDTH, VISION_JPEG_QUALITY);
  } catch (e) {
    log.warn(`Downscale échoué: ${String(e)}`);
    return null;
  }
}

export const MAX_TRACKED = 32;

/** Garde la dernière capture d'un chat pour le prochain tour vision (LRU de 32). */
export async function trackLastScreenshotForVision(chatKey: string, pngPath: string): Promise<void> {
  try {
    const brut = await readFile(pngPath);
    const reduite = await downscaleScreenshot(brut);
    if (reduite && reduite.length > 0) {
      LAST_SCREENSHOT.delete(chatKey);
      LAST_SCREENSHOT.set(chatKey, reduite);
      while (LAST_SCREENSHOT.size > MAX_TRACKED) {
        const ancienne = LAST_SCREENSHOT.keys().next().value;
        if (ancienne === undefined) break;
        LAST_SCREENSHOT.delete(ancienne);
      }
      log.debug(`Screenshot trackée pour ${chatKey}: ${brut.length} → ${reduite.length} bytes`);
    }
  } catch (e) {
    log.debug(`Track screenshot échoué: ${String(e)}`);
  }
}

/** Dernière capture en URL `data:` JPEG, `null` s'il n'y en a pas. */
export function getLastScreenshotB64(chatKey: string): string | null {
  const octets = LAST_SCREENSHOT.get(chatKey);
  if (!octets || octets.length === 0) return null;
  return `data:image/jpeg;base64,${Buffer.from(octets).toString("base64")}`;
}

export function clearLastScreenshotFor(chatKey: string): void {
  LAST_SCREENSHOT.delete(chatKey);
}
