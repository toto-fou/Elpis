// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/routine.ts — outil `routine_save` du tour : crée une routine planifiée toujours en pause, par la validation partagée du formulaire. */
import { HttpError, pyJsonDumps, stripPy } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { BUILTIN_SENTINEL } from "@elpis/mcp";
import { err, ok } from "@elpis/outils-mcp";

import { BUILTIN_KEY, canUseEngine } from "../../llm/acces-moteurs";
import { getToolCategoriesDict } from "../categories";
import type { Dict } from "../../python";
import { createRoutine } from "../../routines/magasin";
import { chargeRoutine } from "../../routines/validation";
import type { OutilIntegre } from "../catalogue";

export const TOOL_NAME = "routine_save";

const CHAMPS = [
  "name",
  "task_prompt",
  "cron_expr",
  "system_prompt",
  "skills",
  "tool_categories",
  "thinking_mode",
  "notify_on",
];

export function definitionOutilRoutine(): Dict {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Create a SCHEDULED ROUTINE for the user, always saved PAUSED (disabled).\n\n" +
        "WHEN: the user explicitly asks for a recurring or scheduled automated task\n" +
        '("every morning ...", "each Monday ...") and you have agreed on its goal, its\n' +
        "schedule and its output. NEVER call it on your own initiative or before the user\n" +
        "has explicitly approved the final draft (name, schedule, prompt).\n\n" +
        "The routine is created for the CURRENT user only, with the default model and\n" +
        "without any external server. It stays PAUSED: nothing runs until the user reviews\n" +
        "it and switches it on from the Routines page. Tell the user so after saving.\n\n" +
        "cron_expr is a 5-field cron expression (minute hour day-of-month month\n" +
        "day-of-week); day-of-week is 1-7 with Monday = 1 (0 is not Sunday). Example:\n" +
        '"30 8 * * 1" = every Monday at 08:30; "0 7 * * *" = every day at 07:00.\n\n' +
        "task_prompt is what the routine receives each time it runs. It must be\n" +
        "SELF-CONTAINED: the run has no conversation and cannot ask the user anything.\n\n" +
        'Example:\n    routine_save(\n        name="Veille hebdo",\n' +
        '        task_prompt="Search the web for news about X and write a 10-line summary ...",\n' +
        '        cron_expr="0 8 * * 1",\n        skills=["veille-web"],\n' +
        '        tool_categories=["browser"],\n        notify_on="all")',
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Short routine name shown in the Routines page." },
          task_prompt: {
            type: "string",
            description:
              "Self-contained instructions run at each trigger (no conversation, no questions to the user).",
          },
          cron_expr: {
            type: "string",
            description: "5-field cron expression; day-of-week 1-7 with Monday = 1, e.g. '0 8 * * 1'.",
          },
          system_prompt: { type: "string", description: "Optional system prompt for the routine." },
          skills: {
            type: "array",
            items: { type: "string" },
            description: "Optional skill names to attach (12 at most, they must exist).",
          },
          tool_categories: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional tool categories the routine may use (e.g. 'browser', 'fs'); unknown ones are refused.",
          },
          thinking_mode: { type: "boolean", description: "Optional: enable the model's reasoning mode." },
          notify_on: {
            type: "string",
            enum: ["all", "error", "none"],
            description: "Optional: which runs notify the user ('all' by default).",
          },
        },
        required: ["name", "task_prompt", "cron_expr"],
      },
    },
  };
}

/** Catégories locales ouvertes à une routine : visibles et pourvues d'au moins un outil dans le registre courant. */
export function categoriesRoutine(): string[] {
  return Object.entries(getToolCategoriesDict(false))
    .filter(([, outils]) => outils.length > 0)
    .map(([nom]) => nom)
    .sort();
}

/** Serveur local filtré par catégories, même forme que `construireServeursMcp` du formulaire. */
function serveursLocaux(cats: string[]): Dict[] {
  if (!cats.length) return [];
  return [{ type: "stdio", name: "Outils Locaux", command: BUILTIN_SENTINEL, filter_categories: cats }];
}

