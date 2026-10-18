// SPDX-License-Identifier: MIT
/** apps/core/src/llm/cycle-modeles.ts — charger, décharger, attendre l'inactivité des slots du llama-server (caches de modèle vidés au changement). */
import { stripPy, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { lire } from "../python";
import type { Dict } from "../python";
import { getPy } from "./dict-py";
import { dormir, llamaGet, llamaGetText, llamaPost, monotonic } from "./llama-http";
import { invaliderAuChangementDeModele } from "./modeles";
import { parsePrometheusMetrics } from "./sante";

const log = journal("model_lifecycle");

function egalZero(v: unknown): boolean {
  return v === 0 || v === false;
}

function statutDans(r: Dict, codes: readonly number[]): boolean {
  const st = lire(r, "_status");
  return typeof st === "number" && codes.includes(st);
}

/** `POST /models/load` ; succès → caches de modèle vidés (n_ctx, slots, paramètres, tokenisation). */
export async function loadLlmModel(modelPath: string): Promise<Dict> {
  if (!stripPy(modelPath)) return { ok: false, error: "Chemin requis." };
  const r = await llamaPost("/models/load", { model: stripPy(modelPath) }, 180.0);
  if (statutDans(r, [200, 201]) && !veritePy(lire(r, "error"))) {
    invaliderAuChangementDeModele();
    return { ok: true, method: "models_load", detail: r };
  }
  return {
    ok: false,
    error: getPy(r, "error", "Endpoint non disponible."),
    hint: "Assurez-vous que llama-server est lancé en mode routeur (sans spécifier de modèle initial).",
  };
}

/** Sondes consécutives sans réponse au-delà desquelles on cesse d'attendre (un moteur muet ne traite rien). */
export const SLOTS_PROBE_MAX_UNREACHABLE = 3;

/** `true` = plus de requête en vol ; `false` = délai dépassé ou moteur muet (l'appelant force alors l'opération). */
export async function waitForSlotsIdle(
  maxWaitSec = 300.0,
  pollInterval = 2.0,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const echeance = monotonic() + maxWaitSec;
  let muet = 0;
  while (monotonic() < echeance) {
    let joignable = false;
    try {
      const health = await llamaGet("/health", 3.0);
      if (health !== null) {
        joignable = true;
        if (egalZero(getPy(health, "slots_processing", 0))) return true;
        await dormir(pollInterval, options.signal);
        muet = 0;
        continue;
      }
    } catch (e) {
      if (options.signal?.aborted) throw e;
    }
    try {
      const texte = await llamaGetText("/metrics", 3.0);
      if (texte) {
        joignable = true;
        const pm = parsePrometheusMetrics(texte);
        if (egalZero(pm["llamacpp_requests_processing"] ?? 0)) return true;
      }
    } catch (e) {
      log.debug(`/metrics illisible (${String(e)}) : sonde muette si rien d'autre n'a répondu`);
    }
    if (joignable) muet = 0;
    else {
      muet += 1;
      if (muet >= SLOTS_PROBE_MAX_UNREACHABLE) {
        log.warn(
          `llama-server muet sur ${muet} sondes — on cesse d'attendre l'inactivité des slots ` +
            "(il ne traite rien de toute façon)",
        );
        return false;
      }
    }
    await dormir(pollInterval, options.signal);
  }
  return false;
}

/** `POST /models/unload` ; succès → mêmes caches vidés qu'au chargement. */
export async function unloadLlmModel(modelId: string): Promise<Dict> {
  if (!stripPy(modelId)) return { ok: false, error: "model_id requis." };
  const r = await llamaPost("/models/unload", { model: stripPy(modelId) }, 30.0);
  if (statutDans(r, [200, 204])) {
    invaliderAuChangementDeModele();
    return { ok: true, method: "models_unload" };
  }
  return {
    ok: false,
    error: getPy(r, "error", "Non supporté par ce build ou modèle introuvable."),
    hint: "Vérifiez que llama-server est en mode routeur et que le modèle est bien chargé.",
  };
}
