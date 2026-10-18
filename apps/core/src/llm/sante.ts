// SPDX-License-Identifier: MIT
/** apps/core/src/llm/sante.ts — santé du serveur d'inférence : préflight de la cible, modèle chargé (cache 5 s), inventaire, métriques Prometheus. */
import { arrondiPy, floatPy, intPy, quotePy, stripPy, strPy, urlsplit, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { journal } from "../journal";
import { estDict, splitlinesPy, splitPy } from "../python";
import type { Dict } from "../python";
import { currentTarget } from "./cible";
import type { LlmTarget } from "./cible";
import { ClientHttp, ConnectError, delais, getLlmClient } from "./client-http";
import { getPy, inPy, itemPy, iterExige, poserCle } from "./dict-py";
import { buildHeaders as enTetesAnthropic } from "./fournisseurs/anthropic";
import { headers as enTetesOpenai } from "./fournisseurs/openai-compat";
import {
  llamaBaseUrl,
  llamaGet,
  llamaGetText,
  METRICS_OFF_S,
  metricsOffUntil,
  monotonic,
} from "./llama-http";
import { getModelTotalSlots } from "./modeles";
import { BUILTIN_KEY } from "./moteurs";
import { visionFlagFromEntry } from "./vision";

const log = journal("models");

export const PREFLIGHT_OK_TTL_S = 10.0;
export const preflightOkAt = new Map<string, number>();

/** Préflight de joignabilité du serveur de LA requête courante (cible locale ou base du connecteur) ; lève `ConnectError`. */
export async function verifyLlmAvailability(): Promise<void> {
  let target: LlmTarget | null;
  try {
    target = currentTarget();
  } catch {
    target = null;
  }
  let url = config.LLAMA_URL;
  let label = "Serveur LLM injoignable.";
  if (target !== null && !target.isDefault) {
    const base = stripPy(target.baseUrl || "");
    if (!base) return;
    url = base;
    label =
      `Connecteur LLM injoignable (${urlsplit(base).netloc}). ` +
      "Vérifiez l'URL du connecteur et le réseau.";
  }
  try {
    const p = urlsplit(url);
    const baseUrl = `${p.scheme}://${p.netloc}`;
    if (monotonic() - (preflightOkAt.get(baseUrl) ?? -Infinity) < PREFLIGHT_OK_TTL_S) return;
    const externe = target !== null && !target.isLocalLlamacpp;
    const client = getLlmClient(externe ? baseUrl : null);
    let entetes: Record<string, string> | null = null;
    if (target !== null && !target.isDefault) {
      const h = target.wire === "anthropic" ? enTetesAnthropic(target) : enTetesOpenai(target);
      entetes = Object.keys(h).length > 0 ? h : null;
    }
    await client.get(baseUrl, { timeout: 3.0, headers: entetes });
    preflightOkAt.set(baseUrl, monotonic());
  } catch (e) {
    throw new ConnectError(label, { cause: e });
  }
}

export const LOADED_MODEL_TTL_S = 5.0;
export const loadedModelCache: { id: string | null; ts: number } = { id: null, ts: 0.0 };

/** Modèle en VRAM du serveur intégré (`/v1/models`, statut `loaded`), cache 5 s ; une panne rend le dernier connu sans le dater. */
export async function getCurrentlyLoadedModel(): Promise<string | null> {
  const maintenant = monotonic();
  if (maintenant - loadedModelCache.ts < LOADED_MODEL_TTL_S) return loadedModelCache.id;
  try {
    const [modeles, joignable] = await remoteModelsProbe();
    if (!joignable) return loadedModelCache.id;
    const charges = modeles.filter((m) => m["status"] === "loaded").map((m) => m["id"]);
    const choisi = (charges[0] as string | undefined) ?? null;
    loadedModelCache.id = choisi;
    loadedModelCache.ts = maintenant;
    return choisi;
  } catch {
    return loadedModelCache.id;
  }
}

/** Valeur du cache sans rafraîchir (chemins synchrones de l'ordonnanceur). */
export function getCurrentlyLoadedModelSync(): string | null {
  return loadedModelCache.id;
}

/** Posé par les routes de chargement et de déchargement. */
export function setLoadedModelCache(modelId: string | null): void {
  loadedModelCache.id = modelId;
  loadedModelCache.ts = monotonic();
}

function urlModelesIntegre(): string {
  const p = urlsplit(config.LLAMA_URL);
  return `${p.scheme}://${p.netloc}/v1/models`;
}

/** Statut d'une entrée `/v1/models` : `status.value`, sinon `unknown`. */
function statutEntree(m: unknown): [unknown, unknown] {
  const brut = getPy(m, "status");
  const st = brut === null || brut === undefined || brut === false || brut === 0 || brut === "" ? {} : brut;
  return [estDict(st) ? getPy(st, "value", "unknown") : "unknown", st];
}

/** `(modèles, joignable)` d'un corps `/v1/models` : réponse sans liste = joignable mais vide ; forme cassée = lève. */
export function analyserSondeModeles(data: unknown): [Dict[], boolean] {
  if (!inPy("data", data) || !Array.isArray(itemPy(data, "data"))) return [[], true];
  const result: Dict[] = [];
  for (const m of iterExige(itemPy(data, "data"))) {
    if (!inPy("id", m)) continue;
    const [valeur] = statutEntree(m);
    result.push({ id: itemPy(m, "id"), status: valeur });
  }
  return [result, true];
}

/** `(modèles, serveur_joignable)` : distingue « liste vide » de « pas de réponse ». */
export async function remoteModelsProbe(): Promise<[Dict[], boolean]> {
  try {
    const resp = await getLlmClient().get(urlModelesIntegre(), { timeout: 3.0 });
    if (resp.statusCode !== 200) return [[], false];
    return analyserSondeModeles(resp.json());
  } catch (e) {
    log.debug(`llama-server injoignable ou timeout : ${String(e)}`);
    return [[], false];
  }
}

/** Liste `{id, status, vision}` d'un corps `/v1/models` (`failed` si le dernier chargement a échoué). */
export function analyserModelesDistants(data: unknown): Dict[] | null {
  if (!(inPy("data", data) && Array.isArray(itemPy(data, "data")))) return null;
  const result: Dict[] = [];
  for (const m of iterExige(itemPy(data, "data"))) {
    if (!inPy("id", m)) continue;
    const [valeur0, st] = statutEntree(m);
    let valeur = valeur0;
    if (valeur === "unloaded" && estDict(st) && veritePy(getPy(st, "failed"))) valeur = "failed";
    result.push({ id: itemPy(m, "id"), status: valeur, vision: visionFlagFromEntry(m as Dict) });
  }
  return result;
}

/** `/v1/models` de l'intégré avec statut (3 s au plus) ; `[]` sur toute panne. */
export async function getRemoteModelsWithStatus(): Promise<Dict[]> {
  try {
    const resp = await getLlmClient().get(urlModelesIntegre(), { timeout: 3.0 });
    if (resp.statusCode === 200) {
      const r = analyserModelesDistants(resp.json());
      if (r !== null) return r;
    }
  } catch (e) {
    log.debug(`llama-server injoignable ou timeout : ${String(e)}`);
  }
  return [];
}

/** Texte `/metrics` → `{nom: valeur}` ; noms normalisés (`:` → `_`, étiquettes retirées). */
export function parsePrometheusMetrics(text: string | null | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!text) return result;
  for (const brute of splitlinesPy(text)) {
    const ligne = stripPy(brute);
    if (!ligne || ligne.startsWith("#")) continue;
    const parts = splitPy(ligne);
    if (parts.length >= 2) {
      const nom = (parts[0] ?? "").split("{", 1)[0]?.replaceAll(":", "_") ?? "";
      try {
        poserCle(result, nom, floatPy(parts[1]));
      } catch {
        continue;
      }
    }
  }
  return result;
}

