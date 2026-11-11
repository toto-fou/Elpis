// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/ecart-tache.ts — écart voulu à la référence des tests de la définition de `task` (ecarts-python.md de la v0.1.2, « Sous-agents ») : le roster et les types viennent de la référence (résumé de `pr` porté), la description en quatre notes et les huit paramètres sont ceux du TS. */
import type { Dict } from "../../../../src/python";

/** `pr` ne publie plus : il rend la commande de publication au parent. */
const RESUME_PR_PYTHON = "- pr: branches, commits and opens the pull request for work already in the tree";
const RESUME_PR_TS =
  "- pr: branches and commits work already in the tree, then hands back the publish command";

const TETE_ROSTER_PYTHON = "Available agent types (subagent_type):\n";
const FIN_ROSTER_PYTHON = "\n\nUsage notes:";

const INTRO_TS =
  "Launch a sub-agent for a well-scoped sub-mission: it runs its own tool loop in a fresh context on the same " +
  "model and returns one final report; its steps stay out of this conversation.\n\n";

const NOTES_TS =
  "Notes:\n" +
  "1. Fresh context: the prompt is a complete brief (context, goal, and what the report must contain: paths, " +
  "lines, values).\n" +
  "2. Pass the task_id of a result to resume that agent as it was launched, with its history (also after a " +
  "timeout or a cancellation); if it expired, start fresh.\n" +
  "3. Its work is not shown to the user: restate the result in your answer.\n" +
  "4. Do not delegate a lookup of one or two calls, or a step that needs the user. Agents of one message run in " +
  "parallel (bounded by the server); you coordinate their writes: disjoint files, one after another, or a sync " +
  "file named in their briefs.";

const PARAMETRES: Dict = {
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

/** Définition de référence de `task` portée à la forme TS : son roster (résumé de `pr` porté) et ses types, la description et les paramètres du TS. */
export function ecartDefinitionTache(python: Dict): Dict {
  const fn = python["function"] as Dict;
  const desc = String(fn["description"]);
  const debut = desc.indexOf(TETE_ROSTER_PYTHON);
  const fin = desc.indexOf(FIN_ROSTER_PYTHON);
  if (debut < 0 || fin < debut) throw new Error("roster de la référence introuvable : vecteur changé ?");
  const roster = desc.slice(debut + TETE_ROSTER_PYTHON.length, fin).replace(RESUME_PR_PYTHON, RESUME_PR_TS);
  const proprietes = (fn["parameters"] as Dict)["properties"] as Dict;
  const types = (proprietes["subagent_type"] as Dict)["enum"];
  return {
    type: "function",
    function: {
      name: "task",
      description: `${INTRO_TS}Agent types (subagent_type):\n${roster}\n\n${NOTES_TS}`,
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short label of the task (5-6 words)." },
          prompt: { type: "string", description: "The complete brief." },
          subagent_type: { type: "string", enum: structuredClone(types), description: "Agent type." },
          task_id: { type: "string", description: "Resume the agent of this id (from a previous result)." },
          ...structuredClone(PARAMETRES),
        },
        required: ["description", "prompt", "subagent_type"],
      },
    },
  };
}
