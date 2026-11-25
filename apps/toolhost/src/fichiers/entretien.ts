// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/entretien.ts — entretien des bacs servis par cet hôte (toolhost/app.py `_sweep_loop`) : tmp d'envoi abandonnés, verrous d'écriture périmés et cache des aperçus Office élagués toutes les 6 h, bacs lancés avec d'anciennes options arrêtés au démarrage, sans jamais bloquer. */
import { arreterBacsPerimes, balayerPartsOrphelines } from "@elpis/bac";
import { dormirMs } from "@elpis/commun";
import { locksBase } from "@elpis/fichiers";
import { balayerVerrousPerimes } from "@elpis/verrous";

import type { Journal } from "../journal";
import { elaguerCacheOffice } from "../office/elagage";

export const PERIODE_BALAYAGE_MS = 6 * 3600 * 1000;

/** Un balayage du passage : ce qu'il retire (pour le journal) et la fonction qui le fait. */
export interface Balayage {
  readonly quoi: string;
  readonly balayer: () => Promise<number>;
}

/** Balayages du dossier des bacs, que cet hôte est seul à écrire. */
export const BALAYAGES: readonly Balayage[] = [
  { quoi: "tmp d'upload abandonnés", balayer: () => balayerPartsOrphelines() },
  {
    quoi: "verrous d'écriture périmés",
    balayer: () => {
      const base = locksBase();
      return balayerVerrousPerimes(base === null ? [] : [base]);
    },
  },
  {
    quoi: "entrées du cache d'aperçus Office",
    balayer: async () => {
      const r = await elaguerCacheOffice();
      return r.removed + r.locks;
    },
  },
];

/** `_sweep_loop` : un passage au démarrage puis toutes les 6 h, jusqu'à l'arrêt ; une panne d'un balayage n'arrête ni les autres ni la boucle. */
export async function boucleBalayage(
  journal: Journal,
  arret: AbortSignal,
  balayages: readonly Balayage[] = BALAYAGES,
): Promise<void> {
  while (!arret.aborted) {
    for (const b of balayages) {
      try {
        const n = await b.balayer();
        if (n) journal.info(`[toolhost] ${n} ${b.quoi} supprimés`);
      } catch (e) {
        journal.debug(
          `[toolhost] balayage des ${b.quoi} échoué : ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    try {
      await dormirMs(PERIODE_BALAYAGE_MS, arret);
    } catch {
      return;
    }
  }
}

/** Au démarrage : les bacs lancés avec d'anciennes options qui gardent la main sur leur filtre réseau sont arrêtés ; un échec est journalisé, jamais levé. */
export async function arreterPerimesAuDemarrage(
  journal: Journal,
  arreter: () => Promise<string[]> = () => arreterBacsPerimes(),
): Promise<void> {
  try {
    const noms = await arreter();
    if (noms.length)
      journal.info(`[toolhost] ${noms.length} bac(s) à relancer arrêté(s) : ${noms.join(", ")}`);
  } catch (e) {
    journal.warn(
      `[toolhost] arrêt des bacs à relancer échoué : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
