// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/question.ts — outil `ask_user` du tour : questionnaire affiché au-dessus de la barre de saisie, réponses dans le message suivant. */
import { estDict, pyJsonDumps, reprPy, stripPy, veritePy } from "@elpis/commun";
import { asList, asStr } from "@elpis/outils-mcp";

import { longueurPy, prefixePy } from "../../python";
import type { Dict } from "../../python";
import { enveloppe } from "../../skills/outils";
import type { OutilIntegre } from "../catalogue";

export const TOOL_NAME = "ask_user";
export const ASK_MAX_QUESTIONS = 8;
export const ASK_MAX_OPTIONS = 12;
export const ASK_MAX_Q_CHARS = 300;
export const ASK_MAX_OPT_CHARS = 120;

export function definitionOutilQuestion(): Dict {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Display an interactive questionnaire ABOVE the user's prompt bar.\n\n" +
        "WHEN: you need several pieces of information from the user (interview, scoping,\n" +
        "preference gathering). Instead of asking questions in\n" +
        "plain text one message at a time, call this tool ONCE with all the questions of\n" +
        "the round: the UI walks the user through them one by one (clickable options +\n" +
        "free-text field) and their combined answers arrive as the NEXT user message.\n\n" +
        "AFTER the call: end your turn IMMEDIATELY with one short sentence inviting the\n" +
        "user to answer below \u2014 do NOT repeat the questions in text.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          questions: {
            type: "array",
            items: {},
            description:
              '1 to 8 questions, each {"q": "question text", "options": ["suggested choice", \u2026] (may be empty = free-text answer), "multi": true if several choices are valid}. ' +
              "The user ALWAYS gets a free-text field on top of the options. Write questions and options in the user's language. " +
              "Anything past these bounds is dropped before display (max 12 options per question, 300 chars per question, 120 per option) \u2014 the result then carries a `warning` saying what was left out.",
          },
        },
        required: ["questions"],
      },
    },
  };
}

/** Questionnaire normalisé et borné ; ce qui dépasse est écarté et signalé dans `warning`. */
export function askUser(args: { questions: unknown }): Dict {
  const brut = asList(args.questions);
  const items: Dict[] = [];
  const coupes: string[] = [];
  if (brut.length > ASK_MAX_QUESTIONS)
    coupes.push(`${brut.length - ASK_MAX_QUESTIONS} question(s) dropped (max ${ASK_MAX_QUESTIONS})`);
  for (const x of brut.slice(0, ASK_MAX_QUESTIONS)) {
    if (!estDict(x)) continue;
    const d: Dict = x;
    const champ = (k: string): unknown => (Object.hasOwn(d, k) ? d[k] : undefined);
    const qBrut = asStr(veritePy(champ("q")) ? champ("q") : champ("question"));
    const q = stripPy(prefixePy(qBrut, ASK_MAX_Q_CHARS));
    if (!q) continue;
    if (longueurPy(qBrut) > ASK_MAX_Q_CHARS) coupes.push(`question text cut at ${ASK_MAX_Q_CHARS} chars`);
    const optsBrutes = asList(champ("options"))
      .map((o) => asStr(o))
      .filter((o) => o);
    if (optsBrutes.length > ASK_MAX_OPTIONS)
      coupes.push(
        `${optsBrutes.length - ASK_MAX_OPTIONS} option(s) dropped on ${reprPy(prefixePy(q, 40))} (max ${ASK_MAX_OPTIONS})`,
      );
    const options = optsBrutes.slice(0, ASK_MAX_OPTIONS).map((o) => prefixePy(o, ASK_MAX_OPT_CHARS));
    items.push({ q, options, multi: veritePy(champ("multi")) });
  }
  if (items.length === 0)
    return enveloppe("ask_user_rejected", "no valid question", {
      fix: 'Pass questions=[{"q": "…", "options": ["…"], "multi": false}, …] (1 to 8 questions, non-empty q).',
    });
  return {
    ok: true,
    displayed: true,
    count: items.length,
    note:
      "Questionnaire displayed to the user above their prompt bar. " +
      "End your turn NOW with one short sentence (e.g. « Answer the " +
      "questionnaire below 👇 ») without repeating the " +
      "questions; the answers arrive in the next user message.",
    warning:
      coupes.length > 0
        ? `Input clipped before display — ${coupes.join("; ")}. Only what is listed in \`count\` was actually shown.`
        : null,
  };
}

/** `{ask_user}` du tour : même résultat que l'ancien outil de la famille skill, rendu en JSON. */
export function buildQuestionBuiltinTool(): Record<string, OutilIntegre> {
  const handler = (brut: Dict): string =>
    pyJsonDumps(askUser({ questions: brut !== null && typeof brut === "object" ? brut["questions"] : [] }), {
      ensureAscii: false,
    });
  return { [TOOL_NAME]: { definition: definitionOutilQuestion(), handler } };
}
