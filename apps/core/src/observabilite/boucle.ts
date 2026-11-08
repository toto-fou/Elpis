// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/boucle.ts — latence de la boucle d'événements (monitorEventLoopDelay) : p99 et max de la dernière minute complète, lus sans remise à zéro par l'échantillonneur et Prometheus. */
import { monitorEventLoopDelay } from "node:perf_hooks";

export interface LatenceBoucle {
  p99_ms: number;
  max_ms: number;
}

interface Suivi {
  h: ReturnType<typeof monitorEventLoopDelay>;
  minuterie: NodeJS.Timeout;
  dernier: LatenceBoucle | null;
}

let suivi: Suivi | null = null;

/** Démarre la mesure (un histogramme pour le process ; 200 ms = 5 réveils/s, tout blocage plus long est vu ; l'histogramme compte l'intervalle entier, la résolution est retranchée) ; sans effet si elle tourne déjà. */
export function suivreBoucle(fenetreMs = 60_000, resolutionMs = 200): void {
  if (suivi) return;
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  const s: Suivi = {
    h,
    dernier: null,
    minuterie: setInterval(() => {
      const retard = (ns: number): number => Math.max(0, ns / 1e6 - resolutionMs);
      if (h.count) s.dernier = { p99_ms: retard(h.percentile(99)), max_ms: retard(h.max) };
      h.reset();
    }, fenetreMs),
  };
  s.minuterie.unref();
  suivi = s;
}

/** Mesure de la dernière fenêtre complète ; `null` avant la première ou sans suivi. */
export function latenceBoucle(): LatenceBoucle | null {
  return suivi?.dernier ?? null;
}

export function arreterSuiviBoucle(): void {
  if (!suivi) return;
  clearInterval(suivi.minuterie);
  suivi.h.disable();
  suivi = null;
}
