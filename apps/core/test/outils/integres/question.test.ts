// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/question.test.ts — outil intégré ask_user : résultats rejoués sur le scénario ask_user des vecteurs Python (sans la notification MCP), définition OpenAI, bornes. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ASK_MAX_OPT_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MAX_Q_CHARS,
  ASK_MAX_QUESTIONS,
  buildQuestionBuiltinTool,
  definitionOutilQuestion,
} from "../../../src/outils/integres/question";
import { enAnglais, sansSuggestion } from "../../skills/ecart-anglais";
import { compacter, developper } from "../../skills/vecteurs-skill";

type Dict = Record<string, unknown>;

const V = JSON.parse(readFileSync(new URL("../../vecteurs/outils-skill.json", import.meta.url), "utf-8")) as {
  constantes: Record<string, number>;
  scenarios: { nom: string; etapes: { outil: string; args: Dict; resultat?: unknown }[] }[];
};

describe("ask_user intégré", () => {
  it("bornes des vecteurs Python", () => {
    expect([ASK_MAX_QUESTIONS, ASK_MAX_OPTIONS, ASK_MAX_Q_CHARS, ASK_MAX_OPT_CHARS]).toEqual([
      V.constantes["questions_max"],
      V.constantes["options_max"],
      V.constantes["q_max"],
      V.constantes["option_max"],
    ]);
  });

  it("définition OpenAI : un seul champ `questions`, aucun autre accepté", () => {
    const f = definitionOutilQuestion()["function"] as Dict;
    expect(f["name"]).toBe("ask_user");
    const p = f["parameters"] as Dict;
    expect(p["additionalProperties"]).toBe(false);
    expect(p["required"]).toEqual(["questions"]);
    expect(Object.keys(p["properties"] as Dict)).toEqual(["questions"]);
  });

  it("le scénario ask_user des vecteurs : mêmes résultats (la notification MCP `info` n'existe plus)", async () => {
    const outil = buildQuestionBuiltinTool()["ask_user"]!;
    const etapes = V.scenarios.find((s) => s.nom === "ask_user")!.etapes;
    expect(etapes.length).toBeGreaterThan(10);
    for (const [i, e] of etapes.entries()) {
      const args = developper(e.args) as Dict;
      const obtenu = JSON.parse(String(await outil.handler(args))) as unknown;
      expect(sansSuggestion(JSON.stringify(compacter(obtenu))), `#${i}`).toBe(
        enAnglais(JSON.stringify(e.resultat)),
      );
    }
  });
});
