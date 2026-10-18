// SPDX-License-Identifier: MIT
/** apps/core/src/tour/branchements.ts — tour de chat posé au démarrage : complétion qui raisonne, vue par la boucle (« Répondre maintenant »). */
import { installerControleRaisonnement } from "../boucle/ports";
import { controleRaisonnementDuProcess } from "./etat";

export function brancherTour(): void {
  installerControleRaisonnement(controleRaisonnementDuProcess);
}
