// SPDX-License-Identifier: MIT
/** packages/securite/test/outils.test.ts — UTF-8 strict de Python, lecture d'un dict, `v or defaut`. */
import { describe, expect, it } from "vitest";

import { decoderUtf8Py, encoderUtf8Py, estAscii, getPy, ouPy } from "../src/outils";
import { essai } from "./aides";

describe("UTF-8 de Python", () => {
  it("refuse d'encoder une demi-paire au lieu d'écrire U+FFFD", () => {
    expect(() => encoderUtf8Py("a\ud800")).toThrow(/surrogates/);
    expect(encoderUtf8Py("é😀").toString("hex")).toBe("c3a9f09f9880");
  });

  it("décode strictement et garde le BOM dans le texte", () => {
    expect(decoderUtf8Py(Buffer.from("efbbbf41", "hex"))).toBe("\ufeffA");
    expect(essai(() => decoderUtf8Py(Buffer.from("eda080", "hex")))).toEqual({ erreur: "ValueError" });
    expect(essai(() => decoderUtf8Py(Buffer.from("c0af", "hex")))).toEqual({ erreur: "ValueError" });
  });

  it("estAscii s'arrête à U+007F", () => {
    expect(estAscii("abc\x7f")).toBe(true);
    expect(estAscii("\x80")).toBe(false);
  });
});

describe("dict de Python", () => {
  it("get ne lit que les propriétés propres", () => {
    const d = JSON.parse('{"__proto__": 1, "a": null}') as Record<string, unknown>;
    expect(getPy(d, "__proto__")).toBe(1);
    expect(getPy(d, "a")).toBeNull();
    expect(getPy({}, "constructor")).toBeNull();
    expect(getPy({}, "toString")).toBeNull();
  });

  it("`v or defaut` suit la vérité de Python", () => {
    expect(ouPy(0, "d")).toBe("d");
    expect(ouPy([], "d")).toBe("d");
    expect(ouPy(Number.NaN, "d")).toBeNaN();
    expect(ouPy("x", "d")).toBe("x");
  });
});