export function llamaBaseUrlSync(): string {
  return llamaBaseUrl();
}

/** Chemin `/metrics` d'après `/v1/models` : routeur → le modèle chargé (`autoload=false`), aucun → `null`. */
export function routerMetricsPath(models: unknown): string | null {
  const data = estDict(models) ? getPy(models, "data") : null;
  if (!Array.isArray(data) || !data.some((m) => estDict(m) && Object.hasOwn(m, "status"))) return "/metrics";
  for (const m of data) {
    const st = estDict(m) ? getPy(m, "status") : null;
    const valeur = estDict(st) ? getPy(st, "value") : st;
    if (valeur === "loaded" && veritePy(getPy(m, "id")))
      return `/metrics?model=${quotePy(strPy(getPy(m, "id")), "")}&autoload=false`;
  }
  return null;
}

function kvDepuis(pm: Record<string, number>): Dict | null {
  const kvUsed = pm["llamacpp_kv_cache_tokens"] ?? 0;
  const nCtx = pm["llamacpp_n_ctx_total"] ?? 0;
  if (!(nCtx > 0)) return null;
  return { used: intPy(kvUsed), total: intPy(nCtx), pct: arrondiPy((kvUsed / nCtx) * 100, 1) };
}

/** Santé directe pour le moteur de métriques (le `get_llm_health_sync` de Python, asynchrone ici) : client neuf, 4 s. */
export async function getLlmHealthSync(): Promise<Dict> {
  const base = llamaBaseUrlSync();
  const result: Dict = {
    server_reachable: false,
    status: "unreachable",
    models_loaded: [],
    metrics: {},
    kv_cache: { used: 0, total: 0, pct: 0 },
  };
  let c: ClientHttp | null = null;
  try {
    c = new ClientHttp({ delais: delais(4.0) });
    try {
      const r = await c.get(`${base}/health`);
      if (r.statusCode === 200) {
        result["server_reachable"] = true;
        const h = (r.headers.get("content-type") ?? "").startsWith("application/json") ? r.json() : {};
        result["status"] = getPy(h, "status", "ok");
      }
    } catch (e) {
      log.debug(`/health illisible : ${String(e)}`);
    }
    if (!result["server_reachable"]) return result;
    let metricsPath: string | null = "/metrics";
    try {
      const r = await c.get(`${base}/v1/models`);
      if (r.statusCode === 200) {
        const data = r.json();
        result["models_loaded"] = iterExige(getPy(data, "data", [])).map((m) => ({
          id: getPy(m, "id", "?"),
          meta: getPy(m, "meta", {}),
        }));
        metricsPath = routerMetricsPath(data);
      }
    } catch (e) {
      log.debug(`/v1/models illisible : ${String(e)}`);
    }
    const cle = `${BUILTIN_KEY}${metricsPath}`;
    if (metricsPath === null || (metricsOffUntil.get(cle) ?? 0) > monotonic()) return result;
    try {
      const r = await c.get(`${base}${metricsPath}`);
      if (r.statusCode === 501) metricsOffUntil.set(cle, monotonic() + METRICS_OFF_S);
      if (r.statusCode === 200) {
        const m = parsePrometheusMetrics(r.text);
        result["metrics"] = m;
        const kv = kvDepuis(m);
        if (kv !== null) result["kv_cache"] = kv;
      }
    } catch (e) {
      log.debug(`${metricsPath} illisible : ${String(e)}`);
    }
  } catch (e) {
    log.debug(`santé directe impossible : ${String(e)}`);
  } finally {
    await c?.aclose();
  }
  return result;
}

