// SPDX-License-Identifier: MIT
/** apps/core/src/outils/todo/resultat.ts — résultat court de `todowrite` : comptes, tâches terminées par cet appel, remarques, diff avant/après (`build_result` de todo_tools.py). */
import { estDict, getOu } from "@elpis/commun";

import { counts, currentTask, renderChecklist } from "../integres/format-todo";
import { normalize, normText, signature } from "./normalisation";
import type { TodoNormalise } from "./normalisation";

/** `TodoWriteResult.model_dump()` : clés dans l'ordre du modèle ; `todos` alimente l'événement UI puis est retiré du résultat vu par le modèle. */
export interface ResultatTodoWrite {
  ok: true;
  done: number;
  total: number;
  remaining: number;
  in_progress: string;
  completed_now: string[];
  checklist: string;
  notes: string[];
  persisted: boolean;
  todos: TodoNormalise[];
}

/** `persisted_fn` de `build_result` : écrit la liste normalisée, rend vrai si elle est enregistrée. */
export type FonctionPersistance = (todos: TodoNormalise[]) => boolean | Promise<boolean>;

/** Cœur testable de `todowrite` : normalise, persiste, compare à `prev` (terminées maintenant, liste inchangée, plusieurs en cours, tout clos) et résume. */
export async function buildResult(
  items: readonly unknown[] | null | undefined,
  prev: readonly unknown[],
  persistedFn?: FonctionPersistance | null,
): Promise<ResultatTodoWrite> {
  const [todos, notes] = normalize(items, prev);
  const persisted = persistedFn ? Boolean(await persistedFn(todos)) : false;
  const c = counts(todos);
  const dejaTerminees = new Set(
    prev
      .filter((p) => estDict(p) && getOu(p, "status", null) === "completed")
      .map((p) => normText(getOu(p, "content", null))),
  );
  const completedNow = todos
    .filter((t) => t.status === "completed" && !dejaTerminees.has(normText(t.content)))
    .map((t) => t.content);
  if (prev.length > 0 && egales(signature(todos), signature(prev))) {
    const cur = currentTask(todos);
    notes.push(
      "List unchanged: nothing to update. " +
        (cur
          ? `Continue with the task in progress: ${cur}.`
          : "Call todowrite again only when a task changes status."),
    );
  }
  const nEnCours = todos.filter((t) => t.status === "in_progress").length;
  if (nEnCours > 1) notes.push(`${nEnCours} tasks are in_progress: keep exactly ONE in progress.`);
  if (todos.length > 0 && c.open === 0) notes.push("All tasks are closed.");
  return {
    ok: true,
    done: c.done,
    total: c.total,
    remaining: c.open,
    in_progress: currentTask(todos) ?? "",
    completed_now: completedNow,
    checklist: renderChecklist(todos),
    notes,
    persisted,
    todos,
  };
}

function egales(a: readonly [string, string][], b: readonly [string, string][]): boolean {
  return a.length === b.length && a.every((x, i) => x[0] === b[i]?.[0] && x[1] === b[i]?.[1]);
}
