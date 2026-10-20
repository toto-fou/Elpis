// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/llama-modeles.ts — modèles d'un llama-server en mode routeur : inventaire (cache 3 s), chargement, déchargement, suivi réel d'un chargement. */
import { intPy, stripPy, strPy, veritePy } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";

import { journal } from "../../journal";
import { estDict } from "../../python";
import { avecFlux, ClientHttp, delais, getLlmClient } from "../client-http";
import { getPy, iterExige } from "../dict-py";
import { monotonic } from "../llama-http";
import { builtinEngine, currentEngine } from "../moteurs";
import type { EngineRef } from "../moteurs";
import { baseServeur, engineCaps } from "./llama-capacites";
import type { EngineCaps } from "./llama-capacites";

const log = journal("llama_models");

export const CACHE_TTL_S = 3.0;

export interface CacheInventaire {
  ts: number;
  data: Map<string, string>;
}

/** Inventaire du serveur intégré ; chaque connecteur llama.cpp a le sien. */
export const cacheIntegre: CacheInventaire = { ts: 0.0, data: new Map() };
export const cachesAutres = new Map<string, CacheInventaire>();

type Resolu = [string, Record<string, string> | null, CacheInventaire, EngineRef | null];

/** `[racine, en-têtes, cache, moteur]` : `baseUrl` explicite, sinon `engine`, sinon le serveur de la cible courante. */
function resoudre(baseUrl = "", engine: EngineRef | null = null): Resolu {
  if (baseUrl) return [baseServeur(baseUrl), null, cacheIntegre, null];
  let eng = engine;
  if (eng === null) {
    try {
      eng = currentEngine();
    } catch {
      eng = null;
    }
  }
  if (eng === null || eng.isBuiltin) {
    const integre = eng ?? builtinEngine();
    const h = integre.headerDict();
    return [baseServeur(integre.baseRoot), Object.keys(h).length > 0 ? h : null, cacheIntegre, eng];
  }
  let c = cachesAutres.get(eng.key);
  if (c === undefined) {
    c = { ts: 0.0, data: new Map() };
    cachesAutres.set(eng.key, c);
  }
  const h = eng.headerDict();
  return [baseServeur(eng.baseRoot), Object.keys(h).length > 0 ? h : null, c, eng];
}

async function capsPour(baseUrl: string, engine: EngineRef | null): Promise<EngineCaps> {
  if (engine !== null && !engine.isBuiltin && !baseUrl) return engineCaps("", { engine });
  return engineCaps(baseUrl);
}

function clientPour(racine: string, eng: EngineRef | null): ClientHttp {
  return eng !== null && !eng.isBuiltin ? getLlmClient(racine) : getLlmClient();
}

/** `{nom: loaded | unloaded | loading | failed}` d'un corps `/v1/models`. */
export function analyserInventaire(corps: unknown): Map<string, string> {
  const sortie = new Map<string, string>();
  const donnees = getPy(veritePy(corps) ? corps : {}, "data");
  for (const m of iterExige(veritePy(donnees) ? donnees : [])) {
    if (!estDict(m) || !veritePy(getPy(m, "id"))) continue;
    const st = getPy(m, "status");
    let valeur = estDict(st) ? getPy(st, "value") : st;
    if (valeur === "unloaded" && estDict(st) && veritePy(getPy(st, "failed"))) valeur = "failed";
    sortie.set(strPy(getPy(m, "id")), strPy(veritePy(valeur) ? valeur : "unknown"));
  }
  return sortie;
}

