// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/portee.ts — portées et chemins du magasin par compte (USER.md par compte, MEMORY.md par portée), port de llm_core/memory/_scope.py. */
import { createHash } from "node:crypto";

import { stripPy } from "@elpis/commun";

import { exigerUtf8, MarkdownStore } from "./magasin";

export const DEFAULT_MEMORY_LIMIT = 2200;
export const DEFAULT_USER_LIMIT = 1375;
/** Sous-dossier du magasin sous `{sandbox}/{compte}/`, créé par l'hôte (l'ancien `.memory` appartenait au conteneur). */
export const MEMORY_SUBDIR = "memory";
export const LEGACY_MEMORY_SUBDIR = ".memory";
const PORTEES_RACINE: ReadonlySet<string> = new Set(["", "user", "chat", "default"]);

/** `PurePosixPath(a) / b / …` : `//` et `.` repliés, `..` gardé, `//` de tête conservé, partie absolue repartant de la racine. */
export function cheminPy(...parties: string[]): string {
  let racine = "";
  let morceaux: string[] = [];
  for (const p of parties) {
    if (p.startsWith("/")) {
      racine = p.startsWith("//") && !p.startsWith("///") ? "//" : "/";
      morceaux = [];
    }
    for (const m of p.split("/")) if (m !== "" && m !== ".") morceaux.push(m);
  }
  return racine + morceaux.join("/") || ".";
}

/** Nom de dossier sûr, même règle que le bac à sable : hors `[A-Za-z0-9_-]` retiré, « guest » si vide. */
export function safeUsername(username: string | null | undefined): string {
  if (!username) return "guest";
  return username.replace(/[^A-Za-z0-9_-]/gu, "") || "guest";
}

export function scopeHash(scopeKey: string): string {
  exigerUtf8(scopeKey);
  return createHash("sha1").update(scopeKey, "utf8").digest("hex").slice(0, 12);
}

/** `[MEMORY.md, USER.md]` de ce compte et de cette portée (racine pour le chat, `scopes/<sha1[:12]>/` sinon). */
export function resolvePaths(
  username: string | null | undefined,
  scopeKey: string | null | undefined,
  sandboxDir: string,
): [string, string] {
  const base = cheminPy(sandboxDir, safeUsername(username), MEMORY_SUBDIR);
  const portee = stripPy(scopeKey || "");
  const memoire = PORTEES_RACINE.has(portee)
    ? cheminPy(base, "MEMORY.md")
    : cheminPy(base, "scopes", scopeHash(portee), "MEMORY.md");
  return [memoire, cheminPy(base, "USER.md")];
}

export interface Limites {
  memoryLimit?: number;
  userLimit?: number;
}

/** Magasin `user` (USER.md) ou `memory` (MEMORY.md) de ce compte et de cette portée. */
export function storeFor(
  kind: string,
  username: string | null | undefined,
  scopeKey: string | null | undefined,
  sandboxDir: string,
  limites: Limites = {},
): MarkdownStore {
  const [memoire, utilisateur] = resolvePaths(username, scopeKey, sandboxDir);
  if (kind === "user")
    return new MarkdownStore(utilisateur, limites.userLimit ?? DEFAULT_USER_LIMIT, { label: "USER.md" });
  return new MarkdownStore(memoire, limites.memoryLimit ?? DEFAULT_MEMORY_LIMIT, { label: "MEMORY.md" });
}
