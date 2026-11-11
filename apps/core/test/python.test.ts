// SPDX-License-Identifier: MIT
/** apps/core/test/python.test.ts — aides texte et dict du moteur : Unicode de Python 3.13 vérifié point de code par point de code (vecteurs Python). */
import { describe, expect, it } from "vitest";

import { FlottantPy } from "../src/skills/frontmatter";
import {
  dictPy,
  entierPy,
  estChiffresPy,
  estDict,
  flottantPy,
  longueurPy,
  lowerPy,
  lstripPy,
  prefixePy,
  rstripPy,
  splitlinesPy,
  splitPy,
} from "../src/python";
import { lireVecteurs, rejouer } from "./vecteurs-moteur";
import type { Attendu } from "./vecteurs-moteur";

interface Vecteurs {
  unicode: string;
  decimaux: [number, number][];
  chiffres: [number, number][];
  minuscules: Record<string, string>;
  entiers: ({ texte: string } & Attendu)[];
  flottants: ({ texte: string } & Attendu)[];
  textes: {
    texte: string;
    splitlines: string[];
    split: string[];
    lstrip: string;
    rstrip: string;
    len: number;
    prefixe3: string;
    lower: string;
    isdigit: boolean;
  }[];
}

const v = lireVecteurs<Vecteurs>("unicode-python");

function dans(plages: [number, number][], code: number): boolean {
  return plages.some(([debut, fin]) => code >= debut && code <= fin);
}

describe(`vecteurs Python : Unicode ${v.unicode} de Python 3.13`, () => {
  it("isdigit, lower et chiffres de int() sur tous les points de code, quel que soit l'Unicode de Node", () => {
    const decimaux = new Set<number>();
    for (const [debut, fin] of v.decimaux) for (let c = debut; c <= fin; c++) decimaux.add(c);
    const chiffreNode = /^\p{Nd}$/u;
    const ecarts: string[] = [];
    for (let code = 0; code < 0x110000; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const c = String.fromCodePoint(code);
      if (estChiffresPy(c) !== dans(v.chiffres, code)) ecarts.push(`isdigit ${code.toString(16)}`);
      if (lowerPy(c) !== (v.minuscules[code.toString(16)] ?? c)) ecarts.push(`lower ${code.toString(16)}`);
      if (chiffreNode.test(c) && decimaux.has(code) !== Number.isFinite(entierOuNaN(c)))
        ecarts.push(`int ${code.toString(16)}`);
    }
    expect(ecarts).toEqual([]);
  });

  it("int() et float() refusent les chiffres ajoutés après Unicode 15.1", () => {
    for (const c of v.entiers) rejouer(() => entierPy(c.texte), c, `int(${JSON.stringify(c.texte)})`);
    for (const c of v.flottants) rejouer(() => flottantPy(c.texte), c, `float(${JSON.stringify(c.texte)})`);
  });

  it("splitlines, split, strip, len, tranche et lower sur des textes piégeux", () => {
    for (const t of v.textes) {
      const ctx = JSON.stringify(t.texte);
      expect(splitlinesPy(t.texte), ctx).toEqual(t.splitlines);
      expect(splitPy(t.texte), ctx).toEqual(t.split);
      expect(lstripPy(t.texte), ctx).toBe(t.lstrip);
      expect(rstripPy(t.texte), ctx).toBe(t.rstrip);
      expect(longueurPy(t.texte), ctx).toBe(t.len);
      expect(prefixePy(t.texte, 3), ctx).toBe(t.prefixe3);
      expect(lowerPy(t.texte), ctx).toBe(t.lower);
      expect(estChiffresPy(t.texte), ctx).toBe(t.isdigit);
    }
  });
});

function entierOuNaN(c: string): number {
  try {
    return entierPy(c);
  } catch {
    return Number.NaN;
  }
}

describe("dicts à la Python", () => {
  it("un dict est un objet simple : ni Map, ni tableau, ni instance de classe", () => {
    expect(estDict({})).toBe(true);
    expect(estDict(Object.create(null))).toBe(true);
    expect(estDict(JSON.parse('{"a": 1}'))).toBe(true);
    expect(estDict(new Map())).toBe(false);
    expect(estDict([])).toBe(false);
    expect(estDict(new FlottantPy(1))).toBe(false);
  });

  it("dict(x) : copie, Map, paires, erreurs de Python", () => {
    expect(dictPy({ a: 1 })).toEqual({ a: 1 });
    expect(dictPy(new Map([["k", 1]]))).toEqual({ k: 1 });
    expect(dictPy([["a", 1], "bc"])).toEqual({ a: 1, b: "c" });
    expect(() => dictPy([1])).toThrow(expect.objectContaining({ type: "TypeError" }));
    expect(() => dictPy(["abc"])).toThrow(expect.objectContaining({ type: "ValueError" }));
    expect(() => dictPy(new FlottantPy(1))).toThrow(expect.objectContaining({ type: "TypeError" }));
  });
});
