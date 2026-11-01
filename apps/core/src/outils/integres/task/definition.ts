// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/definition.ts — définitions OpenAI de `task`, `task_status`, `task_wait` et `task_send` (byte-stables : aucun réglage vif) et légende du bloc du harnais. */
import { ATTENTE_DEFAUT_S, ATTENTE_MAX_S } from "../../../llm/constantes";
import type { Dict } from "../../../python";
import { AGENTS } from "./roster";
import type { AgentSpec } from "./roster";

/** Définition OpenAI de l'outil `task`, roster dans la description (ordre stable, aucun réglage vif : byte-stable). */
export function buildDefinition(agents: ReadonlyMap<string, AgentSpec> = AGENTS): Dict {
  const roster = [...agents].map(([name, s]) => `- ${name}: ${s.summary}`).join("\n");
  const description =
    "Launch a sub-agent for a well-scoped sub-mission: it runs its own tool loop in a fresh context on the same " +
    "model and returns one final report; its steps stay out of this conversation.\n\n" +
    `Agent types (subagent_type):\n${roster}\n\n` +
    "Notes:\n" +
    "1. Fresh context: the prompt is a complete brief (context, goal, and what the report must contain: paths, " +
    "lines, values).\n" +
    "2. Pass the task_id of a result to resume that agent as it was launched, with its history (also after a " +
    "timeout or a cancellation); if it expired, start fresh.\n" +
    "3. Its work is not shown to the user: restate the result in your answer.\n" +
    "4. Do not delegate a lookup of one or two calls, or a step that needs the user. Agents of one message run in " +
    "parallel (bounded by the server); you coordinate their writes: disjoint files, one after another, or a sync " +
    "file named in their briefs.";
  return {
    type: "function",
    function: {
      name: "task",
      description,
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short label of the task (5-6 words)." },
          prompt: { type: "string", description: "The complete brief." },
          subagent_type: { type: "string", enum: [...agents.keys()], description: "Agent type." },
          task_id: { type: "string", description: "Resume the agent of this id (from a previous result)." },
          ...PARAMETRES_TS,
        },
        required: ["description", "prompt", "subagent_type"],
      },
    },
  };
}

/** Légende du bloc du harnais, jointe (`legend`) au premier `<task_meta>` que le modèle reçoit dans la conversation, pas à la définition de `task` : il n'en a besoin qu'avec un résultat en main. */
export const LEGENDE_TASK_META =
  "Written by the harness. files_changed, git, errors and tool_calls are observed (concurrent: another run of " +
  "the account that can write ran meanwhile, some files may be its own). status is the agent's claim corrected by " +
  "the harness limits; a verify also declares verdict (pass, fail, inconclusive). duration_s starts when the agent " +
  "gets the engine, queued_s is the wait before; max_seconds counts both. Check an implement's diff or run verify " +
  "before calling it done.";

/** Paramètres propres au TS (écart voulu à la référence des tests) : lecture seule, fond, délai, héritage. */
const PARAMETRES_TS: Readonly<Dict> = {
  read_only: {
    type: "boolean",
    description:
      "New agent only: no write, commit or shell tool (verify then cannot run tests). It only tightens the settings.",
  },
  background: {
    type: "boolean",
    description:
      "Return the task_id at once and go on; its report arrives by itself. background=true when you want to watch or " +
      "steer the agent (task_status, task_send); foreground when you just need its report.",
  },
  max_seconds: {
    type: "integer",
    minimum: 30,
    description: "Wall-clock budget from this call, queue included, capped by the server.",
  },
  inherit: {
    type: "boolean",
    description:
      "New agent only: also give it the user's latest request, the files used in this turn, the repository and " +
      "branch, the open todos (as data).",
  },
};

/** Définitions de `task_status` et `task_wait` : fixes, aucun état (tête du parent identique d'un tour à l'autre). */
export const DEFINITION_TASK_STATUS: Readonly<Dict> = {
  type: "function",
  function: {
    name: "task_status",
    description:
      "Progress of a sub-agent started with task(background=true) in this conversation: state, step, tool calls, " +
      "tokens, last note, recent tool calls. Once it has finished, returns its report if it was not delivered yet. Its report is " +
      "delivered automatically: do not poll.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by task(background=true)." },
      },
      required: ["task_id"],
    },
  },
};

export const DEFINITION_TASK_WAIT: Readonly<Dict> = {
  type: "function",
  function: {
    name: "task_wait",
    description:
      "Wait until a sub-agent started with task(background=true) finishes, at most timeout_s seconds, and return its " +
      "report. Use it only when you cannot go on without that report. The user's Stop ends the wait, not the agent; " +
      "on timeout you get its progress and it keeps running.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by task(background=true)." },
        timeout_s: {
          type: "integer",
          minimum: 1,
          maximum: ATTENTE_MAX_S,
          description: `Longest wait in seconds (default ${ATTENTE_DEFAUT_S}).`,
        },
      },
      required: ["task_id"],
    },
  },
};

/** Longueur maximale (caractères) d'un message de `task_send`. */
export const TASK_SEND_MAX = 4000;

export const DEFINITION_TASK_SEND: Readonly<Dict> = {
  type: "function",
  function: {
    name: "task_send",
    description:
      "Send a new instruction to a sub-agent started with task(background=true) in this conversation; it reads it " +
      "before its next step. wrap_up=true makes it stop working and write its report now (Status: partial).",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by task(background=true)." },
        message: { type: "string", description: "The instruction, as you would add it to the brief." },
        wrap_up: { type: "boolean", description: "Ask it to conclude now with what it has." },
      },
      required: ["task_id", "message"],
    },
  },
};
