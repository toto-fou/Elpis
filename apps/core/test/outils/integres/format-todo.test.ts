// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/format-todo.test.ts — forme canonique de la liste de tâches : listes Python rejouées. */
import "../../moteur-environnement";

import { describe, expect, it } from "vitest";

import { counts, currentTask, renderChecklist } from "../../../src/outils/integres/format-todo";
import { lireVecteurs } from "../../vecteurs-moteur";

const V = lireVecteurs<{
  cas: { todos: unknown[] | null; checklist: string; comptes: unknown; en_cours: string | null }[];
}>("outils-format-todo");

describe("forme canonique des tâches", () => {
  it("liste, comptes et tâche en cours identiques au Python", () => {
    for (const c of V.cas) {
      expect(renderChecklist(c.todos)).toBe(c.checklist);
      expect(counts(c.todos)).toEqual(c.comptes);
      expect(currentTask(c.todos)).toBe(c.en_cours);
    }
  });
});
