// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/agent-save.ts — outil `agent_save` du tour : enregistre un agent personnel toujours désactivé, par la validation partagée des réglages (`custom_agents`). */
import { mergeUserSettings } from "@elpis/auth";
import { estDict, estErreurPython, pyJsonDumps, stripPy } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { err, ok } from "@elpis/outils-mcp";

import { longueurPy } from "../../python";
import type { Dict } from "../../python";
import type { OutilIntegre } from "../catalogue";
import { MODES_REFLEXION } from "./task/reglages";
import { categoriesRoutine } from "./routine";
import {
  AGENT_NAME_RE,
  CUSTOM_AGENTS_MAX,
  CUSTOM_CATS_MAX,
  CUSTOM_ITERS_MAX,
  CUSTOM_MCP_MAX,
  CUSTOM_PROMPT_MAX,
  RESERVED_AGENT_NAMES,
} from "./task/fiche-agent";
import { AGENTS, validateCustomAgents } from "./task/roster";

export const TOOL_NAME = "agent_save";

const CHAMPS = [
  "name",
  "description",
  "prompt",
  "tool_categories",
  "mcp_server_ids",
  "read_only",
  "max_iters",
  "thinking",
  "replace",
];

const NOTE = "Agent saved DISABLED: tell the user to review it and switch it on from the Agents page.";
const NOTE_REMPLACE =
  "Former card replaced entirely: the agent is disabled and its web session is back to private; " +
  "tell the user to review it, switch it on and tick its web session again on the Agents page if needed.";

/** Définition OpenAI de `agent_save` : champs de la fiche d'un agent personnel, tout champ hors liste refusé. */
export function definitionOutilAgent(): Dict {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Save a PERSONAL SUB-AGENT for the user, always DISABLED.\n\n" +
        "WHEN: the user explicitly asked to create an agent and approved the complete draft\n" +
        "(name, description, tools, read-only, persona). NEVER call it on your own initiative.\n\n" +
        "The agent belongs to the CURRENT user only and stays DISABLED: task offers it only after\n" +
        "the user switches it on from the Agents page. Tell the user so after saving.\n" +
        "An agent with the same name is refused (agent_exists) unless replace=true, which the user\n" +
        "must have asked for.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description:
              "1-32 characters a-z 0-9 - _, starting and ending with a letter or digit; not a built-in agent name.",
          },
          description: {
            type: "string",
            description:
              "One line telling the parent model when to delegate to this agent (200 characters max).",
          },
          prompt: {
            type: "string",
            description:
              "Persona in English: # Role, # Objective, # Your tools, # Method, # Effort, # Constraints, # Report.",
          },
          tool_categories: {
            type: "array",
            items: { type: "string" },
            description:
              "Local tool categories (e.g. 'fs', 'shell', 'git', 'browser'); unknown ones are refused.",
          },
          mcp_server_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional ids of the user's MCP servers; unknown ones are refused with the valid list.",
          },
          read_only: { type: "boolean", description: "true: no write, commit or shell tool." },
          max_iters: {
            type: "integer",
            minimum: 1,
            maximum: CUSTOM_ITERS_MAX,
            description: "Optional tool-call budget per mission.",
          },
          thinking: { type: "string", enum: [...MODES_REFLEXION], description: "Optional reasoning mode." },
          replace: {
            type: "boolean",
            description: "true only when the user asked to overwrite their agent of the same name.",
          },
        },
        required: ["name", "description", "prompt"],
      },
    },
  };
}

/** Refus lisible par le modèle (la boucle peut corriger l'argument et rappeler). */
class Refus extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Liste de chaînes dédupliquée, bornée ; `null`/absent = vide. */
function chaines(a: Dict, cle: string, max: number): string[] {
  const brut = a[cle];
  if (brut == null) return [];
  if (!Array.isArray(brut) || brut.some((v) => typeof v !== "string"))
    throw new Refus("invalid_argument", `${cle} must be a list of strings`);
  const out = [...new Set(brut.map((v: string) => stripPy(v)).filter(Boolean))];
  if (out.length > max) throw new Refus("invalid_argument", `${cle}: ${max} at most`);
  return out;
}

