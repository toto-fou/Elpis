// SPDX-License-Identifier: MIT
/** packages/mcp/src/familles.ts — familles d'outils MCP : table partagée et grammaire `all,-x`. */
import { comparePointsDeCode, stripPy } from "@elpis/commun";

import { repr } from "./outils";

/** Noms de toutes les familles d'outils, dans l'ordre canonique. */
export const FAMILY_NAMES: readonly string[] = [
  "fs",
  "shell",
  "git",
  "chart",
  "office",
  "memory",
  "skill",
  "skill_run",
  "todo",
  "browser",
  "desktop",
];

export const SANDBOX_FAMILIES = ["fs", "shell", "git", "office", "skill_run", "browser", "desktop"] as const;
export const APP_FAMILIES = ["chart", "memory", "skill", "todo"] as const;

/** Famille → catégorie portée par ses outils (identique partout sauf `todo`, taggée `task`). */
export const FAMILY_CATEGORY: Readonly<Record<string, string>> = {
  fs: "fs",
  shell: "shell",
  git: "git",
  chart: "chart",
  office: "office",
  memory: "memory",
  skill: "skill",
  skill_run: "skill",
  todo: "task",
  browser: "browser",
  desktop: "desktop",
};

export type Avertir = ((message: string) => void) | null | undefined;

/** Segment d'URL = nom de famille connu (ni `/`, ni `..`, ni nom inventé). */
export function isFamilyName(segment: unknown): boolean {
  return typeof segment === "string" && FAMILY_NAMES.includes(segment);
}

/** `LOCAL_MCP_TOOL_FAMILIES` → liste ordonnée : `all`/vide = toutes, `a,b`, `all,-x` ou `-x` ; noms inconnus ignorés avec avertissement. */
export function parseFamilies(raw: string | null | undefined, warn?: Avertir): string[] {
  const toks = (raw || "")
    .split(",")
    .filter((t) => stripPy(t) !== "")
    .map((t) => stripPy(t).toLowerCase());
  if (toks.length === 0) return [...FAMILY_NAMES];
  const exclues = new Set(toks.filter((t) => t.startsWith("-")).map((t) => t.slice(1)));
  const incluses = toks.filter((t) => !t.startsWith("-") && t !== "all");
  const triees = [...exclues].sort(comparePointsDeCode);
  for (const u of [...incluses, ...triees].filter((t) => !FAMILY_NAMES.includes(t)))
    warn?.(`famille d'outils inconnue ignorée : ${repr(u)}`);
  const connues = FAMILY_NAMES.filter((n) => incluses.includes(n));
  if (incluses.length > 0 && connues.length === 0 && !toks.includes("all"))
    warn?.(`aucune famille connue dans ${repr(raw ?? null)} → toutes les familles`);
  const base = toks.includes("all") || connues.length === 0 ? [...FAMILY_NAMES] : connues;
  return base.filter((n) => !exclues.has(n));
}
