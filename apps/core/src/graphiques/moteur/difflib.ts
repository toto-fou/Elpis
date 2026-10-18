// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/difflib.ts — `difflib.get_close_matches` de Python (SequenceMatcher avec autojunk, comparaison par points de code). */
import { comparePointsDeCode } from "@elpis/commun";

type Bloc = readonly [number, number, number];

/** Index de chaque élément de `b` ; au-delà de 200 éléments, les « populaires » (plus de n/100 + 1 fois) sont écartés. */
function chaineB(b: readonly string[]): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  b.forEach((x, j) => {
    const indices = b2j.get(x);
    if (indices) indices.push(j);
    else b2j.set(x, [j]);
  });
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [x, indices] of [...b2j]) if (indices.length > ntest) b2j.delete(x);
  }
  return b2j;
}

/** `find_longest_match` : la plus longue correspondance, la plus à gauche dans `a` puis dans `b`. */
function plusLongue(
  a: readonly string[],
  b: readonly string[],
  b2j: ReadonlyMap<string, readonly number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): Bloc {
  let [besti, bestj, bestsize] = [alo, blo, 0];
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const nouveau = new Map<number, number>();
    for (const j of b2j.get(a[i] ?? "") ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      nouveau.set(j, k);
      if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
    }
    j2len = nouveau;
  }
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1])
    [besti, bestj, bestsize] = [besti - 1, bestj - 1, bestsize + 1];
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize])
    bestsize++;
  return [besti, bestj, bestsize];
}

/** Somme des tailles des blocs communs (`get_matching_blocks`). */
function correspondances(
  a: readonly string[],
  b: readonly string[],
  b2j: ReadonlyMap<string, readonly number[]>,
): number {
  const file: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  let total = 0;
  for (let suivant = file.pop(); suivant !== undefined; suivant = file.pop()) {
    const [alo, ahi, blo, bhi] = suivant;
    const [i, j, k] = plusLongue(a, b, b2j, alo, ahi, blo, bhi);
    if (k === 0) continue;
    total += k;
    if (alo < i && blo < j) file.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) file.push([i + k, ahi, j + k, bhi]);
  }
  return total;
}

/** `SequenceMatcher(None, x, word).ratio()`. */
function ratio(
  x: readonly string[],
  word: readonly string[],
  b2j: ReadonlyMap<string, readonly number[]>,
): number {
  const longueur = x.length + word.length;
  return longueur > 0 ? (2 * correspondances(x, word, b2j)) / longueur : 1;
}

/** `difflib.get_close_matches(word, possibilities, n, cutoff)` : les `n` meilleures, la plus proche d'abord. */
export function getCloseMatches(
  word: string,
  possibilities: readonly string[],
  n: number,
  cutoff: number,
): string[] {
  const b = Array.from(word);
  const b2j = chaineB(b);
  const trouves: [number, string][] = [];
  for (const x of possibilities) {
    const r = ratio(Array.from(x), b, b2j);
    if (r >= cutoff) trouves.push([r, x]);
  }
  trouves.sort((p, q) => q[0] - p[0] || comparePointsDeCode(q[1], p[1]));
  return trouves.slice(0, n).map(([, x]) => x);
}
