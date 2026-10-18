// SPDX-License-Identifier: MIT
/** packages/commun/src/motifs.ts — motifs de regex à la `re` de Python. */

const EQUIVALENTS: Readonly<Record<string, string>> = { i: "iI\u0130\u0131", k: "kK\u212a", s: "sS\u017f" };

/** Littéral insensible à la casse comme `re.IGNORECASE` de Python (İ et ı pour i, K de Kelvin, ſ pour s). */
export function motifPy(litteral: string): string {
  return Array.from(litteral, (c) => {
    if (/[a-z]/u.test(c)) return `[${EQUIVALENTS[c] ?? c + c.toUpperCase()}]`;
    return c.replace(/[\\^$.*+?()[\]{}|/]/u, "\\$&");
  }).join("");
}
