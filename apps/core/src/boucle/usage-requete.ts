// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/usage-requete.ts — usage d'une requête coupée au moteur (échéance, délai dur, annulation) : seulement ce que le moteur a rapporté (usage, timings par jeton de llama.cpp, progression du préremplissage), jamais d'estimation. */
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

/** Ce que le flux a reçu d'une requête coupée (`OptionsFlux.surFluxCoupe`) : usage, `timings` et `prompt_progress` du dernier morceau. */
export interface FluxCoupe {
  readonly usage: Dict;
  readonly timings: Dict;
  readonly progression: Dict;
}

/** Usage d'une requête rapporté par le moteur : entrée (part servie par le cache comprise), sortie (réflexion comprise), part en cache. */
export interface UsageRequete {
  readonly entree: number;
  readonly sortie: number;
  readonly cache: number;
}

/** Usage cumulé d'un run (`OptionsRun.surUsage`) : requêtes abouties et requêtes coupées rapportées par le moteur, réflexion seulement si le moteur la compte (zéro sinon). */
export interface UsageRun extends UsageRequete {
  readonly reflexion: number;
}

function entier(d: unknown, k: string): number {
  const v = estDict(d) ? d[k] : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** Usage d'une requête coupée tel que le moteur l'a rapporté : son usage s'il est arrivé, sinon les `timings` par jeton (llama.cpp), sinon la progression du préremplissage ; rien rapporté : zéro. */
export function usageRequeteCoupee(flux: FluxCoupe | null): UsageRequete {
  const u = flux?.usage;
  const entreeRapportee = entier(u, "prompt_tokens");
  if (entreeRapportee > 0) {
    const detail = estDict(u) ? u["prompt_tokens_details"] : null;
    const cache = entier(u, "cache_read_input_tokens") || entier(detail, "cached_tokens");
    return {
      entree: entreeRapportee,
      sortie: entier(u, "completion_tokens"),
      cache: Math.min(entreeRapportee, cache),
    };
  }
  const t = flux?.timings;
  const [prefill, cacheKv, generes] = [entier(t, "prompt_n"), entier(t, "cache_n"), entier(t, "predicted_n")];
  if (prefill + cacheKv + generes > 0) return { entree: prefill + cacheKv, sortie: generes, cache: cacheKv };
  const traites = entier(flux?.progression, "processed");
  return {
    entree: traites,
    sortie: 0,
    cache: Math.min(traites, entier(flux?.progression, "cache")),
  };
}
