// SPDX-License-Identifier: MIT
/** apps/core/src/executions/branchements.ts — exécutions posées au démarrage : base des lignes `runs`, exécution courante vue par la boucle et les fournisseurs, portée des sous-agents (parent : l'exécution englobante ; `parentId` du port reste à l'usage, B1-32). */
import type { Executeur } from "@elpis/db";

import { installerExecutionCourante, installerPorteeExecution } from "../boucle/ports";
import type { PortExecutionCourante } from "../boucle/ports";
import { installerExecutions } from "../llm/ports";
import { currentRun, installerBaseExecutions, runScope } from "./registre";

/** `current_run()` vu par la boucle : attente, fichiers modifiés et appels d'outils de l'exécution courante. */
export function executionCouranteDuProcess(): PortExecutionCourante | null {
  const e = currentRun();
  return e === null
    ? null
    : {
        id: e.id,
        ajouterAttente: (ms) => e.addWait(ms),
        ajouterFichiers: (fichiers) => e.addFiles(fichiers),
        ajouterAppelOutil: (categorie, statut) => e.addToolCall(categorie, statut),
      };
}

export function brancherExecutions(base: Executeur): void {
  installerBaseExecutions(base);
  installerExecutionCourante(executionCouranteDuProcess);
  installerExecutions({ ajouterAppelLlm: (timings) => currentRun()?.addLlmCall(timings) });
  installerPorteeExecution((p, fn) =>
    runScope(p.genre, { userId: p.userId, chatId: p.chatId, model: p.model, engine: p.engine }, () => fn()),
  );
}
