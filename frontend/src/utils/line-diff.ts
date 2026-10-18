// SPDX-License-Identifier: MIT
/** frontend/src/utils/line-diff.ts — hunks de lignes (add/mod/del, 1-indexés dans « après ») : préfixe/suffixe puis LCS bornée. */

export interface Hunk {
  type: "add" | "mod" | "del";
  start: number;
  end: number;
}

export const MAX_CELLS = 4000000;

export function hunks(avant?: readonly string[] | null, apres?: readonly string[] | null): Hunk[] {
  const a = avant ?? [];
  const b = apres ?? [];
  const n = a.length;
  const m = b.length;
  let top = 0;
  while (top < n && top < m && a[top] === b[top]) top++;
  let ea = n - 1;
  let eb = m - 1;
  while (ea >= top && eb >= top && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const A = a.slice(top, ea + 1);
  const B = b.slice(top, eb + 1);
  const out: Hunk[] = [];
  if (!A.length && !B.length) return out;
  if (!A.length) return [{ type: "add", start: top + 1, end: top + B.length }];
  if (!B.length) return [{ type: "del", start: top + 1, end: top + 1 }];
  if (A.length * B.length > MAX_CELLS) return [{ type: "mod", start: top + 1, end: top + B.length }];
  const N = A.length;
  const M = B.length;
  const W = M + 1;
  const dp = new Int32Array((N + 1) * W);
  const cell = (i: number, j: number): number => dp[i * W + j] ?? 0;
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  let ii = 0;
  let jj = 0;
  let del = 0;
  let add = 0;
  let blockStart = 0;
  const flush = (): void => {
    if (!del && !add) return;
    if (add && del) out.push({ type: "mod", start: top + blockStart + 1, end: top + blockStart + add });
    else if (add) out.push({ type: "add", start: top + blockStart + 1, end: top + blockStart + add });
    else out.push({ type: "del", start: top + blockStart + 1, end: top + blockStart + 1 });
    del = 0;
    add = 0;
  };
  while (ii < N || jj < M) {
    if (ii < N && jj < M && A[ii] === B[jj]) {
      flush();
      ii++;
      jj++;
      blockStart = jj;
    } else if (jj >= M || (ii < N && cell(ii + 1, jj) >= cell(ii, jj + 1))) {
      if (!del && !add) blockStart = jj;
      del++;
      ii++;
    } else {
      if (!del && !add) blockStart = jj;
      add++;
      jj++;
    }
  }
  flush();
  return out;
}

/** Découpe un texte en lignes (\n, \r\n ou \r). */
export function lines(text: unknown): string[] {
  return String(text == null ? "" : text).split(/\r\n|\r|\n/);
}
