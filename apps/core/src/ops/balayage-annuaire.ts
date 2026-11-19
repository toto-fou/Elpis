// SPDX-License-Identifier: MIT
/** apps/core/src/ops/balayage-annuaire.ts — balayage périodique des annuaires actifs dans main : première passe 2 minutes après le démarrage, puis toutes les 15 minutes, arrêté par le signal d'arrêt du process. */
import { dormirMs } from "@elpis/commun";

import type { CycleDeVie } from "../cycle";
import { alerterSiPerime, balayerAnnuaire } from "../identite/annuaire/balayage";
import type { DependancesBalayage } from "../identite/annuaire/balayage";
import { annuairesActifs } from "../identite/annuaire/connexion";
import type { ModeApp } from "../mode";

export const PREMIERE_PASSE_MS = 120_000;
export const INTERVALLE_BALAYAGE_MS = 900_000;
export const REVERIFICATION_MS = 180_000;

export interface OptionsBalayageAnnuaire {
  readonly premiereMs?: number;
  readonly intervalleMs?: number;
  readonly reverificationMs?: number;
  readonly dormir?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Une passe sur chaque annuaire actif (ou sur ceux de `seulement`), l'un après l'autre ; une erreur est journalisée et n'arrête ni les suivants ni le cycle ; `reverifier` reçoit chaque annuaire dont la passe a noté une observation nouvelle (jamais une observation redatée). */
export async function balayerLesAnnuaires(
  dep: DependancesBalayage,
  intervalleMs: number = INTERVALLE_BALAYAGE_MS,
  options: { readonly seulement?: ReadonlySet<string>; readonly reverifier?: (id: string) => void } = {},
): Promise<void> {
  try {
    for (const f of await annuairesActifs(dep)) {
      if (options.seulement !== undefined && !options.seulement.has(f.id)) continue;
      try {
        const issue = await balayerAnnuaire(dep, f, { intervalleMs });
        if (issue.type === "occupe")
          dep.journal.info(`annuaire ${f.id} : passe ignorée, une autre est en cours`);
        if (issue.type === "bilan" && (issue.nouvelles ?? 0) > 0) options.reverifier?.(f.id);
        await alerterSiPerime(dep, f, intervalleMs);
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
      const intervalle = options.intervalleMs ?? INTERVALLE_BALAYAGE_MS;
      const rapide = options.reverificationMs ?? REVERIFICATION_MS;
      let horloge = 0;
      let prochaine = options.premiereMs ?? PREMIERE_PASSE_MS;
      const rapides = new Map<string, number>();
      const programmer = (id: string): void => void (rapides.has(id) || rapides.set(id, horloge + rapide));
      while (!signal.aborted) {
        const plusTot = Math.min(prochaine, ...rapides.values());
        const attente = Math.max(0, plusTot - horloge);
        try {
          await dormir(attente, signal);
        } catch {
          return;
        }
        horloge += attente;
        if (horloge >= prochaine) {
          prochaine = horloge + intervalle;
          rapides.clear();
          await balayerLesAnnuaires(dep, intervalle, { reverifier: programmer });
        } else {
          const dus = new Set([...rapides].filter(([, t]) => t <= horloge).map(([id]) => id));
          for (const id of dus) rapides.delete(id);
          await balayerLesAnnuaires(dep, intervalle, { seulement: dus, reverifier: programmer });
        }
      }
    },
    { modes: ["main"], arrierePlan: true },
  );
}
