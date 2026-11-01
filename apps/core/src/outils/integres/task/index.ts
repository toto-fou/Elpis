// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/index.ts — outils intégrés des sous-agents (`task`, `task_status`, `task_wait`, `task_send`) construits par tour, et leur API publique pour le reste du core et ses tests. */
import type { Dict } from "../../../python";
import type { AppelIntegre, OutilIntegre } from "../../catalogue";
import { attendreTache, envoyerTache, statutTache } from "./canal";
import {
  buildDefinition,
  DEFINITION_TASK_SEND,
  DEFINITION_TASK_STATUS,
  DEFINITION_TASK_WAIT,
} from "./definition";
import { handleTask } from "./lancement";
import { agentsRoster } from "./roster";
import { creerTour } from "./tour";
import type { OptionsTache } from "./tour";

export { CONSIGNE_CLOTURE, blocHerite, subagentRulesBlock, taskContextBlock } from "./brief";
export { LEGENDE_TASK_META, TASK_SEND_MAX, buildDefinition } from "./definition";
export { preview } from "./evenements";
export { customDefaultCategories, freeAgentName, normMaxIters } from "./fiche-agent";
export { annulerEnFond, enfantsEnFondActifs } from "./fond";
export { cancelChild, marquerDernier } from "./registre";
export { tachesSimultanees } from "./tour";
export { resumeLookup } from "./reprise";
export { AGENTS, agentsRoster, hasActiveAgents, validateCustomAgents } from "./roster";
export type { AgentSpec } from "./roster";
export type { OptionsTache } from "./tour";

/** `{task, task_status, task_wait, task_send}` construits PAR TOUR (contexte du parent capturé) ; `{}` si aucun agent n'est actif. Un sous-agent ne reçoit jamais `task`. */
export function buildTaskBuiltinTool(o: OptionsTache): Record<string, OutilIntegre> {
  const agents = agentsRoster(o.customAgents);
  if (!agents.size) return {};
  const t = creerTour(o, agents);
  return {
    task: {
      definition: buildDefinition(agents),
      handler: (args: Dict, appel?: AppelIntegre) => handleTask(t, args, appel),
    },
    task_status: {
      definition: { ...DEFINITION_TASK_STATUS },
      handler: (args: Dict, appel?: AppelIntegre) => statutTache(o, args, appel),
    },
    task_wait: {
      definition: { ...DEFINITION_TASK_WAIT },
      handler: (args: Dict, appel?: AppelIntegre) => attendreTache(o, args, appel),
    },
    task_send: { definition: { ...DEFINITION_TASK_SEND }, handler: (args: Dict) => envoyerTache(o, args) },
  };
}
