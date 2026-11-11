// SPDX-License-Identifier: MIT
/** packages/commun/test/python-texte.test.ts — tranches et recherches en points de code, isinstance(int) et « non vide » rejoués contre Python. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cleHashPy, ErreurCle } from "../src/dict";
import { formatPy } from "../src/format";
import { FlottantPy } from "../src/json";
import { pyJsonLoads } from "../src/json-lecture";
import {
  ErreurPython,
  estAlnumPy,
  estEntierPy,
  findPy,
  longueurPy,
  nonVidePy,
  prefixePy,
  rfindPy,
  splitPy,
  suffixePy,
} from "../src/python";

const V = JSON.parse(readFileSync(new URL("./vecteurs/python_texte.json", import.meta.url), "utf-8")) as {
  textes: {
    texte: string;
    suffixes: Record<string, string>;
    find: Record<string, number>;
    rfind: Record<string, number>;
  }[];
  valeurs: { valeur: unknown; flottant: boolean; entier: boolean; non_vide: boolean }[];
};

describe("s[-n:], find et rfind en points de code (vecteurs)", () => {
  it.each(V.textes.map((c) => [JSON.stringify(c.texte), c] as const))("%s", (_n, c) => {
    for (const [n, attendu] of Object.entries(c.suffixes))
      expect(suffixePy(c.texte, Number(n)), n).toBe(attendu);
    for (const [sous, attendu] of Object.entries(c.find)) expect(findPy(c.texte, sous), sous).toBe(attendu);
    for (const [sous, attendu] of Object.entries(c.rfind)) expect(rfindPy(c.texte, sous), sous).toBe(attendu);
  });
});

describe("isinstance(v, int) et v not in (None, '', [], {}) (vecteurs)", () => {
  it.each(V.valeurs.map((c) => [JSON.stringify(c.valeur), c] as const))("%s", (_n, c) => {
    const v = c.flottant ? new FlottantPy(Number(c.valeur)) : c.valeur;
    expect([estEntierPy(v), nonVidePy(v)]).toEqual([c.entier, c.non_vide]);
  });

  it("dict vide en Map ou sans prototype, bigint", () => {
    expect([nonVidePy(new Map()), nonVidePy(Object.create(null)), nonVidePy(new Map([["a", 1]]))]).toEqual([
      false,
      false,
      true,
    ]);
    expect(estEntierPy(2n ** 64n)).toBe(true);
  });
});

describe("points de code : chemins rapides", () => {
  it("longueurPy, prefixePy et suffixePy comme Array.from, demi-paires isolées comprises", () => {
    const textes = [
      "",
      "abc",
      "a\u{1f600}b",
      "\ud800x\udc00",
      "\u{1f600}\u{1f601}",
      "x\udbff",
      "\udc00\ud800",
    ];
    for (const t of textes) {
      const points = Array.from(t);
      expect(longueurPy(t), t).toBe(points.length);
      for (const n of [-3, -1, 0, 1, 2, 3, 10]) {
        expect(suffixePy(t, n), `${t} ${n}`).toBe(n === 0 ? t : points.slice(-n).join(""));
        if (n >= 0) expect(prefixePy(t, n), `${t} ${n}`).toBe(points.slice(0, n).join(""));
      }
    }
  });
});

describe("lettres et chiffres d'Unicode 15.1", () => {
  it("estAlnumPy écarte les ajouts d'Unicode 16 et 17 que connaît Node ; prefixePy(n < 0) = s[:n]", () => {
    expect(["a", "é", "٣", "²", "\u1c88", "_", "-", " "].map(estAlnumPy)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(["\u1c89", "\u{105c0}", "\u{323b0}"].map(estAlnumPy)).toEqual([false, false, false]);
    expect(prefixePy("ab\u{1f600}cd", -2)).toBe("ab\u{1f600}");
    expect(prefixePy("abc", -5)).toBe("");
  });
});

/** Mêmes vecteurs relus en valeurs Python (1.0, 2**64). */
const VP = pyJsonLoads(readFileSync(new URL("./vecteurs/python_texte.json", import.meta.url), "utf-8")) as {
  decoupes: { texte: string; sep: string | null; max: number; morceaux?: string[]; erreur?: string }[];
  formats: { gabarit: string; sortie?: string; erreur?: string; message?: string }[];
  cles: { valeurs: unknown[]; egales: number[][] };
};

describe("split, format et clés de dict (vecteurs)", () => {
  it("str.split(sep, maxsplit) : séparateur, blancs Unicode, reste après maxsplit, séparateur vide", () => {
    for (const c of VP.decoupes) {
      const appel = (): string[] => splitPy(c.texte, c.sep, c.max);
      if (c.erreur !== undefined) expect(appel, JSON.stringify(c)).toThrow(c.erreur);
      else expect(appel(), JSON.stringify(c)).toEqual(c.morceaux);
    }
  });

  it("str.format(**champs) : sorties et erreurs (type et message) de Python", () => {
    const champs = { username: "b\u00f6b\u{1f600}", root: "/srv/r" };
    for (const c of VP.formats) {
      let obtenu: { sortie?: string; erreur?: string; message?: string };
      try {
        obtenu = { sortie: formatPy(c.gabarit, champs) };
      } catch (e) {
        if (e instanceof ErreurPython) obtenu = { erreur: e.type, message: e.message };
        else if (e instanceof ErreurCle) obtenu = { erreur: "KeyError", message: e.message };
        else throw e;
      }
      expect({ gabarit: c.gabarit, ...obtenu }, c.gabarit).toEqual(c);
    }
  });

  it("égalité des clés de dict : True == 1 == 1.0, 0 == -0.0, 2**64 == float(2**64)", () => {
    const valeurs = VP.cles.valeurs;
    valeurs.forEach((a, i) => {
      const dict = new Map([[cleHashPy(a), 1]]);
      const egales = valeurs.flatMap((b, j) => (dict.has(cleHashPy(b)) ? [j] : []));
      expect(egales, String(a)).toEqual(VP.cles.egales[i]);
    });
    expect(() => cleHashPy([1])).toThrow(ErreurPython);
  });
});
