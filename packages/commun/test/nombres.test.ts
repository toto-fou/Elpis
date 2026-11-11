// SPDX-License-Identifier: MIT
/** packages/commun/test/nombres.test.ts — `round()` et `f"{x:.nf}"` rejouent les vecteurs de Python. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { arrondiEntierPy, arrondiPy, fixePy } from "../src/nombres";

interface Cas {
  x: number;
  round0: number | null;
  fixe: Record<string, string>;
  round: Record<string, number>;
}

const { cas, debordements } = JSON.parse(
  readFileSync(new URL("./vecteurs/nombres.json", import.meta.url), "utf-8"),
) as {
  cas: Cas[];
  debordements: ({ x: number; n: number; sortie: number } | { x: number; n: number; erreur: string })[];
};

describe("vecteurs de round() et du format .nf", () => {
  it("couvre les moitiés exactes", () => {
    expect(cas.length).toBeGreaterThan(700);
  });
  for (const [i, c] of cas.entries()) {
    it(`${i} ${c.x}`, () => {
      if (c.round0 !== null) expect(arrondiEntierPy(c.x)).toBe(c.round0);
      for (const [n, attendu] of Object.entries(c.fixe))
        expect(fixePy(c.x, Number(n)), `.${n}f`).toBe(attendu);
      for (const [n, attendu] of Object.entries(c.round))
        expect(arrondiPy(c.x, Number(n)), `round(x, ${n})`).toBe(attendu);
    });
  }
  it("débordement : OverflowError comme Python", () => {
    for (const d of debordements) {
      if ("erreur" in d) expect(() => arrondiPy(d.x, d.n)).toThrow(RangeError);
      else expect(arrondiPy(d.x, d.n)).toBe(d.sortie);
    }
  });

  it("infinis et NaN", () => {
    expect(fixePy(Number.NaN, 2)).toBe("nan");
    expect(fixePy(-Infinity, 1)).toBe("-inf");
    expect(() => arrondiEntierPy(Infinity)).toThrow(RangeError);
    expect(arrondiPy(Infinity, 2)).toBe(Infinity);
  });
});
