// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/entretien.ts — entretien des bacs servis par cet hôte (toolhost/app.py `_sweep_loop`) : tmp d'envoi abandonnés retirés toutes les 6 h, sans jamais bloquer. */
import { balayerPartsOrphelines } from "@elpis/bac";
import { dormirMs } from "@elpis/commun";

import type { Journal } from "../journal";

export const PERIODE_BALAYAGE_MS = 6 * 3600 * 1000;

/** `_sweep_loop` : un passage au démarrage puis toutes les 6 h, jusqu'à l'arrêt. */
export async function boucleBalayage(
  journal: Journal,
  arret: AbortSignal,
  balayer: () => Promise<number> = () => balayerPartsOrphelines(),
): Promise<void> {
  while (!arret.aborted) {
    try {
      const n = await balayer();
      if (n) journal.info(`[toolhost] ${n} tmp d'upload abandonnés supprimés`);
    } catch (e) {
      journal.debug(
        `[toolhost] balayage des tmp d'upload échoué : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      await dormirMs(PERIODE_BALAYAGE_MS, arret);
    } catch {
      return;
    }
  }
}
