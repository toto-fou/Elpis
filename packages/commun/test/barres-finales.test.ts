// SPDX-License-Identifier: MIT
/** packages/commun/test/barres-finales.test.ts — `sansBarresFinales` : cas usuels et entrée pathologique en temps linéaire. */
import { describe, expect, it } from "vitest";

import { sansBarresFinales } from "../src/url";

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
