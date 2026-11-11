// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-routines-sans-agents.ts — écart voulu au Python : une routine n'a jamais de sous-agents, `agents_enabled` est toujours rendu faux. */

/** Texte JSON attendu (Python) où `agents_enabled` vrai devient faux (compact ou avec espaces). */
export function sansAgentsDeRoutine(texte: string): string {
  return texte.replace(/("agents_enabled":\s?)true/gu, "$1false");
}
