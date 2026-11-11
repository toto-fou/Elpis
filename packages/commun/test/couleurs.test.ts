// SPDX-License-Identifier: MIT
/** packages/commun/test/couleurs.test.ts — lecture des couleurs CSS, composition alpha, luminance et rapport WCAG. */
import { describe, expect, it } from "vitest";

import { analyse, melanger, rapport, sur, versCss } from "../src/couleurs";

describe("couleurs", () => {
  it("lit hex court, long et avec alpha", () => {
    expect(analyse("#fff")).toEqual([255, 255, 255, 1]);
    expect(analyse("#0f172a")).toEqual([15, 23, 42, 1]);
    expect(analyse("#00000080")?.[3]).toBeCloseTo(0.502, 2);
  });
  it("lit rgb, rgba, hsl et oklch", () => {
    expect(analyse("rgb(10, 20, 30)")).toEqual([10, 20, 30, 1]);
    expect(analyse("rgba(255 0 0 / 50%)")).toEqual([255, 0, 0, 0.5]);
    expect(analyse("hsl(0, 100%, 50%)")).toEqual([255, 0, 0, 1]);
    expect(analyse("hsla(120deg 100% 25% / .5)")).toEqual([0, 128, 0, 0.5]);
    expect(analyse("oklch(1 0 0)")).toEqual([255, 255, 255, 1]);
  });
  it("refuse ce qui n'est pas une couleur", () => {
    expect(analyse("red")).toBeNull();
    expect(analyse("var(--x)")).toBeNull();
    expect(analyse(undefined)).toBeNull();
  });
  it("rapport WCAG : noir sur blanc 21, identique 1", () => {
    expect(rapport([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(rapport([9, 9, 9, 1], [9, 9, 9, 1])).toBeCloseTo(1, 5);
  });
  it("compose l'alpha sur le fond et mélange", () => {
    expect(sur([0, 0, 0, 0.5], [255, 255, 255, 1])).toEqual([127.5, 127.5, 127.5, 1]);
    expect(melanger([0, 0, 0, 1], [100, 100, 100, 1], 0.5)).toEqual([50, 50, 50, 1]);
    expect(versCss([15, 23, 42, 1])).toBe("#0f172a");
    expect(versCss([255, 255, 255, 0.1])).toBe("rgba(255, 255, 255, 0.1)");
  });
});