/** Catégories demandées, dédupliquées ; une inconnue lève une 400 qui liste les valeurs valides. */
function categoriesDemandees(brut: unknown): string[] {
  const connues = categoriesRoutine();
  const out: string[] = [];
  if (brut != null && !Array.isArray(brut)) throw new HttpError(400, "tool_categories doit être une liste");
  for (const c of brut ?? []) {
    const n = stripPy(String(c)).toLowerCase();
    if (!connues.includes(n))
      throw new HttpError(
        400,
        `tool_categories : catégorie inconnue ${n} (valeurs valides : ${connues.join(", ")})`,
      );
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Corps du formulaire avec forçages : en pause, modèle par défaut, ni connecteur, ni amont, ni agents, ni serveur externe. */
export function corpsForce(a: Dict, cats: string[]): Dict {
  const corps: Dict = { name: a["name"], cron_expr: a["cron_expr"], task_prompt: a["task_prompt"] };
  for (const k of ["system_prompt", "skills", "thinking_mode", "notify_on"])
    if (a[k] != null) corps[k] = a[k];
  return Object.assign(corps, { enabled: false, mcp_servers: serveursLocaux(cats) });
}

const NOTE_PAUSE = "Routine created PAUSED: tell the user to review and switch it on from the Routines page.";

/** Le compte peut-il lancer le moteur intégré (routine sans connecteur) ? Un contrôle impossible ne bloque pas la note. */
async function moteurIntegreAccessible(base: Base, uid: number): Promise<boolean> {
  try {
    return await canUseEngine(base, uid, BUILTIN_KEY);
  } catch {
    return true;
  }
}

/** `routine_save` : compte du tour, arguments inconnus refusés, validation partagée, création en pause ; une `HttpError` revient en erreur lisible. */
export async function routineSave(base: Base, uid: number, a: Dict): Promise<Dict> {
  const inconnus = Object.keys(a).filter((k) => !CHAMPS.includes(k));
  if (inconnus.length)
    return err("invalid_argument", `unexpected argument(s): ${inconnus.join(", ")}`, { retryable: true });
  try {
    if (!stripPy(String(a["cron_expr"] ?? ""))) throw new HttpError(400, "cron_expr requis");
    if (!stripPy(String(a["task_prompt"] ?? ""))) throw new HttpError(400, "task_prompt requis");
    if (a["thinking_mode"] != null && typeof a["thinking_mode"] !== "boolean")
      throw new HttpError(400, "thinking_mode doit être un booléen");
    const cats = categoriesDemandees(a["tool_categories"]);
    const champs = await chargeRoutine(base, corpsForce(a, cats), uid);
    const id = await createRoutine(base, uid, champs);
    const note = (await moteurIntegreAccessible(base, uid))
      ? NOTE_PAUSE
      : `${NOTE_PAUSE} The built-in engine is NOT available to this account: tell the user to choose a server in the Routines page before switching it on.`;
    return ok({
      id,
      name: champs.name,
      enabled: false,
      cron_expr: champs.cron_expr,
      skills: champs.skills ?? [],
      tool_categories: cats,
      note,
    });
  } catch (e) {
    if (e instanceof HttpError) return err("invalid_argument", e.message, { retryable: true });
    throw e;
  }
}

export interface OptionsOutilRoutine {
  readonly base: Base;
  readonly userId: number;
}

/** `{routine_save}` construit pour un tour, au nom du compte de la session. */
export function buildRoutineBuiltinTool(o: OptionsOutilRoutine): Record<string, OutilIntegre> {
  const handler = async (brut: Dict): Promise<string> => {
    const args: Dict = brut !== null && typeof brut === "object" && !Array.isArray(brut) ? brut : {};
    return pyJsonDumps(await routineSave(o.base, o.userId, args), { ensureAscii: false });
  };
  return { [TOOL_NAME]: { definition: definitionOutilRoutine(), handler } };
}
