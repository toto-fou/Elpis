// SPDX-License-Identifier: MIT
/** apps/core/src/ops/balayage-annuaire.ts — balayage périodique des annuaires actifs dans main : première passe 2 minutes après le démarrage, puis toutes les 15 minutes, arrêté par le signal d'arrêt du process. */
import { dormirMs } from "@elpis/commun";

import type { CycleDeVie } from "../cycle";
import { balayerAnnuaire } from "../identite/annuaire/balayage";
import type { DependancesBalayage } from "../identite/annuaire/balayage";
import { annuairesActifs } from "../identite/annuaire/connexion";
import type { ModeApp } from "../mode";

export const PREMIERE_PASSE_MS = 120_000;
export const INTERVALLE_BALAYAGE_MS = 900_000;

export interface OptionsBalayageAnnuaire {
  readonly premiereMs?: number;
  readonly intervalleMs?: number;
  readonly dormir?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Une passe sur chaque annuaire actif, l'un après l'autre ; une erreur est journalisée et n'arrête ni les suivants ni le cycle. */
export async function balayerLesAnnuaires(dep: DependancesBalayage): Promise<void> {
  try {
    for (const f of await annuairesActifs(dep)) {
      try {
        await balayerAnnuaire(dep, f);
      } catch (e) {
        dep.journal.warn({ err: e }, `balayage de l'annuaire ${f.id} en échec`);
      }
    }
  } catch (e) {
    dep.journal.warn({ err: e }, "balayage des annuaires en échec");
  }
}

/** Balayage planifié dans main seulement ; chaque passe prend le verrou de son annuaire, donc deux process ne passent jamais ensemble. */
export function brancherBalayageAnnuaire(
  mode: ModeApp,
  cycle: CycleDeVie,
  dep: DependancesBalayage,
  options: OptionsBalayageAnnuaire = {},
): void {
  if (mode !== "main") return;
  const dormir = options.dormir ?? dormirMs;
  cycle.auDemarrage(
    "balayage des annuaires",
    async () => {
      const signal = cycle.signalArret;
      let attente = options.premiereMs ?? PREMIERE_PASSE_MS;
      while (!signal.aborted) {
        try {
          await dormir(attente, signal);
        } catch {
          return;
        }
        await balayerLesAnnuaires(dep);
        attente = options.intervalleMs ?? INTERVALLE_BALAYAGE_MS;
      }
    },
    { modes: ["main"], arrierePlan: true },
  );
}
