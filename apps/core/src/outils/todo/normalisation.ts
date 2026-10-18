// SPDX-License-Identifier: MIT
/** apps/core/src/outils/todo/normalisation.ts — normalisation de la liste de tâches du modèle (statuts, libellés, héritage de la liste précédente), port de llm_core/tools/todo_tools.py. */
import {
  BLANC_PY,
  casefoldPy,
  estDict,
  getOu,
  lowerPy,
  nfcPy,
  ouPy,
  poserCle,
  prefixePy,
  ratio,
  reprPy,
  rstripPy,
  strPy,
  stripPy,
  texteOu,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

export const VALID_STATUS: readonly string[] = ["pending", "in_progress", "completed", "cancelled"];
export const VALID_PRIORITY: readonly string[] = ["high", "medium", "low"];
export const MAX_TODOS = 50;
export const MAX_CONTENT_CHARS = 300;

/** Tâche normalisée, telle que stockée dans `chats.meta_json["todos"]`. */
export interface TodoNormalise {
  content: string;
  status: string;
  priority: string;
}

const STATUS_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["todo", "pending"],
  ["open", "pending"],
  ["not_started", "pending"],
  ["inprogress", "in_progress"],
  ["doing", "in_progress"],
  ["active", "in_progress"],
  ["started", "in_progress"],
  ["current", "in_progress"],
  ["wip", "in_progress"],
  ["done", "completed"],
  ["complete", "completed"],
  ["finished", "completed"],
  ["canceled", "cancelled"],
  ["skipped", "cancelled"],
  ["abandoned", "cancelled"],
]);

const SUITES_DE_BLANCS = new RegExp(`${BLANC_PY}+`, "gu");

/** `_strict_item_schema` : schéma d'une tâche vu par le modèle (content et status obligatoires, status énuméré, aucune clé en plus) ; modifie `schema`. */
export function strictItemSchema(schema: Dict): void {
  let props = schema["properties"];
  if (!estDict(props)) {
    props = {};
    poserCle(schema, "properties", props);
  }
  poserCle(props as Dict, "status", {
    type: "string",
    enum: [...VALID_STATUS],
    description: "pending | in_progress | completed | cancelled",
  });
  poserCle(schema, "required", ["content", "status"]);
  poserCle(schema, "additionalProperties", false);
}

/** `_norm_text` : NFC, repli de casse, blancs réduits à un espace, ponctuation finale ` .;:` retirée. */
export function normText(s: unknown): string {
  const t = casefoldPy(nfcPy(texteOu(s, ""))).replace(SUITES_DE_BLANCS, " ");
  return rstripPy(stripPy(t), " .;:");
}

/** `_similar` : deux libellés décrivent-ils la même tâche (rapport de séquence d'au moins 0,6, autojunk de Python compris) ? */
export function similar(a: unknown, b: unknown): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return false;
  return ratio(Array.from(x), Array.from(y), true) >= 0.6;
}

/** `_norm_status` : statut canonique (synonymes tolérés), `null` si absent ou inconnu. */
export function normStatus(s: unknown): string | null {
  const t = lowerPy(stripPy(texteOu(s, "")))
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
  if (!t) return null;
  if (VALID_STATUS.includes(t)) return t;
  return STATUS_SYNONYMS.get(t.replaceAll("_", "")) ?? STATUS_SYNONYMS.get(t) ?? null;
}

interface Brute {
  content: string;
  status: unknown;
  priority: unknown;
}

/** Entrée du modèle : chaîne simple ou dict ; tout autre type et toute tâche vide sont ignorés. */
function brute(it: unknown): Brute | null {
  const d: unknown = typeof it === "string" ? { content: it } : it;
  if (!estDict(d)) return null;
  const content = stripPy(texteOu(getOu(d, "content", null), ""));
  if (!content) return null;
  return {
    content: prefixePy(content, MAX_CONTENT_CHARS),
    status: getOu(d, "status", null),
    priority: getOu(d, "priority", null),
  };
}

/** `_normalize` : `[todos, notes]` ; statut absent ou inconnu hérité de la tâche de même libellé (ou de même position, libellés proches) de `prev`, sinon `pending`. */
export function normalize(
  items: readonly unknown[] | null | undefined,
  prev?: readonly unknown[] | null,
): [TodoNormalise[], string[]] {
  const precedentes = (prev ?? []).filter(estDict);
  const parTexte = new Map<string, Dict>();
  for (const p of precedentes) parTexte.set(normText(getOu(p, "content", null)), p);
  const brutes: Brute[] = [];
  for (const it of (items ?? []).slice(0, MAX_TODOS)) {
    const b = brute(it);
    if (b) brutes.push(b);
  }
  const memeLongueur = precedentes.length > 0 && precedentes.length === brutes.length;
  const out: TodoNormalise[] = [];
  const notes: string[] = [];
  brutes.forEach((it, i) => {
    let correspondance: Dict | undefined = parTexte.get(normText(it.content));
    if (
      correspondance === undefined &&
      memeLongueur &&
      similar(it.content, getOu(precedentes[i], "content", null))
    )
      correspondance = precedentes[i];
    let status = normStatus(it.status);
    if (status === null) {
      const herite = normStatus(getOu(correspondance, "status", null)) ?? "pending";
      const donne = stripPy(texteOu(it.status, ""));
      const pourquoi = donne ? `unknown status ${reprPy(donne)}` : "no status";
      notes.push(`Item ${i + 1}: ${pourquoi} — kept [${herite}]. Always send the status of every item.`);
      status = herite;
    }
    let priority = lowerPy(
      stripPy(strPy(ouPy(ouPy(getOu(correspondance, "priority", null), it.priority), ""))),
    );
    if (!VALID_PRIORITY.includes(priority)) priority = "medium";
    out.push({ content: it.content, status, priority });
  });
  return [out, notes];
}

/** `_coerce` : normalisation sans liste précédente. */
export function coerce(items: readonly unknown[] | null | undefined): TodoNormalise[] {
  return normalize(items, null)[0];
}

/** `_signature` : couples (libellé normalisé, statut) des tâches dict, pour détecter une liste inchangée. */
export function signature(todos: readonly unknown[]): [string, string][] {
  return todos
    .filter(estDict)
    .map((t): [string, string] => [
      normText(getOu(t, "content", null)),
      texteOu(getOu(t, "status", null), ""),
    ]);
}