/** Inventaire avec statut ; vide si indisponible (échec mémorisé aussi, TTL 3 s). */
export async function modelStatuses(
  baseUrl = "",
  force = false,
  options: { engine?: EngineRef | null } = {},
): Promise<Map<string, string>> {
  const [racine, headers, cacheV, eng] = resoudre(baseUrl, options.engine ?? null);
  if (!(eng ?? builtinEngine()).profil.capacites.chargement && !baseUrl) return new Map();
  const maintenant = monotonic();
  if (!force && maintenant - cacheV.ts < CACHE_TTL_S) return new Map(cacheV.data);
  try {
    const r = await clientPour(racine, eng).get(`${racine}/v1/models`, { timeout: 5.0, headers });
    if (r.statusCode !== 200) {
      cacheV.ts = maintenant;
      cacheV.data = new Map();
      return new Map();
    }
    const sortie = analyserInventaire(r.json());
    cacheV.ts = maintenant;
    cacheV.data = sortie;
    return new Map(sortie);
  } catch (e) {
    log.debug(`inventaire indisponible : ${String(e).slice(0, 120)}`);
    cacheV.ts = maintenant;
    cacheV.data = new Map();
    return new Map();
  }
}

/** Périme l'inventaire d'un serveur (`null` = tous). */
export function invalidateStatuses(engine: EngineRef | null = null): void {
  if (engine === null) {
    cacheIntegre.ts = 0.0;
    for (const c of cachesAutres.values()) c.ts = 0.0;
    return;
  }
  if (engine.isBuiltin) cacheIntegre.ts = 0.0;
  else {
    const c = cachesAutres.get(engine.key);
    if (c !== undefined) c.ts = 0.0;
  }
}

/** `true` / `false`, ou `null` quand le serveur ne sait pas répondre (mono-modèle, build ancien). */
export async function isLoaded(
  model: string,
  baseUrl = "",
  options: { force?: boolean } = {},
): Promise<boolean | null> {
  if (!model) return null;
  const st = await modelStatuses(baseUrl, options.force ?? false);
  if (st.size === 0) return null;
  return st.get(model) === "loaded";
}

async function poster(
  chemin: string,
  model: string,
  baseUrl: string,
  engine: EngineRef | null,
): Promise<boolean> {
  const [racine, headers, cacheV, eng] = resoudre(baseUrl, engine);
  try {
    if (!(await capsPour(baseUrl, eng)).modelsApi) {
      log.debug(`${chemin} ignoré : pas d'API de modèles`);
      return false;
    }
  } catch {
    // capacités illisibles : on tente quand même
  }
  try {
    const r = await clientPour(racine, eng).post(`${racine}${chemin}`, {
      json: { model },
      timeout: 600.0,
      headers,
    });
    const ok = r.statusCode === 200;
    if (!ok) log.warn(`${chemin} ${model} → HTTP ${r.statusCode} : ${r.text.slice(0, 160)}`);
    cacheV.ts = 0.0;
    return ok;
  } catch (e) {
    log.warn(`${chemin} ${model} a échoué : ${String(e).slice(0, 150)}`);
    return false;
  }
}

/** Demande le chargement (non bloquant côté routeur) ; action globale. */
export function loadModel(
  model: string,
  baseUrl = "",
  options: { engine?: EngineRef | null } = {},
): Promise<boolean> {
  return poster("/models/load", model, baseUrl, options.engine ?? null);
}

/** Décharge un modèle et rend sa VRAM ; action globale. */
export function unloadModel(
  model: string,
  baseUrl = "",
  options: { engine?: EngineRef | null } = {},
): Promise<boolean> {
  return poster("/models/unload", model, baseUrl, options.engine ?? null);
}

export const STATUS_EVENTS: readonly string[] = ["status_change", "model_status"];

/** Progression de TÉLÉCHARGEMENT (octets par URL) en fraction ; `null` sans total. */
export function downloadPct(progress: unknown): number | null {
  if (!estDict(progress) || Object.keys(progress).length === 0) return null;
  let fait = 0;
  let total = 0;
  for (const part of Object.values(progress)) {
    if (!estDict(part)) continue;
    fait += intPy(veritePy(getPy(part, "done")) ? getPy(part, "done") : 0);
    total += intPy(veritePy(getPy(part, "total")) ? getPy(part, "total") : 0);
  }
  if (total <= 0) return null;
  return Math.max(0.0, Math.min(1.0, fait / total));
}

