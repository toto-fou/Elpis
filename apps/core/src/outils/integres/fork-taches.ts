// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/fork-taches.ts — `task(context="fork")` : garde-fous et messages de l'enfant, qui reprend le préfixe exact du dernier appel du parent puis le message assistant porteur de l'appel. */
import { estDict, intPy, strPy } from "@elpis/commun";

import { compactionGate, resolveThreshold } from "../../contexte/porte-compaction";
import { TASK_FORK_MAX_CONTEXT_RATIO } from "../../llm/constantes";
import type { Dict } from "../../python";
import type { ContexteParent } from "../catalogue";
import { categorize } from "../categories";

export const FIX_FORK_INDISPONIBLE = "use context: fresh with a complete brief";

/** Résultat de l'appel `task` qui a lancé l'enfant : ce contexte est désormais le sien. */
export const RESULTAT_FORK =
  "[harness] Sub-agent started: from here on, this conversation is the sub-agent's context. Its role, rules and mission are in the last message.";

/** Résultat des autres appels du même lot : exécutés par le parent. */
export const RESULTAT_FRERE = "[harness] Run by the parent agent: its result is not visible in this context.";

/** Identifiants des appels du message assistant, dans l'ordre. */
export function idsAppels(assistant: Dict): string[] {
  const appels = assistant["tool_calls"];
  return Array.isArray(appels) ? appels.filter(estDict).map((c) => strPy(c["id"])) : [];
}

/** Raison pour laquelle l'enfant ne peut pas reprendre le contexte du parent, `null` si le fork est possible. */
export function raisonForkImpossible(parent: ContexteParent, callId: string | null): string | null {
  if (parent.sousAgent) return "a sub-agent cannot fork";
  if (!parent.natif) return "the parent called task through the text channel, not as a native tool call";
  if (!parent.envoye.length || parent.assistant === null) return "the parent's last request is not available";
  if (callId === null || !idsAppels(parent.assistant).includes(callId))
    return "this call is not in the parent's last message";
  if (parent.fenetre <= 0) return null;
  const porte = compactionGate(parent.fenetre, {
    thinkingMode: parent.thinkingMode,
    threshold: parent.seuilCompaction ?? resolveThreshold(),
  });
  if (porte.triggerTokens <= 0) return null;
  const limite = intPy(porte.triggerTokens * TASK_FORK_MAX_CONTEXT_RATIO);
  return parent.jetons > limite
    ? `the parent's context (${parent.jetons} tokens) is above ${Math.round(TASK_FORK_MAX_CONTEXT_RATIO * 100)}% of its compaction threshold (${porte.triggerTokens} tokens)`
    : null;
}

/** Messages de l'enfant : dernier appel du parent, assistant porteur de `task`, un résultat par appel, puis la consigne en message `user` (jamais dans un résultat d'outil : l'ancre de compaction et l'élagage ne regardent que les `user`). */
export function messagesFork(parent: ContexteParent, callId: string, consigne: string): Dict[] {
  const assistant = parent.assistant ?? {};
  const resultats: Dict[] = idsAppels(assistant).map((id) => ({
    role: "tool",
    tool_call_id: id,
    content: id === callId ? RESULTAT_FORK : RESULTAT_FRERE,
  }));
  return [...parent.envoye, assistant, ...resultats, { role: "user", content: consigne }];
}

/** Raison pour laquelle les outils permis ne suffisent pas au type (ensemble vide, ou une de ses catégories sans outil), `null` si le fork est utile ; en lecture seule, une catégorie retirée à dessein mais présente chez le parent ne compte pas. */
export function raisonPerimetreInsuffisant(
  permis: ReadonlySet<string>,
  categories: readonly string[] | null,
  o: { lectureSeule: boolean; catalogue: Iterable<string> },
): string | null {
  if (permis.size === 0) return "none of the parent's tools is available to this agent type";
  const catalogue = [...o.catalogue];
  const contient = (noms: Iterable<string>, categorie: string): boolean =>
    [...noms].some((nom) => categorize(nom) === categorie);
  for (const categorie of categories ?? []) {
    if (contient(permis, categorie) || (o.lectureSeule && contient(catalogue, categorie))) continue;
    return `the parent has no '${categorie}' tool this agent type could use`;
  }
  return null;
}
