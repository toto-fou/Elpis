// SPDX-License-Identifier: MIT
/** packages/commun/test/json-lecture.test.ts — pyJsonLoads relu puis réécrit comme json.loads + json.dumps de Python. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { copieDict, copieProfondePy, iterPy, poserCle } from "../src/dict";
import { FlottantPy, pyJsonDumps, versFlottantPy } from "../src/json";
import {
  decoderJsonPy,
  ErreurJsonPy,
  ErreurLecturePy,
  pyJsonLoads,
  pyJsonLoadsOctets,
} from "../src/json-lecture";
import { clesOrdonnees } from "../src/ordre";
import { floatPy, intPy, reprPy, veritePy } from "../src/python";

const V = JSON.parse(readFileSync(new URL("./vecteurs/json_lecture.json", import.meta.url), "utf-8")) as {
  cas: { texte: string; relu?: string; erreur?: string }[];
  ordre: { texte: string; relu: string; indente: string; modifie: string }[];
};

/** ValueError de Python : JSONDecodeError (ErreurJsonPy) ou entier de plus de 4300 chiffres (ErreurLecturePy). */
function erreurValeur(f: () => unknown): boolean {
  try {
    f();
    return false;
  } catch (e) {
    return e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature === "ValueError");
  }
}

describe("json.loads puis json.dumps (vecteurs)", () => {
  it.each(V.cas.map((c, i) => [i, c] as const))("cas %i", (_i, c) => {
    if (c.relu !== undefined) expect(pyJsonDumps(pyJsonLoads(c.texte), { ensureAscii: false })).toBe(c.relu);
    else expect(erreurValeur(() => pyJsonLoads(c.texte))).toBe(true);
  });
});

