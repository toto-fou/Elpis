// SPDX-License-Identifier: MIT
/** packages/commun/test/barres.test.ts — `rstripPy(s, "/")` et `stripPy(s, "/")` : mêmes résultats que les regex qu'ils remplacent, entrée pathologique en temps linéaire. */
import { describe, expect, it } from "vitest";

import { rstripPy, stripPy } from "../src/python";

/** Tous les textes de 0 à `n` caractères sur `alphabet`. */
function textes(alphabet: readonly string[], n: number): string[] {
  let niveau = [""];
  const tous = [""];
  for (let i = 0; i < n; i++) {
    niveau = niveau.flatMap((t) => alphabet.map((c) => t + c));
    tous.push(...niveau);
  }
  return tous;
}

describe("barres retirées sans regex", () => {
  it('rstripPy(s, "/") : barres finales seulement', () => {
    expect(rstripPy("http://h:1/", "/")).toBe("http://h:1");
    expect(rstripPy("http://h:1///", "/")).toBe("http://h:1");
    expect(rstripPy("http://h/a/b", "/")).toBe("http://h/a/b");
    expect(rstripPy("http://q/a//b/", "/")).toBe("http://q/a//b");
    expect(rstripPy("//a//b/", "/")).toBe("//a//b");
    expect(rstripPy("a/\n", "/")).toBe("a/\n");
    expect(rstripPy("///", "/")).toBe("");
    expect(rstripPy("", "/")).toBe("");
  });

  it('stripPy(s, "/") : barres des deux bouts seulement, blancs gardés', () => {
    expect(stripPy("/a/b/", "/")).toBe("a/b");
    expect(stripPy("///a//b///", "/")).toBe("a//b");
    expect(stripPy(" /a/ ", "/")).toBe(" /a/ ");
    expect(stripPy("a", "/")).toBe("a");
    expect(stripPy("///", "/")).toBe("");
    expect(stripPy("/", "/")).toBe("");
    expect(stripPy("", "/")).toBe("");
    expect(stripPy(" \t a \n")).toBe("a");
  });

  it("mêmes résultats que /\\/+$/ et /^\\/+|\\/+$/g sur tous les textes courts", () => {
    const ecarts = textes(["/", "a", "\n", "é", "\uD800", "\\", " "], 5).filter(
      (t) =>
        rstripPy(t, "/") !== t.replace(/\/+$/u, "") ||
        rstripPy(t, "/") !== t.replace(/\/+$/, "") ||
        stripPy(t, "/") !== t.replace(/^\/+|\/+$/gu, "") ||
        stripPy(t, "/") !== t.replace(/^\/+|\/+$/g, ""),
    );
    expect(ecarts).toEqual([]);
  });

  it("reste linéaire sur 100 000 barres", () => {
    const t0 = performance.now();
    expect(rstripPy(`${"/".repeat(100_000)}x`, "/").length).toBe(100_001);
    expect(rstripPy("x" + "/".repeat(100_000), "/")).toBe("x");
    expect(stripPy(`a${"/".repeat(100_000)}b`, "/").length).toBe(100_002);
    expect(stripPy("/".repeat(100_000) + "a" + "/".repeat(100_000), "/")).toBe("a");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
