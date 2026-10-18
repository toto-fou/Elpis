// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/format-todo.ts — forme canonique d'une liste de tâches montrée au modèle (`N. [status] contenu`), comptes, tâche en cours. */
import { estDict, texteOu } from "@elpis/commun";

export const OPEN_STATUSES: readonly string[] = ["pending", "in_progress"];

export function renderChecklist(todos: readonly unknown[] | null | undefined): string {
  const lignes: string[] = [];
  let n = 0;
  for (const t of todos ?? []) {
    if (!estDict(t)) continue;
    n += 1;
    lignes.push(`${n}. [${texteOu(t["status"], "pending")}] ${texteOu(t["content"], "")}`);
  }
  return lignes.join("\n");
}

export function counts(todos: readonly unknown[] | null | undefined): {
  total: number;
  done: number;
  open: number;
} {
  const items = (todos ?? []).filter(estDict);
  return {
    total: items.length,
    done: items.filter((t) => t["status"] === "completed").length,
    open: items.filter((t) => typeof t["status"] === "string" && OPEN_STATUSES.includes(t["status"])).length,
  };
}

export function currentTask(todos: readonly unknown[] | null | undefined): string | null {
  for (const t of todos ?? [])
    if (estDict(t) && t["status"] === "in_progress") return texteOu(t["content"], "");
  return null;
}
