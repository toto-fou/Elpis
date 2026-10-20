// SPDX-License-Identifier: MIT
/** apps/core/src/llm/sante.ts — santé du serveur d'inférence : préflight de la cible, modèle chargé (cache 5 s), inventaire, métriques Prometheus. */
import { floatPy, intPy, quotePy, stripPy, strPy, urlsplit, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { estDict, splitlinesPy, splitPy } from "../python";
import type { Dict } from "../python";
import { currentTarget } from "./cible";
import type { LlmTarget } from "./cible";
import { ClientHttp, ConnectError, delais, getLlmClient } from "./client-http";
import { getPy, inPy, itemPy, iterExige, poserCle } from "./dict-py";
import { buildHeaders as enTetesAnthropic } from "./fournisseurs/anthropic";
import { headers as enTetesOpenai } from "./fournisseurs/openai-compat";
import { llamaGet, llamaGetText, METRICS_OFF_S, metricsOffUntil, monotonic } from "./llama-http";
import { etatCharge } from "./metriques-moteur";
import type { EtatCharge } from "./metriques-moteur";
import { getModelTotalSlots } from "./modeles";
import { BUILTIN_KEY, builtinEngine, racineIntegre, useEngine } from "./moteurs";
import type { EngineRef } from "./moteurs";
import { vuePubliqueProfil } from "./profils";
import { capaciteKvConnue } from "./sonde-moteur";
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
  let baseUrl = racineIntegre();
  let label = "Serveur LLM injoignable.";
  if (target !== null && !target.isDefault) {
    const base = stripPy(target.baseUrl || "");
    if (!base) return;
    const p = urlsplit(base);
    baseUrl = `${p.scheme}://${p.netloc}`;
    label = `Connecteur LLM injoignable (${p.netloc}). ` + "Vérifiez l'URL du connecteur et le réseau.";
  }
  try {
    if (monotonic() - (preflightOkAt.get(baseUrl) ?? -Infinity) < PREFLIGHT_OK_TTL_S) return;
    const externe = target !== null && !target.isDefault;
    const client = getLlmClient(externe ? baseUrl : null);
    let entetes: Record<string, string> | null = null;
    if (target !== null && !target.isDefault) {
      const h = target.wire === "anthropic" ? enTetesAnthropic(target) : enTetesOpenai(target);
      entetes = Object.keys(h).length > 0 ? h : null;
    } else entetes = entetesDe(builtinEngine());
    await client.get(baseUrl, { timeout: 3.0, headers: entetes });
    preflightOkAt.set(baseUrl, monotonic());
  } catch (e) {
    throw new ConnectError(label, { cause: e });
  }
}

