// SPDX-License-Identifier: MIT
/** apps/core/src/coffre/heritage.ts — reprise au démarrage des anciens identifiants AX (clair) dans le coffre chiffré, marqués « à confirmer ». */
import type { Base } from "@elpis/db";
import { importerIdentifiantsAx } from "@elpis/db";
import { encrypt } from "@elpis/securite";

import type { Journal } from "../journal";

/** Un échec (clé de chiffrement absente) est journalisé et retenté au démarrage suivant, jamais bloquant. */
export async function reprendreIdentifiantsAx(base: Base, journal: Journal): Promise<void> {
  try {
    const r = await importerIdentifiantsAx(base, encrypt);
    if (r.importes || r.ignores)
      journal.info(
        `[coffre] ${r.importes} identifiant(s) AX repris dans le coffre (à confirmer), ${r.ignores} sans compte ignoré(s)`,
      );
  } catch (e) {
    journal.warn({ err: e }, "[coffre] reprise des anciens identifiants AX impossible");
  }
}
