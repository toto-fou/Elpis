// SPDX-License-Identifier: MIT
/** apps/core/src/outils/traits.ts — ce qu'un outil fait (sériel, rejouable, lecture seule, mutant), décidé en un seul endroit. */
import { stripPy, veritePy } from "@elpis/commun";

import { LLAMA_TOOL_SERIAL_PREFIXES } from "../llm/constantes";
import { lowerPy } from "../python";
import { extractAnnotations, toolInfo, toolPolicy } from "./categories";

export interface ToolTraits {
  readonly serial: boolean;
  readonly replaySafe: boolean;
  readonly readOnly: boolean;
  readonly mutates: boolean;
}

/** Parallélisables, mais un rejeu relancerait l'action (commande, clic…). */
const REPLAY_UNSAFE_PREFIXES = ["execute_shell", "shell_", "run_", "desktop_", "pw_", "browser_"] as const;

function commencePar(nom: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => nom.startsWith(p));
}

/** Traits de `name` : l'objet de `list_tools()` fait foi s'il est fourni, sinon le registre ; non déclaré = replis prudents par nom. */
export function toolTraits(name: string | null | undefined, tool: unknown = null): ToolTraits {
  const nom = stripPy(name || "");
  let pol: Record<string, unknown>;
  let ann: Record<string, unknown>;
  try {
    pol = toolPolicy(nom);
    ann = tool !== null && tool !== undefined ? extractAnnotations(tool) : toolInfo(nom);
  } catch {
    pol = {};
    ann = {};
  }
  const ro = Object.hasOwn(ann, "read_only") ? ann["read_only"] : null;
  const prefixe = commencePar(nom, LLAMA_TOOL_SERIAL_PREFIXES);
  const serial = Object.hasOwn(pol, "serial") ? veritePy(pol["serial"]) : prefixe;
  const replaySafe = Object.hasOwn(pol, "replay_safe")
    ? veritePy(pol["replay_safe"])
    : nom !== "" && !serial && !prefixe && !commencePar(nom, REPLAY_UNSAFE_PREFIXES);
  return Object.freeze({
    serial,
    replaySafe,
    readOnly: veritePy(ro),
    mutates:
      ro !== null && ro !== undefined ? !veritePy(ro) : commencePar(lowerPy(nom), LLAMA_TOOL_SERIAL_PREFIXES),
  });
}