function entetesDe(engine: EngineRef): Record<string, string> | null {
  const h = engine.headerDict();
  return Object.keys(h).length > 0 ? h : null;
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

/** Statut d'une entrée `/v1/models` : `status.value`, sinon `loaded` pour un moteur qui sert tout ce qu'il annonce, sinon `unknown`. */
function statutEntree(m: unknown, servisCharges: boolean): [unknown, unknown] {
  const brut = getPy(m, "status");
  const st = brut === null || brut === undefined || brut === false || brut === 0 || brut === "" ? {} : brut;
  const defaut = servisCharges ? "loaded" : "unknown";
  return [estDict(st) ? getPy(st, "value", defaut) : defaut, st];
}

/** `(modèles, joignable)` d'un corps `/v1/models` : réponse sans liste = joignable mais vide ; forme cassée = lève. */
export function analyserSondeModeles(data: unknown, servisCharges = false): [Dict[], boolean] {
  if (!inPy("data", data) || !Array.isArray(itemPy(data, "data"))) return [[], true];
  const result: Dict[] = [];
  for (const m of iterExige(itemPy(data, "data"))) {
    if (!inPy("id", m)) continue;
    const [valeur] = statutEntree(m, servisCharges);
    result.push({ id: itemPy(m, "id"), status: valeur });
  }
  return [result, true];
}

/** `GET /v1/models` du serveur intégré, avec sa clé ; lève sur panne de transport. */
async function modelesIntegre(): Promise<[number, () => unknown, EngineRef]> {
  const eng = builtinEngine();
  const resp = await getLlmClient().get(eng.url(eng.profil.chemins.modeles), {
    timeout: 3.0,
    headers: entetesDe(eng),
  });
  return [resp.statusCode, () => resp.json(), eng];
}

/** `(modèles, serveur_joignable)` : distingue « liste vide » de « pas de réponse ». */
export async function remoteModelsProbe(): Promise<[Dict[], boolean]> {
  try {
    const [statut, corps, eng] = await modelesIntegre();
    if (statut !== 200) return [[], false];
    return analyserSondeModeles(corps(), eng.profil.capacites.modelesServisCharges);
  } catch (e) {
    log.debug(`serveur d'inférence injoignable ou timeout : ${String(e)}`);
    return [[], false];
  }
}

/** Liste `{id, status, vision}` d'un corps `/v1/models` (`failed` si le dernier chargement a échoué). */
export function analyserModelesDistants(data: unknown, servisCharges = false): Dict[] | null {
  if (!(inPy("data", data) && Array.isArray(itemPy(data, "data")))) return null;
  const result: Dict[] = [];
  for (const m of iterExige(itemPy(data, "data"))) {
    if (!inPy("id", m)) continue;
    const [valeur0, st] = statutEntree(m, servisCharges);
    let valeur = valeur0;
    if (valeur === "unloaded" && estDict(st) && veritePy(getPy(st, "failed"))) valeur = "failed";
    result.push({ id: itemPy(m, "id"), status: valeur, vision: visionFlagFromEntry(m as Dict) });
  }
  return result;
}

/** `/v1/models` de l'intégré avec statut (3 s au plus) ; `[]` sur toute panne. */
export async function getRemoteModelsWithStatus(): Promise<Dict[]> {
  try {
    const [statut, corps, eng] = await modelesIntegre();
    if (statut === 200) {
      const r = analyserModelesDistants(corps(), eng.profil.capacites.modelesServisCharges);
      if (r !== null) return r;
    }
  } catch (e) {
    log.debug(`serveur d'inférence injoignable ou timeout : ${String(e)}`);
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
  return racineIntegre();
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

/** Fenêtre annoncée par `/v1/models` (`max_model_len` de vLLM et SGLang) pour `modele`, sinon la première connue. */
export function contexteAnnonce(data: unknown, modele = ""): number {
  const entrees = estDict(data) ? getPy(data, "data") : null;
  if (!Array.isArray(entrees)) return 0;
  const lire = (m: unknown): number => {
    const v = estDict(m) ? getPy(m, "max_model_len") : null;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  };
  const exact = entrees.find((m) => estDict(m) && (getPy(m, "id") === modele || getPy(m, "root") === modele));
  if (exact !== undefined && lire(exact) > 0) return lire(exact);
  for (const m of entrees) if (lire(m) > 0) return lire(m);
  return 0;
}

function chargeVisible(charge: EtatCharge): Dict {
  return {
    en_cours: charge.en_cours,
    en_attente: charge.en_attente,
    debit_tps: charge.debit_tps,
    cache_prefixe_pct: charge.cache_prefixe_pct,
  };
}

/** Santé directe pour le moteur de métriques (le `get_llm_health_sync` de Python, asynchrone ici) : client neuf, 4 s. */
export async function getLlmHealthSync(): Promise<Dict> {
  const eng = builtinEngine();
  const profil = eng.profil;
  const base = eng.baseRoot;
  const headers = entetesDe(eng);
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
      const r = await c.get(`${base}${profil.chemins.sante ?? profil.chemins.modeles}`, { headers });
      if (r.statusCode === 200) {
        result["server_reachable"] = true;
        const h = (r.headers.get("content-type") ?? "").startsWith("application/json") ? r.json() : {};
        result["status"] = profil.chemins.sante ? getPy(h, "status", "ok") : "ok";
      }
    } catch (e) {
      log.debug(`santé illisible : ${String(e)}`);
    }
    if (!result["server_reachable"]) return result;
    let metricsPath: string | null = profil.chemins.metriques;
    try {
      const r = await c.get(`${base}${profil.chemins.modeles}`, { headers });
      if (r.statusCode === 200) {
        const data = r.json();
        result["models_loaded"] = iterExige(getPy(data, "data", [])).map((m) => ({
          id: getPy(m, "id", "?"),
          meta: getPy(m, "meta", {}),
        }));
        if (profil.capacites.chargement && metricsPath !== null) metricsPath = routerMetricsPath(data);
      }
    } catch (e) {
      log.debug(`/v1/models illisible : ${String(e)}`);
    }
    const cle = `${BUILTIN_KEY}${metricsPath}`;
    if (metricsPath === null || (metricsOffUntil.get(cle) ?? 0) > monotonic()) return result;
    try {
      const r = await c.get(`${base}${metricsPath}`, { headers });
      if (r.statusCode === profil.metriques.statutDesactivees)
        metricsOffUntil.set(cle, monotonic() + METRICS_OFF_S);
      if (r.statusCode === 200) {
        result["metrics"] = parsePrometheusMetrics(r.text);
        const kv = etatCharge(profil, r.text, {
          cle: `sync|${BUILTIN_KEY}`,
          capaciteKv: await capaciteKvConnue(eng),
        }).kv;
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

/** Santé agrégée d'un moteur (l'intégré par défaut) d'après son profil : santé, puis en parallèle modèles, métriques et créneaux. */
export async function getLlmHealth(engine: EngineRef | null = null): Promise<Dict> {
  const eng = engine ?? builtinEngine();
  const profil = eng.profil;
  const result: Dict = {
    server_reachable: false,
    status: "unreachable",
    models_loaded: [],
    kv_cache: { used: 0, total: 0, pct: 0 },
    metrics: {},
    moteur: vuePubliqueProfil(profil),
  };
  const health = profil.chemins.sante ? await llamaGet(profil.chemins.sante, 3.0, { engine: eng }) : null;
  if (health !== null) {
    result["server_reachable"] = true;
    result["status"] = getPy(health, "status", "ok");
  } else {
    let c: ClientHttp | null = null;
    try {
      c = new ClientHttp({ delais: delais(3.0) });
      const r = await c.get(eng.baseRoot, { headers: entetesDe(eng) });
      result["server_reachable"] = r.statusCode < 500;
      result["status"] = r.statusCode < 500 ? "ok" : "error";
    } catch {
      return result;
    } finally {
      await c?.aclose();
    }
  }
  const sondeSlots = async (): Promise<number> => {
    if (!profil.capacites.slots) return 0;
    try {
      return intPy((await useEngine(eng.isBuiltin ? null : eng, () => getModelTotalSlots())) || 0);
    } catch {
      return 0;
    }
  };
  const [modelsData, metricsText, totalSlots, capaciteKv] = await Promise.all([
    llamaGet(profil.chemins.modeles, 3.0, { engine: eng }),
    profil.chemins.metriques ? llamaGetText(profil.chemins.metriques, 3.0, { engine: eng }) : null,
    sondeSlots(),
    capaciteKvConnue(eng),
  ]);
  if (estVrai(modelsData) && inPy("data", modelsData)) {
    result["models_loaded"] = iterExige(itemPy(modelsData, "data")).map((m) => ({
      id: getPy(m, "id", "?"),
      object: getPy(m, "object", "model"),
      owned_by: getPy(m, "owned_by", ""),
      meta: getPy(m, "meta", {}),
    }));
  }
  const charge = etatCharge(profil, metricsText, { cle: eng.key, capaciteKv });
  if (metricsText) {
    result["metrics"] = parsePrometheusMetrics(metricsText);
    if (charge.kv !== null) result["kv_cache"] = charge.kv;
  }
  const visible = chargeVisible(charge);
  if (Object.values(visible).some((v) => v !== null)) result["charge"] = visible;
  const metriques = result["metrics"] as Record<string, number>;
  if (profil.capacites.contexte === "props" && Object.keys(metriques).length > 0) {
    const nCtx = metriques["llamacpp_n_ctx_total"] ?? 0;
    if (nCtx > 0) result["props"] = { ...(result["props"] as Dict | undefined), n_ctx: intPy(nCtx) };
  }
  if (profil.capacites.contexte === "modeles") {
    const nCtx = contexteAnnonce(modelsData);
    if (nCtx > 0) result["props"] = { ...(result["props"] as Dict | undefined), n_ctx: nCtx };
  }
  if (totalSlots > 0) result["props"] = { ...(result["props"] as Dict | undefined), total_slots: totalSlots };
  return result;
}

function estVrai(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return estDict(v) ? Object.keys(v).length > 0 : true;
}
