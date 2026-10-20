// SPDX-License-Identifier: MIT
/** apps/core/src/llm/ordonnanceur/process.ts — l'ordonnanceur du process (`LLMQueue` unique, créneaux d'images `image:` compris) : politiques des serveurs, créneaux de `/props`, mode, inventaire et disjoncteur branchés sur le moteur. */
import { strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";

import { politiqueServeurImages } from "../../images/ports";
import { journal } from "../../journal";
import { getLlamaCapabilities, resolveSchedulingMode } from "../capacites";
import { currentTarget } from "../cible";
import { modelStatuses } from "../fournisseurs/llama-modeles";
import { getCachedTotalSlots, getModelTotalSlots } from "../modeles";
import { BUILTIN_KEY, currentEngine, engineLimits, useEngine } from "../moteurs";
import type { EngineRef } from "../moteurs";
import type { PortDisjoncteur } from "../ports";
import { llmErrorKind } from "../reprises";
import { LIMITS_TTL_S, LLMQueue } from "./file";
import type { Moteur, Politique, Priorite, Slot, SourcesFile } from "./file";

const log = journal("llm_queue");

/** Politique d'un connecteur relue en base (5 s), dernier `total_slots` de son `/props`, dernier inventaire du routeur. */
const politiques = new Map<string, { t: number; politique: Politique }>();
const totaux = new Map<string, number>();
const inventaires = new Map<string, ReadonlyMap<string, string>>();

function positif(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
}

/** Sources réelles : l'intégré suit config.json, un connecteur ses réglages (migration 0019) puis son `/props`. */
export function sourcesDuProcess(): SourcesFile {
  return {
    politique: (server) =>
      politiqueServeurImages(server) ??
      (server === BUILTIN_KEY
        ? {
            maxModels: positif(config.LLAMA_MAX_MODELS),
            maxConcurrency: positif(config.LLAMA_MAX_CONCURRENCY),
          }
        : (politiques.get(server)?.politique ?? { maxModels: 1, maxConcurrency: 1 })),
    totalSlots: (server) => (server === BUILTIN_KEY ? getCachedTotalSlots() : (totaux.get(server) ?? 0)),
    modeConfigure: () => resolveSchedulingMode(),
    modeRecommande: () => "classic",
    modeleParDefaut: () => currentTarget().model || config.LLAMA_MODEL,
    statutsModeles: (server) => inventaires.get(server) ?? null,
    modeleChargeConnu: (server) => {
      if (server !== BUILTIN_KEY) return null;
      const charge = getLlamaCapabilities()["loaded_model"];
      return veritePy(charge) ? strPy(charge) : null;
    },
    moteurCourant: () => moteurDeFile(currentEngine()),
    classerErreur: llmErrorKind,
  };
}

let instance: LLMQueue | null = null;

export function ordonnanceur(): LLMQueue {
  instance ??= new LLMQueue(sourcesDuProcess());
  return instance;
}

/** Tests : pose une file (ou la remet à neuf avec `null`) et oublie ce qui a été relu des serveurs. */
export function installerOrdonnanceur(q: LLMQueue | null): void {
  instance = q;
  politiques.clear();
  totaux.clear();
  inventaires.clear();
}

/** Seuls les moteurs dont le profil le demande passent par la file (llama.cpp) ; vLLM et SGLang regroupent eux-mêmes les requêtes. */
export function moteurDeFile(engine: EngineRef): Moteur {
  return { id: engine.key, enFile: engine.profil.capacites.file };
}

/** `scheduling_for` + `_resolve_effective_max_convs` : politique du connecteur (5 s) et créneaux de `/props`, relus avant d'entrer en file ; jamais d'erreur. */
export async function preparerServeur(engine: EngineRef): Promise<void> {
  if (!engine.profil.capacites.file) return;
  try {
    if (!engine.isBuiltin) {
      const t = performance.now() / 1000;
      const lue = politiques.get(engine.key);
      if (lue === undefined || t - lue.t >= LIMITS_TTL_S) {
        const [mm, mc] = await engineLimits(engine);
        const politique = { maxModels: positif(mm || 1), maxConcurrency: positif(mc || 1) };
        politiques.set(engine.key, { t, politique });
        const changee =
          lue !== undefined &&
          (lue.politique.maxModels !== politique.maxModels ||
            lue.politique.maxConcurrency !== politique.maxConcurrency);
        if (changee) ordonnanceur().setPolicy(engine.key, politique);
      }
    }
    const total = await useEngine(engine, () => getModelTotalSlots());
    if (!engine.isBuiltin && total > 0) totaux.set(engine.key, total);
  } catch (e) {
    log.debug(`[llm_queue] réglages de ${engine.key} non relus (${String(e)})`);
  }
}

/** `llm_scheduling_guard` : disjoncteur d'abord (échec immédiat même serveur figé), puis `fn` sous l'ordonnanceur du serveur visé. */
export async function avecLLM<T>(
  engine: EngineRef,
  model: string | null | undefined,
  priority: Priorite,
  signal: AbortSignal | undefined,
  fn: (slot: Slot) => Promise<T>,
  options: { outils?: boolean } = {},
): Promise<T> {
  if (engine.profil.capacites.file) {
    const q = ordonnanceur();
    q.disjoncteur(engine.key).allow(q.modeleEffectif(engine.key, model));
  }
  await preparerServeur(engine);
  return ordonnanceur().withLLM(model, priority, signal, fn, {
    moteur: moteurDeFile(engine),
    outils: options.outils,
  });
}

/** `MODEL_EXCLUSIVITY.acquire_for(modèle, "high")` du serveur : le modèle tenu pendant un chargement, sans créneau. */
export async function tenirModele(engine: EngineRef, model: string): Promise<Slot> {
  await preparerServeur(engine);
  return ordonnanceur().acquire({ server: engine.key, model, priority: "high", modeleSeul: true });
}

/** `snapshot_async()` du niveau 1 du serveur : modèle tenu et nombre de générations en cours. */
export function occupation(engine: EngineRef): { current_model: string | null; active_count: number } {
  return ordonnanceur().occupation(engine.key);
}

/** `get_queue_status_for_async` : état du widget pour ce modèle, inventaire du routeur relu (cache 3 s) ; hors file = prêt. */
export async function etatFile(
  model: string | null | undefined,
  engine: EngineRef = currentEngine(),
): Promise<Dict> {
  if (!engine.profil.capacites.file) return { kind: "ready", model: model || "" };
  inventaires.set(
    engine.key,
    await useEngine(engine, () => modelStatuses()).catch(() => new Map<string, string>()),
  );
  await preparerServeur(engine);
  return { ...ordonnanceur().status(engine.key, model) };
}

/** Connecteur modifié ou supprimé : réglages et inventaire oubliés, file libérée si plus rien ne la tient. */
export function oublierServeur(key: string): void {
  politiques.delete(key);
  totaux.delete(key);
  inventaires.delete(key);
  instance?.forget(key);
}

/** Port du moteur : une panne de transport vue hors du garde (complétion de l'éditeur) compte comme dans un tour. */
export function portDisjoncteur(): PortDisjoncteur {
  return {
    signalerPanneTransport: (engine, model) => {
      const q = ordonnanceur();
      q.disjoncteur(engine.key).recordFailure(q.modeleEffectif(engine.key, model));
    },
  };
}
