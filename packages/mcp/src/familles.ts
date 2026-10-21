// SPDX-License-Identifier: MIT
/** packages/mcp/src/familles.ts — familles d'outils MCP : table partagée, grammaire `all,-x` et familles exposées à opencode. */
import { comparePointsDeCode, strPy, stripPy } from "@elpis/commun";
import { config } from "@elpis/config";

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

export const DEFAULT_OPENCODE_FAMILIES = "git,browser,desktop";
export const DEFAULT_OPENCODE_EXCLUDE = "fs,shell,office,skill_run";

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

/** Liste simple de familles (ni `all` ni soustraction), noms inconnus ignorés avec avertissement. */
export function parseFamilySet(raw: string | null | undefined, warn?: Avertir): Set<string> {
  const out = new Set<string>();
  for (const brut of (raw || "").split(",")) {
    const t = stripPy(brut).toLowerCase().replace(/^-+/, "");
    if (!t) continue;
    if (FAMILY_NAMES.includes(t)) out.add(t);
    else warn?.(`famille inconnue ignorée : ${repr(t)}`);
  }
  return out;
}

/** Ce que `opencode_families` lit du manifeste `mcp.json` (posé par manifeste.ts, sans import circulaire). */
export interface ManifesteFamilles {
  readonly source: string;
  toolhost(): unknown;
  opencodeFamilies(): string[];
}

let chargeurManifeste: (() => ManifesteFamilles) | null = null;

export function brancherManifesteFamilles(f: (() => ManifesteFamilles) | null): void {
  chargeurManifeste = f;
}

/** Environnement d'abord, puis la config de l'app, puis le défaut. */
function reglage(
  nom: "LOCAL_MCP_OPENCODE_FAMILIES" | "LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES",
  defaut: string,
): string {
  const env = process.env[nom];
  if (env !== undefined) return env;
  const val: unknown = config[nom];
  return val === null || val === undefined ? defaut : strPy(val);
}

export interface OptionsOpencode {
  includeRaw?: string | null;
  excludeRaw?: string | null;
  warn?: Avertir;
  useManifest?: boolean;
}

/** Familles exposées aux clients opencode : manifeste (fichier) s'il fait foi, sinon inclusion moins exclusions. */
export function opencodeFamilies(options: OptionsOpencode = {}): string[] {
  let include = options.includeRaw ?? null;
  let exclude = options.excludeRaw ?? null;
  if (
    include === null &&
    (options.useManifest ?? true) &&
    process.env["LOCAL_MCP_OPENCODE_FAMILIES"] === undefined &&
    chargeurManifeste !== null
  ) {
    try {
      const m = chargeurManifeste();
      if (m.source === "file" && m.toolhost() !== null) return m.opencodeFamilies();
    } catch {
      // manifeste illisible : résolution héritée
    }
  }
  if (include === null) include = reglage("LOCAL_MCP_OPENCODE_FAMILIES", DEFAULT_OPENCODE_FAMILIES);
  if (exclude === null) exclude = reglage("LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES", DEFAULT_OPENCODE_EXCLUDE);
  const inc = stripPy(include || "") ? parseFamilies(include, options.warn) : [];
  const exc = parseFamilySet(exclude, options.warn);
  return inc.filter((n) => !exc.has(n));
}