/** Client dédié à un suivi de chargement (une connexion, hors du pool de surveillance) ; remplaçable en test. */
export let newSseClient = (timeoutS: number): ClientHttp =>
  new ClientHttp({
    delais: delais(timeoutS, { connect: 5.0, read: timeoutS, write: 5.0 }),
    limites: { maxConnections: 1, maxKeepaliveConnections: 0, keepaliveExpiry: 5 },
  });

export function poserClientSse(fabrique: (timeoutS: number) => ClientHttp): void {
  newSseClient = fabrique;
}

export type SurProgression = (stage: string, pct: number | null, stages: string[]) => Promise<void> | void;

/** Suit le chargement sur `/models/sse` : `true` en VRAM, `false` en échec, `null` si indisponible ou délai dépassé. */
export async function watchLoad(
  model: string,
  baseUrl = "",
  onProgress: SurProgression | null = null,
  options: { timeoutS?: number; signal?: AbortSignal } = {},
): Promise<boolean | null> {
  if (!model) return null;
  const [racine, headers, cacheV, eng] = resoudre(baseUrl);
  try {
    if (!(await capsPour(baseUrl, eng)).modelsSse) return null;
  } catch {
    return null;
  }
  let client: ClientHttp | null = null;
  try {
    client = newSseClient(options.timeoutS ?? 900.0);
    return await avecFlux(
      client,
      "GET",
      `${racine}/models/sse`,
      { headers: { Accept: "text/event-stream", ...(headers ?? {}) }, signal: options.signal },
      async (resp) => {
        if (resp.statusCode !== 200) return null;
        if ((await isLoaded(model, baseUrl, { force: true })) === true) return true;
        for await (const ligne of resp.aiterLines()) {
          if (!ligne.startsWith("data:")) continue;
          let evt: unknown;
          try {
            evt = parseJsonPy(stripPy(ligne.slice(5)));
          } catch {
            continue;
          }
          if (!estDict(evt) || getPy(evt, "model") !== model) continue;
          const brut = getPy(evt, "data");
          const data = veritePy(brut) ? brut : {};
          if (getPy(evt, "event") === "download_progress") {
            const p = downloadPct(getPy(veritePy(data) ? data : {}, "progress"));
            if (onProgress) await onProgress("download", p === null ? null : p * 100.0, ["download"]);
            continue;
          }
          if (!STATUS_EVENTS.includes(getPy(evt, "event") as string)) continue;
          const statut = strPy(veritePy(getPy(data, "status")) ? getPy(data, "status") : "");
          if (statut === "loaded") {
            cacheV.ts = 0.0;
            return true;
          }
          if (statut === "unloaded" || statut === "failed") {
            cacheV.ts = 0.0;
            return false;
          }
          if (statut !== "loading") continue;
          const progBrut = getPy(data, "progress");
          const prog = veritePy(progBrut) ? progBrut : {};
          if (!onProgress) continue;
          const valeur = getPy(prog, "value");
          const etapesBrut = getPy(prog, "stages");
          const etapes = veritePy(etapesBrut) ? etapesBrut : [];
          const etape = veritePy(getPy(prog, "current")) ? getPy(prog, "current") : getPy(prog, "stage");
          await onProgress(
            strPy(veritePy(etape) ? etape : ""),
            typeof valeur === "number" || typeof valeur === "boolean" ? Number(valeur) * 100.0 : null,
            Array.isArray(etapes) ? etapes.map((x) => strPy(x)) : [],
          );
        }
        return null;
      },
    );
  } catch (e) {
    if (options.signal?.aborted) throw e;
    log.debug(`suivi du chargement de ${model} interrompu : ${String(e).slice(0, 150)}`);
    return null;
  } finally {
    await client?.aclose();
  }
}

export function viderInventaires(): void {
  cacheIntegre.ts = 0.0;
  cacheIntegre.data = new Map();
  cachesAutres.clear();
}
