// SPDX-License-Identifier: MIT
/** frontend/test/line-diff.test.ts — hunks de lignes : ajouts, modifications, suppressions, blocs multiples, bornes. */
import { strict as assert } from "node:assert";
import { it } from "vitest";

import * as D from "../src/utils/line-diff";

const L = (s: string) => D.lines(s);

it("identiques : aucune marque", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb\nc"), L("a\nb\nc")), []);
  assert.deepStrictEqual(D.hunks([], []), []);
});

it("ajout au milieu", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb\nc"), L("a\nb\nX\nY\nc")), [{ type: "add", start: 3, end: 4 }]);
});

it("ajout en fin et en tête", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb"), L("a\nb\nc")), [{ type: "add", start: 3, end: 3 }]);
  assert.deepStrictEqual(D.hunks(L("a\nb"), L("z\na\nb")), [{ type: "add", start: 1, end: 1 }]);
});

it("modification d'une ligne", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb\nc"), L("a\nB\nc")), [{ type: "mod", start: 2, end: 2 }]);
});

it("suppression : marque posée sur la ligne qui suit", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb\nc\nd"), L("a\nd")), [{ type: "del", start: 2, end: 2 }]);
});

it("suppression en fin de fichier", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb\nc"), L("a\nb")), [{ type: "del", start: 3, end: 3 }]);
});

it("plusieurs blocs distincts", () => {
  const avant = L("1\n2\n3\n4\n5\n6\n7\n8");
  const apres = L("1\nDEUX\n3\n4\n4bis\n5\n6\n8");
  assert.deepStrictEqual(D.hunks(avant, apres), [
    { type: "mod", start: 2, end: 2 },
    { type: "add", start: 5, end: 5 },
    { type: "del", start: 8, end: 8 },
  ]);
});

it("fichier vidé / fichier neuf", () => {
  assert.deepStrictEqual(D.hunks(L("a\nb"), []), [{ type: "del", start: 1, end: 1 }]);
  assert.deepStrictEqual(D.hunks([], L("a\nb")), [{ type: "add", start: 1, end: 2 }]);
});

it("fins de ligne CRLF équivalentes à LF", () => {
  assert.deepStrictEqual(D.hunks(L("a\r\nb\r\n"), L("a\nb\n")), []);
});

it("matrice trop grosse : un seul bloc modifié, sans geler", () => {
  const big = Array.from({ length: 2500 }, (_, i) => "l" + i);
  const autre = Array.from({ length: 2500 }, (_, i) => "m" + i);
  const t0 = Date.now();
  const h = D.hunks(["tete"].concat(big, ["pied"]), ["tete"].concat(autre, ["pied"]));
  assert.ok(Date.now() - t0 < 500);
  assert.deepStrictEqual(h, [{ type: "mod", start: 2, end: 2501 }]);
});

it("chaque ligne de « après » est couverte au plus une fois", () => {
  for (let k = 0; k < 200; k++) {
    const rnd = (len: number) =>
      Array.from({ length: len }, () => "abcde".charAt(Math.floor(Math.random() * 5)));
    const a = rnd(Math.floor(Math.random() * 12)),
      b = rnd(Math.floor(Math.random() * 12));
    const seen = new Set();
    for (const h of D.hunks(a, b)) {
      assert.ok(h.start >= 1 && h.start <= b.length + 1, JSON.stringify({ a, b, h }));
      if (h.type === "del") continue;
      for (let i = h.start; i <= h.end; i++) {
        assert.ok(!seen.has(i), "ligne marquée deux fois");
        assert.ok(i <= b.length);
        seen.add(i);
      }
    }
  }
});
