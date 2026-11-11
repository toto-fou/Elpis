// SPDX-License-Identifier: MIT
/** packages/commun/test/difflib.test.ts — opcodes, groupes, unified_diff et get_close_matches rejoués contre Python. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getCloseMatches, opcodes, opcodesGroupes, unifiedDiff } from "../src/difflib";

const V = JSON.parse(readFileSync(new URL("./vecteurs/difflib.json", import.meta.url), "utf-8")) as {
  diffs: {
    a: string[];
    b: string[];
    opcodes: unknown[];
    groupes: Record<string, unknown[]>;
    unifie: string[];
    sans_fin: { a: string[]; b: string[]; n0: string[] };
  }[];
  proches: { mot: string; possibles: string[]; n: number; seuil: number; sortie: string[] }[];
};

describe("SequenceMatcher et unified_diff (vecteurs)", () => {
  it.each(V.diffs.map((d, i) => [i, d] as const))("paire %i", (_i, d) => {
    expect(opcodes(d.a, d.b)).toEqual(d.opcodes);
    for (const [n, attendu] of Object.entries(d.groupes))
      expect(opcodesGroupes(d.a, d.b, Number(n))).toEqual(attendu);
    expect(unifiedDiff(d.a, d.b, { fromfile: "a/x.py", tofile: "b/x.py" })).toEqual(d.unifie);
    expect(unifiedDiff(d.sans_fin.a, d.sans_fin.b, { n: 0 })).toEqual(d.sans_fin.n0);
  });
});

describe("get_close_matches (vecteurs)", () => {
  it.each(V.proches.map((p) => [p.mot, p] as const))("%j", (_m, p) => {
    expect(getCloseMatches(p.mot, p.possibles, p.n, p.seuil)).toEqual(p.sortie);
  });
});
