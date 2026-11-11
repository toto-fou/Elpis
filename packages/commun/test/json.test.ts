// SPDX-License-Identifier: MIT
/** packages/commun/test/json.test.ts — `pyJsonDumps` et `canonicalJson` rejouent les vecteurs Python. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalJson, comparePointsDeCode, pyJsonDumps, reprFlottant } from "../src/json";
import type { OptionsDumps } from "../src/json";

interface OptionsPython {
  ensure_ascii?: boolean;
  sort_keys?: boolean;
  separators?: [string, string];
  indent?: number;
}

interface Cas {
  nom: string;
  entree: unknown;
  options: OptionsPython | "canonique";
  sortie: string;
}

const vecteurs = JSON.parse(readFileSync(new URL("./vecteurs/json.json", import.meta.url), "utf-8")) as {
  cas: Cas[];
};

function versOptions(o: OptionsPython): OptionsDumps {
  const options: OptionsDumps = {};
  if (o.ensure_ascii !== undefined) options.ensureAscii = o.ensure_ascii;
  if (o.sort_keys !== undefined) options.sortKeys = o.sort_keys;
  if (o.separators !== undefined) options.separators = o.separators;
  if (o.indent !== undefined) options.indent = o.indent;
  return options;
}

describe("vecteurs Python de json.dumps", () => {
  it("couvre tous les cas générés", () => {
    expect(vecteurs.cas.length).toBeGreaterThan(100);
  });

  for (const [i, cas] of vecteurs.cas.entries()) {
    const libelle = `${i} ${cas.nom} ${JSON.stringify(cas.options)}`;
    it(libelle, () => {
      const sortie =
        cas.options === "canonique"
          ? canonicalJson(cas.entree)
          : pyJsonDumps(cas.entree, versOptions(cas.options));
      expect(sortie).toBe(cas.sortie);
    });
  }
});

describe("pyJsonDumps hors vecteurs", () => {
  it("reprFlottant écrit repr(float), entier et zéro négatif compris", () => {
    const cas: [number, string][] = [
      [1, "1.0"],
      [0, "0.0"],
      [-0, "-0.0"],
      [1759780000, "1759780000.0"],
      [9999999999999998, "9999999999999998.0"],
      [1e16, "1e+16"],
      [1.2345678901234567e19, "1.2345678901234567e+19"],
      [0.0001, "0.0001"],
      [1e-5, "1e-05"],
      [-1.5, "-1.5"],
    ];
    for (const [x, attendu] of cas) expect(reprFlottant(x)).toBe(attendu);
  });

  it("écrit NaN et les infinis comme Python, ou refuse avec allowNan=false", () => {
    expect(pyJsonDumps([Number.NaN, Infinity, -Infinity])).toBe("[NaN, Infinity, -Infinity]");
    expect(() => pyJsonDumps(Number.NaN, { allowNan: false })).toThrow(RangeError);
  });

  it("écrit un grand entier en chiffres, comme un int Python", () => {
    expect(pyJsonDumps(1e21)).toBe("1000000000000000000000");
    expect(pyJsonDumps(12345678901234567890n)).toBe("12345678901234567890");
  });

  it("ignore une clé undefined et écrit null dans une liste, comme JSON.stringify", () => {
    expect(pyJsonDumps({ a: undefined, b: 1 })).toBe('{"b": 1}');
    expect(pyJsonDumps([undefined])).toBe("[null]");
    expect(() => pyJsonDumps(undefined)).toThrow(TypeError);
  });

  it("refuse une référence circulaire", () => {
    const a: Record<string, unknown> = {};
    a["moi"] = a;
    expect(() => pyJsonDumps(a)).toThrow(TypeError);
  });

  it("accepte une même valeur à deux endroits (pas une boucle)", () => {
    const partage = { x: 1 };
    expect(pyJsonDumps([partage, partage], { separators: [",", ":"] })).toBe('[{"x":1},{"x":1}]');
  });

  it("trie par point de code : un caractère astral passe après U+E000", () => {
    expect(["😀", "", "a"].sort(comparePointsDeCode)).toEqual(["a", "", "😀"]);
    expect(comparePointsDeCode("ab", "a")).toBeGreaterThan(0);
    expect(comparePointsDeCode("a", "a")).toBe(0);
  });
});