/** Santé agrégée : `/health`, puis en parallèle `/v1/models`, `/metrics` et `total_slots`. */
export async function getLlmHealth(): Promise<Dict> {
  const result: Dict = {
    server_reachable: false,
    status: "unreachable",
    models_loaded: [],
    kv_cache: { used: 0, total: 0, pct: 0 },
    metrics: {},
  };
  const health = await llamaGet("/health", 3.0);
  if (health !== null) {
    result["server_reachable"] = true;
    result["status"] = getPy(health, "status", "ok");
  } else {
    let c: ClientHttp | null = null;
    try {
      c = new ClientHttp({ delais: delais(3.0) });
      const r = await c.get(llamaBaseUrl());
      result["server_reachable"] = r.statusCode < 500;
      result["status"] = r.statusCode < 500 ? "ok" : "error";
    } catch {
      return result;
    } finally {
      await c?.aclose();
    }
  }
  const sondeSlots = async (): Promise<number> => {
    try {
      return intPy((await getModelTotalSlots()) || 0);
    } catch {
      return 0;
    }
  };
  const [modelsData, metricsText, totalSlots] = await Promise.all([
    llamaGet("/v1/models", 3.0),
    llamaGetText("/metrics", 3.0),
    sondeSlots(),
  ]);
  if (estVrai(modelsData) && inPy("data", modelsData)) {
    result["models_loaded"] = iterExige(itemPy(modelsData, "data")).map((m) => ({
      id: getPy(m, "id", "?"),
      object: getPy(m, "object", "model"),
      owned_by: getPy(m, "owned_by", ""),
      meta: getPy(m, "meta", {}),
    }));
  }
  if (metricsText) {
    const pm = parsePrometheusMetrics(metricsText);
    result["metrics"] = pm;
    const kv = kvDepuis(pm);
    if (kv !== null) result["kv_cache"] = kv;
  }
  const metriques = result["metrics"] as Record<string, number>;
  if (Object.keys(metriques).length > 0) {
    const nCtx = metriques["llamacpp_n_ctx_total"] ?? 0;
    if (nCtx > 0) result["props"] = { ...(result["props"] as Dict | undefined), n_ctx: intPy(nCtx) };
  }
  if (totalSlots > 0) result["props"] = { ...(result["props"] as Dict | undefined), total_slots: totalSlots };
  return result;
}

function estVrai(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return estDict(v) ? Object.keys(v).length > 0 : true;
}
