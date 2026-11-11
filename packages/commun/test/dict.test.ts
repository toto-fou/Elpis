// SPDX-License-Identifier: MIT
/** packages/commun/test/dict.test.ts — dict à la Python : objet simple, get, [], in, itération, update et erreurs de Python. */
import { describe, expect, it } from "vitest";

import {
  dictPy,
  ErreurCle,
  estDict,
  getOu,
  getPy,
  inPy,
  itemPy,
  iterExige,
  iterPy,
  mettreAJourPy,
  nomTypePy,
  poserCle,
  texteNet,
  texteOu,
} from "../src/dict";
import { FlottantPy } from "../src/json";
import { lstripPy, rstripPy } from "../src/python";

const erreur = (type: string) => expect.objectContaining({ type });

describe("dict à la Python", () => {
  it("un dict est un objet simple : ni Map, ni tableau, ni instance (FlottantPy)", () => {
    expect([
      estDict({}),
      estDict(Object.create(null)),
      estDict(new Map()),
      estDict([]),
      estDict(new FlottantPy(1)),
    ]).toEqual([true, true, false, false, false]);
    expect([
      nomTypePy(null),
      nomTypePy(1),
      nomTypePy(1.5),
      nomTypePy(new FlottantPy(1)),
      nomTypePy(2n),
      nomTypePy({}),
    ]).toEqual(["NoneType", "int", "float", "float", "int", "dict"]);
  });

  it("get : valeur même nulle, défaut, AttributeError hors dict ; getOu tolère", () => {
    expect([getPy({ a: null }, "a", 1), getPy({}, "a", 1), getPy({}, "a")]).toEqual([null, 1, null]);
    expect(() => getPy([], "a")).toThrow(erreur("AttributeError"));
    expect(() => getPy(1, "a")).toThrow("'int' object has no attribute 'get'");
    expect([
      getOu([], "0", "d"),
      getOu({ constructor: 1 }, "constructor", 0),
      getOu({}, "constructor", 0),
    ]).toEqual(["d", 1, 0]);
  });

  it("[], in, itération, update, dict()", () => {
    expect(() => itemPy({}, "x")).toThrow(ErreurCle);
    expect(() => itemPy([], "x")).toThrow(erreur("TypeError"));
    expect(() => inPy("a", 1)).toThrow(erreur("TypeError"));
    expect([inPy("a", "bab"), inPy("a", ["a"]), inPy("a", { a: 1 })]).toEqual([true, true, true]);
    expect(iterPy(new Set([1, 2]))).toEqual([1, 2]);
    expect(iterExige("é😀")).toEqual(["é", "😀"]);
    expect(() => iterExige(1)).toThrow("'int' object is not iterable");
    const d: Record<string, unknown> = {};
    mettreAJourPy(d, [
      ["__proto__", 1],
      ["b", 2],
    ]);
    expect(Object.keys(d)).toEqual(["__proto__", "b"]);
    expect(() => mettreAJourPy(d, [["a"]])).toThrow(erreur("ValueError"));
    expect(dictPy([[true, 1]])).toEqual({ True: 1 });
    poserCle(d, "constructor", 3);
    expect(Object.hasOwn(d, "constructor")).toBe(true);
  });

  it("textes : str(v or défaut), strip, rstrip(caractères), lstrip(caractères)", () => {
    expect([texteOu(0, "x"), texteOu(5, "x"), texteNet("  a  "), texteNet(null)]).toEqual([
      "x",
      "5",
      "a",
      "",
    ]);
    expect([rstripPy("a/b//", "/"), rstripPy("a \t\x85"), rstripPy("xyx", "yx")]).toEqual(["a/b", "a", ""]);
    expect([
      lstripPy("//a/b/", "/"),
      lstripPy(" \t\x85a"),
      lstripPy("xyxa", "yx"),
      lstripPy("xyx", "yx"),
    ]).toEqual(["a/b/", "a", "a", ""]);
  });
});
