// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/reconciliation-raisonnement.ts — règle unique de fin de flux : une réponse piégée dans le raisonnement remonte dans la bulle, jamais un raisonnement tronqué (pur). */
import { stripPy } from "@elpis/commun";

import { longueurPy } from "../python";

/** En dessous, c'est probablement du vrai raisonnement. */
const MIN_THINKING_FOR_APPEND = 200;
/** Raisonnement au moins 3 fois plus long que la réponse : la réponse est une intro creuse. */
const RATIO_THINKING_OVER_CONTENT = 3;

export interface OptionsReconciliation {
  inThink?: boolean;
  hadToolCalls?: boolean;
  finish?: string | null;
}

/** `[thinking, content]` réconciliés (strippés) : promotion si la réponse est vide, ajout si une intro creuse précède un `<think>` non fermé, sinon inchangés ; rien sur `finish == "length"`. */
export function reconcileThinkingContent(
  thinkingEntree: string | null | undefined,
  contentEntree: string | null | undefined,
  o: OptionsReconciliation = {},
): [string, string] {
  const thinking = stripPy(thinkingEntree || "");
  const content = stripPy(contentEntree || "");
  const finish = o.finish ?? "";
  if (thinking && !content && !o.hadToolCalls) {
    if (finish === "length") return [thinking, content];
    return ["", thinking];
  }
  if (
    content &&
    thinking &&
    o.inThink &&
    !o.hadToolCalls &&
    finish !== "length" &&
    longueurPy(thinking) >= MIN_THINKING_FOR_APPEND &&
    longueurPy(thinking) >= RATIO_THINKING_OVER_CONTENT * longueurPy(content)
  )
    return [thinking, content + "\n\n" + thinking];
  return [thinking, content];
}
