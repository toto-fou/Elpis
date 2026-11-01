// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/preparation.ts — ce qu'un enfant reçoit à son départ : sources d'outils, messages (neuf ou repris), échantillonnage et réflexion fixés à son lancement. */
import { estDict, estErreurAnnulation, stripPy, strPy } from "@elpis/commun";
import { neutraliserMarqueursTour } from "@elpis/securite";

import { journal } from "../../../journal";
import { reflexionPossible } from "../../../llm/parametres";
import { buildSkillsIndexBlock, loadAgentPersona } from "../../../prompts/systeme";
import type { Dict } from "../../../python";
import type { AppelIntegre } from "../../catalogue";
import {
  blocHerite,
  consigneReprise,
  historiqueNavigateur,
  subagentRulesBlock,
  taskContextBlock,
} from "./brief";
import type { Cadre, PreparationEnfant } from "./enfant";
import { CUSTOM_DEFAULT_CATEGORIES, customDefaultCategories } from "./fiche-agent";
import { budgetReflexionEnfant, modeReflexionEffectif, typeReglable } from "./reglages";
import type { ModeReflexion } from "./reglages";
import { outilsRefusesEnfant } from "./roster";
import { todosDuChat } from "./tour";

const log = journal("outils.taches-agents");

/** Réflexion effective d'un enfant, fixée à son lancement : réglage voulu ET moteur qui l'honore ; jamais de chargement de modèle, tout échec la coupe. */
async function reflexionEnfant(mode: ModeReflexion, parent: boolean, model: string | null): Promise<boolean> {
  if (!(mode === "inherit" ? parent : mode === "on")) return false;
  try {
    return await reflexionPossible(model);
  } catch (e) {
    if (estErreurAnnulation(e)) throw e;
    return false;
  }
}

/** Réglages d'échantillonnage propres à la réflexion, retirés à un enfant qui ne réfléchit pas (le mode `off` du type ne garde rien de ceux de l'agent principal). */
const REGLAGES_REFLEXION = ["reasoning_effort", "thinking_budget_tokens", "preserve_reasoning"] as const;

/** Sources d'outils de l'enfant : le serveur local filtré par les catégories de son type, ses serveurs MCP du compte, sinon le socle. */
function configsMcpEnfant(c: Cadre): unknown[] {
  const { s, agentType } = c;
  const userMcp = c.t.o.userMcpConfigs;
  const configs: unknown[] = [];
  if (s.filterCategories === null || s.filterCategories.length)
    configs.push({
      type: "stdio",
      name: `task-${agentType}`,
      command: "DEFAULT_LOCAL_PYTHON",
      filter_categories: s.filterCategories,
    });
  if (s.mcpServerIds && s.mcpServerIds.length && userMcp && userMcp.length) {
    const voulus = new Set(s.mcpServerIds);
    configs.push(...userMcp.filter((m) => estDict(m) && voulus.has(strPy(m["id"]))));
  }
  if (!configs.length) {
    log.warn(
      `[task_tool] agent '${agentType}' : aucune source d'outils résolue (serveurs ${strPy(s.mcpServerIds)} introuvables) — repli sur le socle ${strPy([...CUSTOM_DEFAULT_CATEGORIES])}`,
    );
    configs.push({
      type: "stdio",
      name: `task-${agentType}`,
      command: "DEFAULT_LOCAL_PYTHON",
      filter_categories: customDefaultCategories(),
    });
  }
  return configs;
}

/** Tête système d'un enfant neuf : persona, règles communes, index des skills si son type les a. */
async function systemeEnfant(c: Cadre): Promise<string> {
  const { s, t } = c;
  const persona = s.personaText !== null ? s.personaText : await loadAgentPersona(s.personaStem);
  if (!persona) log.warn(`[task_tool] persona '${s.personaStem}' introuvable — enfant sans tête dédiée`);
  let systeme = stripPy(persona + "\n\n" + subagentRulesBlock());
  const userId = t.o.userId;
  if (userId !== null && userId !== undefined && (s.filterCategories ?? []).includes("skill")) {
    let index: string | null;
    try {
      index = await buildSkillsIndexBlock(userId);
    } catch (e) {
      if (estErreurAnnulation(e)) throw e;
      log.warn(`[task_tool] index skills non construit (${String(e)})`);
      index = null;
    }
    if (index) systeme = `${systeme}\n\n${index}`;
  }
  return systeme;
}

/** Messages de départ : historique repris et consigne de reprise, ou tête système et premier message (contexte de l'appel, brief). */
async function messagesEnfant(c: Cadre, appel: AppelIntegre | undefined): Promise<Dict[]> {
  const brief = neutraliserMarqueursTour(c.prompt);
  if (c.resumed !== null)
    return [
      ...((c.resumed["messages"] as Dict[]) ?? []),
      {
        role: "user",
        content:
          consigneReprise({
            budget: c.budget,
            timeoutS: c.travailS,
            navigateurFerme:
              c.aNavigateur &&
              c.sessionNavigateur === "isolated" &&
              historiqueNavigateur(c.resumed["messages"]),
          }) + brief,
      },
    ];
  const systeme = await systemeEnfant(c);
  const contexte = taskContextBlock(c.sa, {
    budget: c.budget,
    timeoutS: c.travailS,
    navigateur: c.aNavigateur,
    herite: c.lus.inherit ? blocHerite(appel?.parent?.() ?? null, await todosDuChat(c.t.o)) : null,
  });
  return [
    { role: "system", content: systeme },
    { role: "user", content: `${contexte}\n\n${brief}` },
  ];
}

/** Échantillonnage de l'enfant : budget d'outils de son type, réflexion fixée à son lancement (réglages de réflexion retirés sans elle). */
async function echantillonnageEnfant(
  c: Cadre,
  childId: string,
): Promise<{ sampling: Dict; reflexion: boolean }> {
  const o = c.t.o;
  const mode = modeReflexionEffectif(typeReglable(c.agentType), c.s.thinkingUser);
  const reflexion = await reflexionEnfant(mode, o.thinkingMode ?? false, o.model);
  const sampling: Dict = { ...(o.samplingOverride ?? {}), max_tool_iterations: c.budget };
  if (reflexion)
    sampling["thinking_budget_tokens"] = budgetReflexionEnfant(sampling["thinking_budget_tokens"]);
  else for (const cle of REGLAGES_REFLEXION) delete sampling[cle];
  log.info(
    `[task_tool] agent '${c.agentType}' ${childId} : réflexion ${reflexion ? "activée" : "coupée"} (réglage ${mode})`,
  );
  return { sampling, reflexion };
}

/** Tout ce que l'enfant `childId` reçoit à sa création. */
export async function preparerEnfant(
  c: Cadre,
  childId: string,
  appel: AppelIntegre | undefined,
): Promise<PreparationEnfant> {
  const childMcpConfigs = configsMcpEnfant(c);
  const allowed = c.s.allowedToolNames;
  const childAllowed = allowed && allowed.size ? new Set(allowed) : null;
  const childDeny = outilsRefusesEnfant(c.s);
  const childMessages = await messagesEnfant(c, appel);
  const { sampling, reflexion } = await echantillonnageEnfant(c, childId);
  return {
    childId,
    childMcpConfigs,
    childAllowed,
    childDeny,
    childMessages,
    childSampling: sampling,
    reflexion,
  };
}
