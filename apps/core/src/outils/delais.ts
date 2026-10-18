// SPDX-License-Identifier: MIT
/** apps/core/src/outils/delais.ts — délai d'attente d'un appel d'outil (`_tool_timeout_s` de llm_core/engine/tool_dispatch.py). */
import { veritePy } from "@elpis/commun";

import { CTX } from "../contexte/config-contexte";
import { QUEUE_MAX_S } from "../images/base";
import { getImageConfig } from "../images/config";
import { LLAMA_TOOL_TIMEOUT_S, TASK_CHILD_TIMEOUT_S } from "../llm/constantes";
import { flottantPy } from "../python";
import { toolPolicy } from "./categories";

const DEFAUTS: Readonly<Record<string, number>> = {
  execute_shell: 610,
  pw_wait: 330,
  desktop_shell: 610,
};

/** Surcharge `tools.<nom>.timeout_s` de context_config ; une lecture en panne vaut « pas de surcharge ». */
function surcharge(nom: string): number {
  try {
    return CTX.toolTimeoutS(nom);
  } catch {
    return 0;
  }
}

/** `meta.policy.timeout_s` déclaré par le serveur ; illisible ou absent : 0. */
function politique(nom: string): number {
  try {
    const pv = toolPolicy(nom)["timeout_s"];
    return veritePy(pv) ? flottantPy(pv) : 0;
  } catch {
    return 0;
  }
}

/** Surcharge de context_config, `task` et `generate_image` bornés par leur propre délai, politique du serveur, repli par nom, défaut global. */
export function toolTimeoutS(nom: string): number {
  const v = surcharge(nom);
  if (v > 0) return v;
  if (nom === "task") return TASK_CHILD_TIMEOUT_S + 60;
  if (nom === "generate_image") return QUEUE_MAX_S + getImageConfig().timeout_sec + 60;
  const p = politique(nom);
  if (p > 0) return p;
  return DEFAUTS[nom] ?? LLAMA_TOOL_TIMEOUT_S;
}
