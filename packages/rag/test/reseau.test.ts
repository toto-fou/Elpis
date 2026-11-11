// SPDX-License-Identifier: MIT
/** packages/rag/test/reseau.test.ts — `sansBarresFinales` : même résultat que `rstrip("/")`, en temps linéaire. */
import { describe, expect, it } from "vitest";

import { sansBarresFinales } from "../src/reseau";

describe("sansBarresFinales", () => {
  it("retire toutes les barres finales et rien d'autre", () => {
    expect(sansBarresFinales("http://q///")).toBe("http://q");
    expect(sansBarresFinales("http://q")).toBe("http://q");
    expect(sansBarresFinales("http://q/a//b/")).toBe("http://q/a//b");
    expect(sansBarresFinales("//a")).toBe("//a");
    expect(sansBarresFinales("a/\n")).toBe("a/\n");
    expect(sansBarresFinales("")).toBe("");
    expect(sansBarresFinales("////")).toBe("");
  });

  it("longue suite de barres au milieu d'une URL en temps linéaire", () => {
    const debut = performance.now();
    const r = sansBarresFinales("/".repeat(60_000) + "x");
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(r.length).toBe(60_001);
    expect(sansBarresFinales("http://q" + "/".repeat(60_000))).toBe("http://q");
  });
});
