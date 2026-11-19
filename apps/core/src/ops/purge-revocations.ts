// SPDX-License-Identifier: MIT
/** apps/core/src/ops/purge-revocations.ts — purge périodique dans main de `revoked_sessions` (une ligne dont la session a expiré ne sert plus) et des rattachements préparés périmés. */
import { purgerRevocations } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { dormirMs } from "@elpis/commun";

import type { CycleDeVie } from "../cycle";
import { purgerFluxPerimes } from "../identite/oidc/flux";
import type { Journal } from "../journal";
import { purgerRattachementsPerimes } from "../identite/rattachement";
import type { ModeApp } from "../mode";

export const INTERVALLE_PURGE_REVOCATIONS_MS = 3_600_000;
export const MARGE_PURGE_REVOCATIONS_S = 3_600;

export interface OptionsPurgeRevocations {
  readonly intervalleMs?: number;
  readonly dormir?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Une passe : supprime les révocations dont l'échéance est dépassée de la marge, puis les flux et sessions de connexion externe périmés ; une erreur est journalisée, jamais relancée. */
export async function purgerUnePasse(dep: DependancesAuth, journal: Journal): Promise<number> {
  try {
    const maintenant = dep.maintenant ? dep.maintenant() : Date.now() / 1000;
    const n = await purgerRevocations(dep.base, maintenant, MARGE_PURGE_REVOCATIONS_S);
    if (n > 0) journal.info(`${n} révocation(s) de session périmée(s) purgée(s)`);
    await purgerRattachementsPerimes(dep.base, maintenant);
    const flux = await purgerFluxPerimes(dep.base, maintenant);
    if (flux > 0) journal.info(`${flux} flux ou session de connexion externe périmé(s) purgé(s)`);
    return n;
  } catch (e) {
    journal.warn({ err: e }, "purge des révocations de session en échec");
    return 0;
  }
}

/** Purge au démarrage de main puis toutes les heures, arrêtée par le signal d'arrêt du process. */
export function brancherPurgeRevocations(
  mode: ModeApp,
  cycle: CycleDeVie,
  dep: DependancesAuth,
  journal: Journal,
  options: OptionsPurgeRevocations = {},
): void {
  if (mode !== "main") return;
  const dormir = options.dormir ?? dormirMs;
  const intervalle = options.intervalleMs ?? INTERVALLE_PURGE_REVOCATIONS_MS;
  cycle.auDemarrage(
    "purge des révocations de session",
    async () => {
      const signal = cycle.signalArret;
      while (!signal.aborted) {
        await purgerUnePasse(dep, journal);
        try {
          await dormir(intervalle, signal);
        } catch {
          return;
        }
      }
    },
    { modes: ["main"], arrierePlan: true },
  );
}
