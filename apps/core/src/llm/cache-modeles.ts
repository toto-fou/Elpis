// SPDX-License-Identifier: MIT
/** apps/core/src/llm/cache-modeles.ts — état des modèles du serveur intégré (sondé toutes les 10 s, diffusé s'il change) et crochets du bus d'événements. */
import { comparePointsDeCode, pyJsonDumps } from "@elpis/commun";

import { journal } from "../journal";
import { estDict } from "../python";
import type { Dict } from "../python";
import { getPy } from "./dict-py";
import { BUILTIN_KEY } from "./moteurs";
import { accesMoteurs, diffusion } from "./ports";
import { getLlmHealth, getRemoteModelsWithStatus } from "./sante";

const log = journal("model_cache");

/** Dernier état servi par `/api/llm/models` (muté en place). */
export const modelCache: Dict = {};
/** Modèles en VRAM d'après le dernier rafraîchissement (muté en place). */
export const CURRENT_LOADED_MODELS = new Set<string>();
let empreinte = "";

function triable(valeurs: unknown[]): unknown[] {
  return [...valeurs].sort((a, b) => comparePointsDeCode(String(a), String(b)));
}

/** Sonde santé et inventaire, met l'état à jour, diffuse `model_status` quand il change ; jamais d'exception. */
export async function refreshModelCache(): Promise<void> {
  try {
    const [sante, modeles] = await Promise.all([getLlmHealth(), getRemoteModelsWithStatus()]);
    const ids = modeles.map((m) => m["id"]);
    const charges = new Set(modeles.filter((m) => m["status"] === "loaded").map((m) => m["id"] as string));
    CURRENT_LOADED_MODELS.clear();
    for (const id of charges) CURRENT_LOADED_MODELS.add(id);
    sante["models_loaded"] = [...charges].map((id) => ({ id }));
    if (!estDict(sante["props"])) sante["props"] = {};
    (sante["props"] as Dict)["model"] = charges.size > 0 ? [...charges][0] : "";
    for (const m of modeles) if (!Object.hasOwn(m, "vision")) m["vision"] = false;
    const nouveau: Dict = {
      models: ids,
      models_with_status: modeles,
      models_loaded: getPy(sante, "models_loaded", []),
      kv_cache: getPy(sante, "kv_cache", {}),
      server_reachable: getPy(sante, "server_reachable", false),
      status: getPy(sante, "status", "unreachable"),
      props: getPy(sante, "props", {}),
    };
    const nouvelle = pyJsonDumps(
      {
        ids: triable(ids),
        loaded: triable([...charges]),
        status: getPy(sante, "status", ""),
        kv_pct: getPy(getPy(sante, "kv_cache", {}), "pct", 0),
      },
      { sortKeys: true },
    );
    Object.assign(modelCache, nouveau);
    if (nouvelle !== empreinte) {
      empreinte = nouvelle;
      diffusion().diffuser({ type: "model_status", data: nouveau });
    }
  } catch (e) {
    log.debug(`refresh error: ${String(e)}`);
  }
}

let relais: (() => Promise<unknown>) | null = null;

/** Rafraîchissement porté au-delà de ce process : posé dans l'admin, qui le demande à main par le canal interne. */
export function installerRelaisModeles(fn: (() => Promise<unknown>) | null): void {
  relais = fn;
}

/** Après un chargement ou un déchargement : ici (la diffusion de main atteint l'admin par le canal interne), puis main si le relais est posé. */
export async function refreshModelsEverywhere(): Promise<void> {
  await refreshModelCache();
  if (relais === null) return;
  try {
    await relais();
  } catch (e) {
    log.debug(`diffusion inter-process impossible : ${String(e)}`);
  }
}

export const INTERVALLE_SONDE_S = 10;
let sonde: AbortController | null = null;

/** Démarre (une fois) la sonde de fond : un rafraîchissement toutes les 10 s jusqu'à `arreterSondeModeles`. */
export function ensureModelPoller(): void {
  if (sonde !== null) return;
  const controle = new AbortController();
  sonde = controle;
  const tour = (): void => {
    if (controle.signal.aborted) return;
    void refreshModelCache().finally(() => {
      if (controle.signal.aborted) return;
      setTimeout(tour, INTERVALLE_SONDE_S * 1000).unref();
    });
  };
  tour();
  log.info("Background model poller started (10s interval)");
}

/** Arrêt du process (ou test) : plus de rafraîchissement planifié. */
export function arreterSondeModeles(): void {
  sonde?.abort();
  sonde = null;
}

/** Crochet du bus : ouverture d'un flux `/api/system-events` ou abonnement de l'admin au canal de main → la sonde des modèles tourne. */
export function surOuvertureFlux(): void {
  ensureModelPoller();
}

/** Crochet du bus : événement de contrôle `model_cache_refresh` reçu de l'admin. */
export function rafraichirModeles(): void {
  void refreshModelCache();
}

/** Crochet du bus : `model_status` ne part que vers les comptes qui voient le serveur intégré (ouvert en cas de doute). */
export function peutVoirModeles(uid: number): boolean {
  try {
    return Boolean(accesMoteurs().peutUtiliserMoteur(uid, BUILTIN_KEY));
  } catch {
    return true;
  }
}

export function viderCacheModeles(): void {
  for (const cle of Object.keys(modelCache)) Reflect.deleteProperty(modelCache, cle);
  CURRENT_LOADED_MODELS.clear();
  empreinte = "";
}
