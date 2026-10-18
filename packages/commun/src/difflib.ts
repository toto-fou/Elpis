// SPDX-License-Identifier: MIT
/** packages/commun/src/difflib.ts — `difflib.SequenceMatcher(None, a, b)` : plus longue correspondance, blocs communs, ratio, opcodes ; `unified_diff` et `get_close_matches`. */
import { comparePointsDeCode } from "./json";

/** `Match(a, b, size)` : `a[i:i+taille] == b[j:j+taille]`. */
export type Bloc = readonly [number, number, number];

/** `find_longest_match` : la plus longue, la plus à gauche dans `a` puis dans `b`. */
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

/** `get_matching_blocks()` : blocs triés, adjacents fusionnés, sentinelle `(len(a), len(b), 0)` en dernier ; `autojunk` retire de `b` (au moins 200 éléments) ceux qui y reviennent plus de `len(b) // 100 + 1` fois. */
export function blocsCorrespondants(a: readonly string[], b: readonly string[], autojunk = false): Bloc[] {
  const b2j = new Map<string, number[]>();
  b.forEach((x, j) => {
    const indices = b2j.get(x);
    if (indices) indices.push(j);
    else b2j.set(x, [j]);
  });
  if (autojunk && b.length >= 200) {
    const seuil = Math.floor(b.length / 100) + 1;
    for (const [x, indices] of [...b2j]) if (indices.length > seuil) b2j.delete(x);
  }
  const file: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const blocs: Bloc[] = [];
  for (let suivant = file.pop(); suivant !== undefined; suivant = file.pop()) {
    const [alo, ahi, blo, bhi] = suivant;
    const [i, j, k] = plusLongue(a, b, b2j, alo, ahi, blo, bhi);
    if (k === 0) continue;
    blocs.push([i, j, k]);
    if (alo < i && blo < j) file.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) file.push([i + k, ahi, j + k, bhi]);
  }
  blocs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const sortie: Bloc[] = [];
  let [i1, j1, k1] = [0, 0, 0];
  for (const [i2, j2, k2] of blocs) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else {
      if (k1) sortie.push([i1, j1, k1]);
      [i1, j1, k1] = [i2, j2, k2];
    }
  }
  if (k1) sortie.push([i1, j1, k1]);
  sortie.push([a.length, b.length, 0]);
  return sortie;
}

/** `SequenceMatcher(None, a, b).ratio()` : `2 * correspondances / (len(a) + len(b))`, 1.0 si les deux sont vides. */
export function ratio(a: readonly string[], b: readonly string[], autojunk: boolean): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  let correspondances = 0;
  for (const [, , taille] of blocsCorrespondants(a, b, autojunk)) correspondances += taille;
  return (2 * correspondances) / total;
}

/** Opcode `(tag, i1, i2, j1, j2)` de `get_opcodes`. */
export type Opcode = readonly ["replace" | "delete" | "insert" | "equal", number, number, number, number];

/** `get_opcodes()` : comment changer `a` en `b`, d'après les blocs communs. */
export function opcodes(a: readonly string[], b: readonly string[], autojunk = true): Opcode[] {
  let [i, j] = [0, 0];
  const sortie: Opcode[] = [];
  for (const [ai, bj, taille] of blocsCorrespondants(a, b, autojunk)) {
    if (i < ai && j < bj) sortie.push(["replace", i, ai, j, bj]);
    else if (i < ai) sortie.push(["delete", i, ai, j, bj]);
    else if (j < bj) sortie.push(["insert", i, ai, j, bj]);
    [i, j] = [ai + taille, bj + taille];
    if (taille) sortie.push(["equal", ai, i, bj, j]);
  }
  return sortie;
}

/** `get_grouped_opcodes(n)` : groupes de changements avec `n` lignes de contexte. */
export function opcodesGroupes(
  a: readonly string[],
  b: readonly string[],
  n = 3,
  autojunk = true,
): Opcode[][] {
  const codes: Opcode[] = opcodes(a, b, autojunk);
  if (!codes.length) codes.push(["equal", 0, 1, 0, 1]);
  const premier = codes[0] as Opcode;
  if (premier[0] === "equal") {
    const [t, i1, i2, j1, j2] = premier;
    codes[0] = [t, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  const dernier = codes[codes.length - 1] as Opcode;
  if (dernier[0] === "equal") {
    const [t, i1, i2, j1, j2] = dernier;
    codes[codes.length - 1] = [t, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
  }
  const groupes: Opcode[][] = [];
  let groupe: Opcode[] = [];
  for (const code of codes) {
    const [t, , i2, , j2] = code;
    let [, i1, , j1] = code;
    if (t === "equal" && i2 - i1 > n + n) {
      groupe.push([t, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groupes.push(groupe);
      groupe = [];
      [i1, j1] = [Math.max(i1, i2 - n), Math.max(j1, j2 - n)];
    }
    groupe.push([t, i1, i2, j1, j2]);
  }
  if (groupe.length && !(groupe.length === 1 && groupe[0]?.[0] === "equal")) groupes.push(groupe);
  return groupes;
}

function plageUnifiee(debut: number, fin: number): string {
  let commencement = debut + 1;
  const longueur = fin - debut;
  if (longueur === 1) return `${commencement}`;
  if (!longueur) commencement -= 1;
  return `${commencement},${longueur}`;
}

/** `difflib.unified_diff(a, b, fromfile, tofile, n=3, lineterm="\n")` : lignes du diff, en-têtes compris. */
export function unifiedDiff(
  a: readonly string[],
  b: readonly string[],
  o: { fromfile?: string; tofile?: string; n?: number; lineterm?: string } = {},
): string[] {
  const fin = o.lineterm ?? "\n";
  const sortie: string[] = [];
  for (const groupe of opcodesGroupes(a, b, o.n ?? 3)) {
    if (!sortie.length) sortie.push(`--- ${o.fromfile ?? ""}${fin}`, `+++ ${o.tofile ?? ""}${fin}`);
    const [premier, dernier] = [groupe[0] as Opcode, groupe[groupe.length - 1] as Opcode];
    sortie.push(
      `@@ -${plageUnifiee(premier[1], dernier[2])} +${plageUnifiee(premier[3], dernier[4])} @@${fin}`,
    );
    for (const [t, i1, i2, j1, j2] of groupe) {
      if (t === "equal") {
        for (const ligne of a.slice(i1, i2)) sortie.push(" " + ligne);
        continue;
      }
      if (t === "replace" || t === "delete") for (const ligne of a.slice(i1, i2)) sortie.push("-" + ligne);
      if (t === "replace" || t === "insert") for (const ligne of b.slice(j1, j2)) sortie.push("+" + ligne);
    }
  }
  return sortie;
}

/** `difflib.get_close_matches(word, possibilities, n, cutoff)` sur les points de code : les `n` meilleures, la plus proche d'abord. */
export function getCloseMatches(
  word: string,
  possibilities: readonly string[],
  n = 3,
  cutoff = 0.6,
): string[] {
  const b = Array.from(word);
  const trouves: [number, string][] = [];
  for (const x of possibilities) {
    const a = Array.from(x);
    if (a.length + b.length === 0) {
      if (cutoff <= 1) trouves.push([1, x]);
      continue;
    }
    if ((2 * Math.min(a.length, b.length)) / (a.length + b.length) < cutoff) continue;
    const r = ratio(a, b, true);
    if (r >= cutoff) trouves.push([r, x]);
  }
  trouves.sort((p, q) => q[0] - p[0] || comparePointsDeCode(q[1], p[1]));
  return trouves.slice(0, n).map(([, x]) => x);
}