describe("valeurs relues", () => {
  it("entiers exacts, flottants entiers ou non finis marqués, clé __proto__ propre", () => {
    expect(pyJsonLoads("1")).toBe(1);
    expect(pyJsonLoads("2.5")).toBe(2.5);
    expect(pyJsonLoads("18446744073709551616")).toBe(18446744073709551616n);
    expect(pyJsonLoads("1.0")).toEqual(new FlottantPy(1));
    expect(Number.isNaN((pyJsonLoads("NaN") as FlottantPy).valeur)).toBe(true);
    const o = pyJsonLoads('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(Object.keys(o)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(JSON.stringify(pyJsonLoads('{"a": 1.0}'))).toBe('{"a":1.0}');
  });

  it("vérité, int(), float() et repr() d'un FlottantPy comme ceux de Python", () => {
    expect([
      veritePy(new FlottantPy(0)),
      veritePy(new FlottantPy(-0)),
      veritePy(new FlottantPy(NaN)),
    ]).toEqual([false, false, true]);
    expect([intPy(new FlottantPy(2.0)), floatPy(new FlottantPy(3.0))]).toEqual([2, 3]);
    expect([
      reprPy(new FlottantPy(1)),
      reprPy(new FlottantPy(-Infinity)),
      reprPy([new FlottantPy(NaN)]),
    ]).toEqual(["1.0", "-inf", "[nan]"]);
    expect(() => pyJsonDumps(new FlottantPy(NaN), { allowNan: false })).toThrow(RangeError);
    expect([1, -0, 1e16, 1.5e-5, 0.1, NaN, -Infinity].map((x) => `${new FlottantPy(x)}`)).toEqual([
      "1.0",
      "-0.0",
      "1e+16",
      "1.5e-05",
      "0.1",
      "nan",
      "-inf",
    ]);
    expect(new FlottantPy(2.5).valueOf() * 2).toBe(5);
  });
});

describe("un seul json.loads, trois modes", () => {
  it("« valeurs » par défaut : FlottantPy, bigint, objets ordinaires", () => {
    expect(pyJsonLoads("[1.0, 9007199254740993]", { mode: "valeurs" })).toEqual(
      pyJsonLoads("[1.0, 9007199254740993]"),
    );
    expect(pyJsonLoads("[1.0, 9007199254740993]")).toEqual([new FlottantPy(1), 9007199254740993n]);
  });

  it("« corps » : erreurs du scanner C, objets sans prototype, ordre Python des clés entières", () => {
    const o = pyJsonLoads('{"b": 1, "1": [1.0, -0], "c": NaN}', { mode: "corps" }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(clesOrdonnees(o)).toEqual(["b", "1", "c"]);
    expect(o["1"]).toEqual([1, 0]);
    expect(Object.is((o["1"] as number[])[1], 0)).toBe(true);
    expect(Number.isNaN(o["c"])).toBe(true);
    const mauvais = () => pyJsonLoads('{"a":\n 1,}', { mode: "corps" });
    expect(mauvais).toThrow(ErreurJsonPy);
    expect(mauvais).toThrow("Illegal trailing comma before end of object: line 2 column 3 (char 8)");
    expect(() => pyJsonLoads("[".repeat(10_000), { mode: "corps" })).toThrow(ErreurLecturePy);
    expect(pyJsonLoadsOctets(new TextEncoder().encode('{"\u00e9": "é"}'))).toEqual(
      pyJsonLoads('{"\u00e9": "é"}', { mode: "corps" }),
    );
  });

  it("« natif » : objets de JSON.parse, NaN et ±Infinity par l'analyseur de repli", () => {
    const o = pyJsonLoads('{"a": [NaN, -Infinity], "b": 1.0}', { mode: "natif" }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(o).toEqual({ a: [Number.NaN, -Infinity], b: 1 });
    expect(() => pyJsonLoads("{,}", { mode: "natif" })).toThrow(SyntaxError);
  });
});

describe("ordre Python des clés entières : relu, réécrit, modifié (vecteurs)", () => {
  const modes = ["valeurs", "corps", "natif"] as const;
  it.each(modes.flatMap((mode) => V.ordre.map((c, i) => [mode, i, c] as const)))(
    "%s, cas %i",
    (mode, _i, c) => {
      const d = pyJsonLoads(c.texte, { mode }) as Record<string, unknown>;
      expect(pyJsonDumps(d, { ensureAscii: false })).toBe(c.relu);
      expect(pyJsonDumps(d, { ensureAscii: false, indent: 2 })).toBe(c.indente);
      const copie = copieProfondePy(d);
      expect(pyJsonDumps(copie, { ensureAscii: false, indent: 2 })).toBe(c.indente);
      poserCle(copie, "5", "e");
      poserCle(copie, "c", "t");
      delete copie[clesOrdonnees(copie)[0] ?? ""];
      expect(pyJsonDumps(copie, { ensureAscii: false })).toBe(c.modifie);
      expect(pyJsonDumps(d, { ensureAscii: false })).toBe(c.relu);
    },
  );

  it("« natif » : un très grand tableau ne déborde pas la pile en cherchant une clé entière", () => {
    const texte = `{"t": [${"0,".repeat(300_000)}0], "a": "1x", "2": 3}`;
    const d = pyJsonLoads(texte, { mode: "natif" }) as Record<string, unknown>;
    expect(clesOrdonnees(d)).toEqual(["t", "a", "2"]);
    expect((d["t"] as unknown[]).length).toBe(300_001);
  });

  it("une clé posée sans poserCle va après l'ordre retenu ; sortKeys l'ignore", () => {
    const d = pyJsonLoads('{"b": 1, "2": 2}') as Record<string, unknown>;
    d["1"] = 3;
    expect(pyJsonDumps(d)).toBe('{"b": 1, "2": 2, "1": 3}');
    expect(pyJsonDumps(d, { sortKeys: true })).toBe('{"1": 3, "2": 2, "b": 1}');
  });
});

describe("flottants et ordre au-delà de pyJsonDumps", () => {
  it("JSON.stringify écrit un FlottantPy comme repr (1.0, 1e+16) ; non fini, null comme avant", () => {
    expect(
      JSON.stringify({ a: new FlottantPy(1), b: new FlottantPy(1e16), c: new FlottantPy(-0), d: 2.5 }),
    ).toBe('{"a":1.0,"b":1e+16,"c":-0.0,"d":2.5}');
    expect(JSON.stringify([new FlottantPy(Number.NaN), new FlottantPy(-Infinity)])).toBe("[null,null]");
    expect(versFlottantPy(3)).toEqual(new FlottantPy(3));
    expect(versFlottantPy(Infinity)).toEqual(new FlottantPy(Infinity));
    expect(versFlottantPy(2.5)).toBe(2.5);
  });

  it("clé supprimée puis reposée : dernière place, comme un dict ; copieDict et iterPy suivent l'ordre Python", () => {
    const d = pyJsonLoads('{"b": 1, "2": 2, "a": 3}') as Record<string, unknown>;
    delete d["b"];
    poserCle(d, "b", 4);
    expect(clesOrdonnees(d)).toEqual(["2", "a", "b"]);
    expect(Object.keys(copieDict(d))).toEqual(["2", "a", "b"]);
    expect(clesOrdonnees(copieDict(d))).toEqual(["2", "a", "b"]);
    expect(iterPy(d)).toEqual(["2", "a", "b"]);
    const grand: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) poserCle(grand, i % 2 ? `k${i}` : String(i), i);
    expect(clesOrdonnees(grand).slice(0, 3)).toEqual(["0", "k1", "2"]);
  });
});

describe("mode « valeurs » rapide, repli itératif et écriture sans limite de pile", () => {
  it("JSON.parse avec la source des nombres = décodeur itératif, sur tous les textes valides des vecteurs", () => {
    for (const c of V.cas.filter((x) => x.relu !== undefined)) {
      const rapide = pyJsonLoads(c.texte);
      expect(pyJsonDumps(rapide, { ensureAscii: false }), c.texte).toBe(
        pyJsonDumps(decoderJsonPy(c.texte, true), { ensureAscii: false }),
      );
    }
    const o = pyJsonLoads('{"b": [1.0, 9007199254740993, -0, -0.0, 1e400], "c": {}}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(o["b"]).toEqual([
      new FlottantPy(1),
      9007199254740993n,
      0,
      new FlottantPy(-0),
      new FlottantPy(Infinity),
    ]);
  });

  it("imbrication : 9994 niveaux relus et réécrits, au-delà RecursionError comme json.loads", () => {
    const profond = (n: number): string => "[".repeat(n) + "1.0" + "]".repeat(n);
    const v = pyJsonLoads(profond(9994));
    expect(pyJsonDumps(v, { separators: [",", ":"] })).toBe(profond(9994));
    expect(() => pyJsonLoads(profond(9995))).toThrow(ErreurLecturePy);
    let tres: unknown = 1;
    for (let i = 0; i < 50_000; i++) tres = { a: [tres] };
    expect(pyJsonDumps(tres).length).toBe(50_000 * 9 + 1);
  });

  it("échappements rapides identiques à la boucle de Python, ensure_ascii ou non", () => {
    const textes = [
      "",
      'a"b\\c',
      "\u0000\u001f\u007f\u0080é\u2028\u{1f600}",
      "x\ud800y",
      "\udc00",
      "\b\f\n\r\t/",
    ];
    const attendus = [
      ['""', '""'],
      ['"a\\"b\\\\c"', '"a\\"b\\\\c"'],
      [
        '"\\u0000\\u001f\\u007f\\u0080\\u00e9\\u2028\\ud83d\\ude00"',
        '"\\u0000\\u001f\u007f\u0080é\u2028\u{1f600}"',
      ],
      ['"x\\ud800y"', '"x\ud800y"'],
      ['"\\udc00"', '"\udc00"'],
      ['"\\b\\f\\n\\r\\t/"', '"\\b\\f\\n\\r\\t/"'],
    ];
    textes.forEach((t, i) => {
      expect(pyJsonDumps(t), t).toBe(attendus[i]?.[0]);
      expect(pyJsonDumps(t, { ensureAscii: false }), t).toBe(attendus[i]?.[1]);
    });
  });
});