/** Fiche demandée, contrôlée champ par champ (messages en anglais) avant la validation partagée des réglages. */
function ficheDemandee(a: Dict, serveurs: readonly Dict[]): Dict {
  const inconnus = Object.keys(a).filter((k) => !CHAMPS.includes(k));
  if (inconnus.length) throw new Refus("invalid_argument", `unexpected argument(s): ${inconnus.join(", ")}`);
  const name = stripPy(String(a["name"] ?? "")).toLowerCase();
  if (!AGENT_NAME_RE.test(name))
    throw new Refus(
      "invalid_argument",
      `invalid name '${name}': 1-32 characters a-z 0-9 - _, starting and ending with a letter or digit`,
    );
  if (RESERVED_AGENT_NAMES.has(name) || AGENTS.has(name))
    throw new Refus("invalid_argument", `'${name}' is a built-in agent name: choose another name`);
  const prompt = stripPy(String(a["prompt"] ?? ""));
  if (!prompt) throw new Refus("invalid_argument", "prompt is required");
  if (longueurPy(prompt) > CUSTOM_PROMPT_MAX)
    throw new Refus("invalid_argument", `prompt too long (${CUSTOM_PROMPT_MAX} characters at most)`);
  const description = stripPy(String(a["description"] ?? ""));
  if (!description) throw new Refus("invalid_argument", "description is required");
  const connues = categoriesRoutine();
  const cats = chaines(a, "tool_categories", CUSTOM_CATS_MAX).map((c) => c.toLowerCase());
  const inconnue = cats.find((c) => !connues.includes(c));
  if (inconnue)
    throw new Refus("invalid_argument", `unknown tool category '${inconnue}' (valid: ${connues.join(", ")})`);
  const ids = chaines(a, "mcp_server_ids", CUSTOM_MCP_MAX);
  const valides = serveurs.filter((s) => typeof s["id"] === "string");
  const absent = ids.find((i) => !valides.some((s) => s["id"] === i));
  if (absent)
    throw new Refus(
      "invalid_argument",
      `unknown MCP server id '${absent}' (valid: ${valides.map((s) => `${String(s["id"])} (${String(s["name"] ?? "")})`).join(", ") || "none"})`,
    );
  const fiche: Dict = {
    name,
    description,
    prompt,
    tool_categories: cats,
    mcp_server_ids: ids,
    enabled: false,
  };
  for (const k of ["read_only", "replace"])
    if (a[k] != null && typeof a[k] !== "boolean")
      throw new Refus("invalid_argument", `${k} must be a boolean`);
  if (typeof a["read_only"] === "boolean") fiche["read_only"] = a["read_only"];
  const iters = a["max_iters"];
  if (iters != null) {
    if (typeof iters !== "number" || !Number.isInteger(iters) || iters < 1 || iters > CUSTOM_ITERS_MAX)
      throw new Refus("invalid_argument", `max_iters must be an integer from 1 to ${CUSTOM_ITERS_MAX}`);
    fiche["max_iters"] = iters;
  }
  const th = a["thinking"];
  if (th != null) {
    if (typeof th !== "string" || !(MODES_REFLEXION as readonly string[]).includes(th))
      throw new Refus("invalid_argument", `thinking must be one of ${MODES_REFLEXION.join(", ")}`);
    fiche["thinking"] = th;
  }
  return fiche;
}

/** Nom d'une entrée de `custom_agents`, comparé comme la validation des réglages. */
const nomEntree = (e: unknown): string => (estDict(e) ? stripPy(String(e["name"] ?? "")).toLowerCase() : "");

/** `agent_save` : fiche contrôlée, ajoutée (ou remplacée sur `replace`) dans `custom_agents` du compte, désactivée. */
export async function agentSave(
  base: Base,
  uid: number,
  a: Dict,
  serveurs: () => Promise<readonly Dict[]>,
): Promise<Dict> {
  try {
    const fiche = ficheDemandee(a, a["mcp_server_ids"] == null ? [] : await serveurs());
    const nom = String(fiche["name"]);
    let remplace = false;
    let enregistree: Dict = fiche;
    await mergeUserSettings(base, uid, (s) => {
      const liste: unknown[] = Array.isArray(s["custom_agents"])
        ? [...(s["custom_agents"] as unknown[])]
        : [];
      const idx = liste.findIndex((e) => nomEntree(e) === nom);
      if (idx >= 0 && a["replace"] !== true)
        throw new Refus("agent_exists", `the user already has an agent named '${nom}'`);
      if (idx < 0 && liste.length >= CUSTOM_AGENTS_MAX)
        throw new Refus(
          "agents_limit",
          `the user already has ${CUSTOM_AGENTS_MAX} agents: one must be deleted first`,
        );
      remplace = idx >= 0;
      if (remplace) liste[idx] = fiche;
      else liste.push(fiche);
      const canon = validateCustomAgents(liste);
      s["custom_agents"] = canon;
      enregistree = canon.find((e) => nomEntree(e) === nom) ?? fiche;
    });
    const { prompt, ...vue } = enregistree;
    return ok({
      ...vue,
      prompt_chars: longueurPy(String(prompt ?? "")),
      replaced: remplace,
      note: remplace ? NOTE_REMPLACE : NOTE,
    });
  } catch (e) {
    if (e instanceof Refus) return err(e.code, e.message, { retryable: e.code === "invalid_argument" });
    if (estErreurPython(e, "ValueError")) return err("invalid_argument", e.message, { retryable: true });
    throw e;
  }
}

export interface OptionsOutilAgent {
  readonly base: Base;
  readonly userId: number;
  /** Serveurs MCP du compte ouverts aux agents (ceux de la page Agents). */
  readonly serveurs: () => Promise<readonly Dict[]>;
}

/** `{agent_save}` construit pour un tour, au nom du compte de la session. */
export function buildAgentBuiltinTool(o: OptionsOutilAgent): Record<string, OutilIntegre> {
  const handler = async (brut: Dict): Promise<string> => {
    const args: Dict = estDict(brut) ? brut : {};
    return pyJsonDumps(await agentSave(o.base, o.userId, args, o.serveurs), { ensureAscii: false });
  };
  return { [TOOL_NAME]: { definition: definitionOutilAgent(), handler } };
}
