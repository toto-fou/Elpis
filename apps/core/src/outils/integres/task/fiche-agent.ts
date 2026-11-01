// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/fiche-agent.ts — fiche d'un agent du compte (`custom_agents`) : bornes, nom libre, description, budget, catégories et serveurs MCP normalisés. */
import {
  ErreurPython,
  estErreurPython,
  intPy,
  longueurPy,
  lowerPy,
  prefixePy,
  splitPy,
  stripPy,
  texteOu,
} from "@elpis/commun";

import { tokenHex } from "../../../boucle/ports";
import { manifesteMcp } from "../../ports";

export const AGENT_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/u;
export const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["task"]);
export const CUSTOM_AGENTS_MAX = 30;
const CUSTOM_DESC_MAX = 200;
export const CUSTOM_ITERS_MAX = 200;
export const CUSTOM_PROMPT_MAX = 16000;
export const CUSTOM_CATS_MAX = 12;
export const CUSTOM_MCP_MAX = 8;
export const CAT_SLUG_RE = /^[a-z0-9_-]{1,32}$/u;
export const CUSTOM_DEFAULT_CATEGORIES: readonly string[] = ["fs", "shell", "git"];

/** Socle d'un agent qui n'en demande aucune : `default_on` du manifeste, sinon fs/shell/git. */
export function customDefaultCategories(): string[] {
  let actives: string[];
  try {
    actives = [...manifesteMcp().defaultOnCategories()];
  } catch {
    actives = [];
  }
  return actives.length ? [...new Set(actives)].sort() : [...CUSTOM_DEFAULT_CATEGORIES];
}

/** Nom d'agent ou slug normalisé (blancs retirés, minuscules). */
export const nomDe = (v: unknown): string => lowerPy(stripPy(texteOu(v, "")));

/** Description sur UNE ligne (blancs repliés), bornée. */
export function normDesc(raw: unknown): string {
  return prefixePy(splitPy(texteOu(raw, "")).join(" "), CUSTOM_DESC_MAX);
}

/** Nom libre dérivé d'un nom devenu réservé. */
export function freeAgentName(base: string, taken: ReadonlySet<string>): string {
  const sansBords = (s: string): string => s.replace(/[-_]+$/u, "");
  const stem = sansBords(prefixePy(base || "agent", 24)) || "agent";
  for (const cand of [`${stem}-custom`, ...Array.from({ length: 18 }, (_, i) => `${stem}-custom${i + 2}`)])
    if (!taken.has(cand) && !RESERVED_AGENT_NAMES.has(cand)) return cand;
  return `${sansBords(prefixePy(stem, 20)) || "agent"}-${tokenHex(3)}`;
}

/** Budget d'itérations fixé par l'agent, borné à 1..200 ; `null` = suivre le défaut (TypeError et ValueError seuls, l'OverflowError d'un infini remonte). */
export function normMaxIters(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let v: number;
  try {
    v = intPy(raw);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return null;
    throw e;
  }
  return v <= 0 ? null : Math.min(v, CUSTOM_ITERS_MAX);
}

/** Faute saisissable dans une fiche (`ValueError`, message rendu tel quel). */
export function erreurValeur(message: string): never {
  throw new ErreurPython("ValueError", message);
}

/** Catégories d'outils lues en fermant (slugs valides, sans doublon). */
export function catsOf(raw: unknown): string[] {
  const cats: string[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const slug = nomDe(c);
    if (CAT_SLUG_RE.test(slug) && !cats.includes(slug)) cats.push(slug);
  }
  return cats;
}

/** Serveurs MCP lus en fermant (ids non vides, bornés, sans doublon). */
export function mcpIdsOf(raw: unknown): string[] {
  const ids: string[] = [];
  for (const s of Array.isArray(raw) ? raw.slice(0, CUSTOM_MCP_MAX) : []) {
    const sid = stripPy(texteOu(s, ""));
    if (sid && longueurPy(sid) <= 64 && !ids.includes(sid)) ids.push(sid);
  }
  return ids;
}
