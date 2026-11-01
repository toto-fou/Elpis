// SPDX-License-Identifier: MIT
/** apps/core/src/llm/modeles.ts — fenêtre par slot, nombre de slots et slots occupés du serveur de la cible (caches du process à TTL) ; invalidation globale par registre. */
import { ErreurPython, estErreurPython, intPy, quotePy, stripPy, strPy, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { estDict } from "../python";
import type { Dict } from "../python";
import { VISION_CAPABILITY_CACHE } from "./constantes";
import { getPy } from "./dict-py";
import { engineCaps } from "./fournisseurs/llama-capacites";
import { llamaGet, llamaGetText, monotonic } from "./llama-http";
import { currentEngine, engineLimits } from "./moteurs";
import type { EngineRef } from "./moteurs";
import { viderAuChangement, viderInscrit } from "./registre-caches";
import { contexteAnnonce, parsePrometheusMetrics } from "./sante";

const log = journal("model_info");

export const CTX_CACHE_TTL_S = 300.0;
export const cachedContextSize = new Map<string, number>();
export const cachedContextSizeTs = new Map<string, number>();

function setCtxCache(cle: string, valeur: number): void {
  cachedContextSize.set(cle, valeur);
  cachedContextSizeTs.set(cle, monotonic());
}

/** `"&autoload=false"` quand le moteur sait sonder SANS charger, `""` sinon (sans preuve, la sonde historique). */
export async function autoloadSuffix(): Promise<string> {
  try {
    return (await engineCaps()).autoloadParam ? "&autoload=false" : "";
  } catch {
    return "";
  }
}

/** `n_ctx` d'une réponse `/props` : `default_generation_settings.n_ctx`, puis `.params.n_ctx`, puis la racine. */
export function extractNCtx(props: unknown): number {
  if (!estDict(props)) return 0;
  const brut = getPy(props, "default_generation_settings");
  const gs = veritePy(brut) ? brut : {};
  if (!estDict(gs)) return 0;
  let n = getPy(gs, "n_ctx");
  if (!veritePy(n)) {
    const params = getPy(gs, "params");
    if (estDict(params)) n = getPy(params, "n_ctx");
  }
  if (!veritePy(n)) n = getPy(props, "n_ctx");
  try {
    return veritePy(n) ? intPy(n) : 0;
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return 0;
    throw e;
  }
}

function cheminProps(modelId: string, suffixe: string): string {
  return `/props?model=${quotePy(modelId, "")}${suffixe}`;
}

/** Fenêtre d'une requête d'après le profil : `/props` de llama.cpp (par slot), `max_model_len` de vLLM et SGLang ; 0 = inconnue. */
export async function getModelContextSize(modelId?: string | null): Promise<number> {
  const eng = currentEngine();
  const source = eng.profil.capacites.contexte;
  if (source === "aucune") return 0;
  if (source === "modeles") return contexteAnnonceDuMoteur(eng, modelId);
  const cle = eng.cacheKey(modelId);
  const hit = cachedContextSize.get(cle) ?? 0;
  if (hit > 0) {
    if (monotonic() - (cachedContextSizeTs.get(cle) ?? 0.0) < CTX_CACHE_TTL_S) return hit;
    cachedContextSize.delete(cle);
    cachedContextSizeTs.delete(cle);
  }
  const surcharge = eng.isBuiltin ? stripPy(process.env["LLAMA_N_CTX_PER_SLOT"] || "") : "";
  if (surcharge) {
    try {
      const v = intPy(surcharge);
      if (v > 0) {
        setCtxCache(cle, v);
        log.info(`[context_size] n_ctx/slot=${v} (override LLAMA_N_CTX_PER_SLOT)`);
        return v;
      }
    } catch (e) {
      if (!(e instanceof ErreurPython && e.type === "ValueError")) throw e;
      log.warn(`[context_size] LLAMA_N_CTX_PER_SLOT invalide (${surcharge}) — ignoré`);
    }
  }
  if (modelId) {
    const props = await llamaGet(cheminProps(modelId, await autoloadSuffix()), 3.0);
    if (veritePy(props)) {
      const n = extractNCtx(props);
      if (n > 0) {
        setCtxCache(cle, n);
        log.info(`[context_size] n_ctx/slot=${n} (via /props?model=${modelId} — déjà par slot)`);
        return n;
      }
    }
  }
  const props = await llamaGet("/props", 3.0);
  if (veritePy(props)) {
    const n = extractNCtx(props);
    if (n > 0) {
      setCtxCache(cle, n);
      log.info(`[context_size] n_ctx/slot=${n} (via /props — déjà par slot)`);
      return n;
    }
  }
  const texte = await llamaGetText("/metrics", 3.0);
  if (texte) {
    const pm = parsePrometheusMetrics(texte);
    const total = intPy(pm["llamacpp_n_ctx_total"] ?? 0);
    if (total > 0) {
      const slots = await getModelTotalSlots(modelId);
      if (slots >= 1) {
        const parSlot = Math.floor(total / slots);
        setCtxCache(cle, parSlot);
        if (slots > 1)
          log.info(`[context_size] n_ctx/slot=${parSlot} (via /metrics : total=${total} ÷ ${slots} slots)`);
        return parSlot;
      }
      let diviseur: number;
      try {
        const [, concurrence] = await engineLimits(eng);
        diviseur = Math.max(1, intPy(concurrence || 1));
      } catch {
        diviseur = 1;
      }
      const parSlot = Math.floor(total / diviseur);
      log.warn(
        `[context_size] n_ctx=${parSlot} via /metrics, total_slots INCONNU — repli conservateur total=${total} ÷ ` +
          `concurrence=${diviseur} (NON caché). Fixe LLAMA_N_CTX_PER_SLOT pour un budget exact.`,
      );
      return parSlot;
    }
  }
  log.debug("[context_size] n_ctx indisponible — troncature auto désactivée.");
  return 0;
}

/** `max_model_len` de `/v1/models` (vLLM, SGLang) pour ce modèle, sinon le premier annoncé ; mémorisé comme `/props`. */
async function contexteAnnonceDuMoteur(eng: EngineRef, modelId?: string | null): Promise<number> {
  const cle = eng.cacheKey(modelId);
  const hit = cachedContextSize.get(cle) ?? 0;
  if (hit > 0 && monotonic() - (cachedContextSizeTs.get(cle) ?? 0.0) < CTX_CACHE_TTL_S) return hit;
  const n = contexteAnnonce(await llamaGet(eng.profil.chemins.modeles, 3.0, { engine: eng }), modelId || "");
  if (n > 0) {
    setCtxCache(cle, n);
    log.info(`[context_size] n_ctx=${n} (max_model_len de ${eng.profil.libelle}, ${modelId || "défaut"})`);
  }
  return n;
}

/** Sans argument : tout le cache ; avec `modelId` : cette clé brute seulement (`""` = défaut). */
export function invalidateContextSizeCache(modelId?: string | null): void {
  if (modelId === undefined || modelId === null) {
    cachedContextSize.clear();
    cachedContextSizeTs.clear();
  } else {
    cachedContextSize.delete(modelId || "");
    cachedContextSizeTs.delete(modelId || "");
  }
}

let cachedTotalSlots = 0;
export const totalSlotsCache = new Map<string, [number, number]>();

/** Vue « dernier connu » des slots de l'intégré (lue sans I/O par l'épinglage et l'ordonnanceur). */
export function getCachedTotalSlots(): number {
  return cachedTotalSlots;
}

/** Valeur posée à la main (tests, injection) : respectée tant que le cache par modèle est vide. */
export function setCachedTotalSlots(n: number): void {
  cachedTotalSlots = n;
}

/** `total_slots` (ou `max_instances` d'un routeur) d'une réponse `/props`. */
export function extractSlots(props: unknown): number {
  if (!estDict(props)) return 0;
  for (const cle of ["total_slots", "max_instances"]) {
    const v = getPy(props, cle);
    try {
      if (veritePy(v) && intPy(v) > 0) return intPy(v);
    } catch (e) {
      if (estErreurPython(e, "TypeError", "ValueError")) continue;
      throw e;
    }
  }
  return 0;
}

/** Slots parallèles (`-np`) du serveur de la cible, cache par modèle à TTL ; 0 si injoignable ou sans slots. */
export async function getModelTotalSlots(modelId?: string | null): Promise<number> {
  const eng = currentEngine();
  if (!eng.profil.capacites.slots) return 0;
  const cle = eng.cacheKey(modelId);
  const hit = totalSlotsCache.get(cle);
  if (hit && monotonic() - hit[1] < CTX_CACHE_TTL_S && hit[0] > 0) {
    if (eng.isBuiltin) cachedTotalSlots = hit[0];
    return hit[0];
  }
  if (eng.isBuiltin && cachedTotalSlots > 0 && cle === "" && totalSlotsCache.size === 0)
    return cachedTotalSlots;
  if (modelId) {
    const props = await llamaGet(cheminProps(modelId, await autoloadSuffix()), 3.0);
    if (veritePy(props)) {
      const total = extractSlots(props);
      if (total > 0) {
        if (eng.isBuiltin) cachedTotalSlots = total;
        totalSlotsCache.set(cle, [total, monotonic()]);
        log.info(`[total_slots] total_slots=${total} (via /props?model=${modelId})`);
        return total;
      }
    }
  }
  const props = await llamaGet("/props", 3.0);
  if (veritePy(props)) {
    const total = extractSlots(props);
    if (total > 0) {
      if (eng.isBuiltin) cachedTotalSlots = total;
      const p = props as Dict;
      const source = p["role"] === "router" && !veritePy(p["total_slots"]) ? "max_instances" : "total_slots";
      totalSlotsCache.set(cle, [total, monotonic()]);
      log.info(`[total_slots] ${source}=${total} (via /props, role=${strPy(p["role"] ?? "?")})`);
      return total;
    }
  }
  log.debug("[total_slots] indisponible — fallback config.");
  return 0;
}

export function invalidateTotalSlotsCache(): void {
  cachedTotalSlots = 0;
  totalSlotsCache.clear();
}

export const SLOTS_SNAPSHOT_TTL = 2.0;
export const SLOTS_FAIL_TTL = 30.0;

let slotsBusyCache: ReadonlySet<number> | null = null;
let slotsBusyTs = 0.0;
export const slotsBusyOther = new Map<string, [ReadonlySet<number> | null, number]>();

/** Instantané de l'intégré (tests) : `[slots occupés, horodatage]`. */
export function etatSlotsOccupes(): [ReadonlySet<number> | null, number] {
  return [slotsBusyCache, slotsBusyTs];
}

export function poserSlotsOccupes(cache: ReadonlySet<number> | null, ts: number): void {
  slotsBusyCache = cache;
  slotsBusyTs = ts;
}

function occupe(s: Dict): boolean {
  let enCours = getPy(s, "is_processing");
  if (enCours === null || enCours === undefined) {
    const st = getPy(s, "state");
    enCours = st === 1 || st === true || st === "processing" || st === "PROCESSING";
  }
  return veritePy(enCours);
}

function ajouterId(occupes: Set<number>, id: unknown): void {
  try {
    occupes.add(intPy(id));
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
  }
}

/** Slots EN TRAITEMENT d'une réponse `/slots` (`is_processing`, sinon `state` 1 / processing). */
export function parseBusy(slots: readonly unknown[]): ReadonlySet<number> {
  const occupes = new Set<number>();
  for (const s of slots) {
    if (!estDict(s)) continue;
    const id = getPy(s, "id");
    if (id === null || id === undefined) continue;
    if (occupe(s)) ajouterId(occupes, id);
  }
  return occupes;
}

/** Slots occupés du serveur de la cible (TTL 2 s, échec mémorisé 30 s) ; `frais` relit `/slots` malgré le TTL (pas pendant un échec mémorisé) ; `null` pour un moteur sans slots. */
export async function getBusySlotsSnapshot(
  options: { frais?: boolean } = {},
): Promise<ReadonlySet<number> | null> {
  const maintenant = monotonic();
  const frais = options.frais ?? false;
  const eng = currentEngine();
  if (!eng.profil.capacites.slots) return null;
  if (!eng.isBuiltin) return busySlotsOther(eng, maintenant, frais);
  if (
    slotsBusyCache !== null &&
    (slotsBusyTs > maintenant || (!frais && maintenant - slotsBusyTs < SLOTS_SNAPSHOT_TTL))
  )
    return slotsBusyCache;
  const slots = await llamaGet("/slots", 2.0);
  if (!Array.isArray(slots)) {
    slotsBusyTs = maintenant + Math.max(0.0, SLOTS_FAIL_TTL - SLOTS_SNAPSHOT_TTL);
    slotsBusyCache ??= new Set<number>();
    return slotsBusyCache;
  }
  slotsBusyCache = parseBusy(slots);
  slotsBusyTs = maintenant;
  return slotsBusyCache;
}

async function busySlotsOther(
  eng: EngineRef,
  maintenant: number,
  frais: boolean,
): Promise<ReadonlySet<number> | null> {
  const hit = slotsBusyOther.get(eng.key);
  if (hit !== undefined && maintenant < hit[1] && !(frais && hit[1] - maintenant <= SLOTS_SNAPSHOT_TTL))
    return hit[0];
  const slots = await llamaGet("/slots", 2.0);
  if (!Array.isArray(slots)) {
    const snap = hit !== undefined && hit[0] !== null ? hit[0] : new Set<number>();
    slotsBusyOther.set(eng.key, [snap, maintenant + SLOTS_FAIL_TTL]);
    return snap;
  }
  const snap = parseBusy(slots);
  slotsBusyOther.set(eng.key, [snap, maintenant + SLOTS_SNAPSHOT_TTL]);
  return snap;
}

/** Caches à vider quand le modèle chargé change (n_ctx, slots, puis les caches inscrits : paramètres, tokenisation). */
export function invaliderAuChangementDeModele(): void {
  invalidateContextSizeCache();
  invalidateTotalSlotsCache();
  viderAuChangement();
}

/** Bouton admin « Invalider les caches » : n_ctx, slots, paramètres, vision, fenêtres distantes ; rend le bilan. */
export function invalidateAllModelCaches(): Dict {
  const resume: Dict = {};
  resume["context_size_was_cached"] = cachedContextSize.size > 0;
  resume["context_size_entries_cleared"] = cachedContextSize.size;
  cachedContextSize.clear();
  cachedContextSizeTs.clear();
  resume["total_slots_was_cached"] = cachedTotalSlots > 0;
  resume["total_slots_entries_cleared"] = totalSlotsCache.size;
  cachedTotalSlots = 0;
  totalSlotsCache.clear();
  slotsBusyOther.clear();
  slotsBusyCache = null;
  slotsBusyTs = 0.0;
  resume["llm_params_entries_cleared"] = viderInscrit("llm_params_entries_cleared");
  resume["vision_entries_cleared"] = VISION_CAPABILITY_CACHE.size;
  VISION_CAPABILITY_CACHE.clear();
  resume["ctx_window_entries_cleared"] = viderInscrit("ctx_window_entries_cleared");
  log.info(
    `[cache] Invalidation globale : n_ctx=${resume["context_size_was_cached"] ? "True" : "False"}, ` +
      `total_slots=${resume["total_slots_was_cached"] ? "True" : "False"}, ` +
      `llm_params=${String(resume["llm_params_entries_cleared"])}, vision=${String(resume["vision_entries_cleared"])}`,
  );
  return resume;
}
