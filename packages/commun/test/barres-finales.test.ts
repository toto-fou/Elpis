// SPDX-License-Identifier: MIT
/** packages/commun/test/barres-finales.test.ts — `sansBarresFinales` : cas usuels et entrée pathologique en temps linéaire. */
import { describe, expect, it } from "vitest";

import { sansBarresAuxBouts, sansBarresFinales } from "../src/url";

describe("sansBarresFinales", () => {
  it("retire les barres finales seulement", () => {
    expect(sansBarresFinales("http://h:1/")).toBe("http://h:1");
    expect(sansBarresFinales("http://h:1///")).toBe("http://h:1");
    expect(sansBarresFinales("http://h/a/b")).toBe("http://h/a/b");
    expect(sansBarresFinales("//a//b/")).toBe("//a//b");
    expect(sansBarresFinales("///")).toBe("");
    expect(sansBarresFinales("")).toBe("");
  });

  it("reste linéaire sur 100 000 barres suivies d'un caractère", () => {
    const t0 = performance.now();
    const r = sansBarresFinales(`${"/".repeat(100_000)}x`);
    expect(r.length).toBe(100_001);
    expect(sansBarresFinales("x" + "/".repeat(100_000))).toBe("x");
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("sansBarresAuxBouts", () => {
  it("retire les barres des deux bouts seulement", () => {
    expect(sansBarresAuxBouts("/a/b/")).toBe("a/b");
    expect(sansBarresAuxBouts("///a//b///")).toBe("a//b");
    expect(sansBarresAuxBouts("a")).toBe("a");
    expect(sansBarresAuxBouts("///")).toBe("");
    expect(sansBarresAuxBouts("/")).toBe("");
    expect(sansBarresAuxBouts("")).toBe("");
  });

  it("reste linéaire sur 100 000 barres entre deux lettres", () => {
    const t0 = performance.now();
    const r = sansBarresAuxBouts(`a${"/".repeat(100_000)}b`);
    expect(r.length).toBe(100_002);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
