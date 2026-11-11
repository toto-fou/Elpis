// SPDX-License-Identifier: MIT
/** packages/commun/test/python.test.ts — int(), float(), bool(), str(), repr(), strip(), max() et min() rejouent les vecteurs Python. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ErreurPython, floatPy, intPy, maxPy, minPy, reprPy, stripPy, strPy, veritePy } from "../src/python";

interface Cas {
  entree: unknown;
  sortie?: unknown;
  erreur?: string;
}

type Table = "int" | "float" | "verite" | "str" | "repr" | "strip" | "max" | "min";

const vecteurs = JSON.parse(
  readFileSync(new URL("./vecteurs/python.json", import.meta.url), "utf-8"),
) as Record<Table, Cas[]>;

const FLOTTANTS: Readonly<Record<string, number>> = { nan: Number.NaN, inf: Infinity, "-inf": -Infinity };

/** `{"$flottant": "nan"}` redevient NaN (le JSON strict n'a pas de flottant non fini). */
function decoder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decoder);
  if (v !== null && typeof v === "object") {
    const special = (v as Record<string, unknown>)["$flottant"];
    if (typeof special === "string") return FLOTTANTS[special];
    return Object.fromEntries(Object.entries(v).map(([cle, valeur]) => [cle, decoder(valeur)]));
  }
  return v;
}

const FONCTIONS: Readonly<Record<Table, (entree: unknown) => unknown>> = {
  int: intPy,
  float: floatPy,
  verite: veritePy,
  str: strPy,
  repr: reprPy,
  strip: (s) => stripPy(s as string),
  max: (xs) => maxPy(...(xs as [number, ...number[]])),
  min: (xs) => minPy(...(xs as [number, ...number[]])),
};

describe("vecteurs Python des primitives", () => {
  for (const table of Object.keys(FONCTIONS) as Table[]) {
    it(`${table} : ${vecteurs[table].length} cas`, () => {
      expect(vecteurs[table].length).toBeGreaterThan(8);
      for (const cas of vecteurs[table]) {
        const appel = (): unknown => FONCTIONS[table](decoder(cas.entree));
        const libelle = `${table}(${JSON.stringify(cas.entree).slice(0, 80)})`;
        if (cas.erreur !== undefined) {
          expect(appel, libelle).toThrow(ErreurPython);
          try {
            appel();
          } catch (e) {
            expect((e as ErreurPython).type, libelle).toBe(cas.erreur);
          }
        } else {
          expect(appel(), libelle).toEqual(decoder(cas.sortie));
        }
      }
    });
  }
});

describe("primitives hors vecteurs", () => {
  it("int() rend 0 et non -0 pour un flottant négatif tronqué", () => {
    expect(Object.is(intPy(-0.5), 0)).toBe(true);
    expect(Object.is(intPy("-0"), 0)).toBe(true);
  });

  it("float() garde -0.0", () => {
    expect(Object.is(floatPy("-0"), -0)).toBe(true);
  });

  it("une longue suite de blancs ne coûte qu'un passage", () => {
    const blancs = " ".repeat(200_000);
    expect(stripPy(`${blancs}a${blancs}`)).toBe("a");
    expect(() => floatPy(`1${blancs}x`)).toThrow(ErreurPython);
    expect(() => intPy(`1${blancs}x`)).toThrow(ErreurPython);
  });

  it("ErreurPython porte le nom de la classe Python", () => {
    const e = new ErreurPython("AttributeError", "x");
    expect(e.name).toBe("AttributeError");
    expect(e).toBeInstanceOf(Error);
  });
});
