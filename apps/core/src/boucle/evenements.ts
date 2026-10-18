// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/evenements.ts — émission d'un événement du flux par la boucle (`_emit`) ; registre dans @elpis/contracts. */
import { estErreurAnnulation } from "@elpis/commun";

import type { Dict } from "../python";

export type Evenement = Dict;
export type SurEvenement = ((e: Evenement) => void | Promise<void>) | null | undefined;

/** L'événement part au flux ; une panne du consommateur est tue, une annulation remonte. */
export async function emit(onEvent: SurEvenement, ev: Evenement): Promise<void> {
  if (!onEvent) return;
  try {
    await onEvent(ev);
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
  }
}
