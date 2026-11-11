// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/cache-lecture.test.ts — cache court de lecture : durée de vie, calcul partagé, erreurs non gardées, contournement, invalidation. */
import { describe, expect, it } from "vitest";

import { CacheLecture } from "../../src/observabilite/cache-lecture";

describe("CacheLecture", () => {
  it("garde la valeur jusqu'à l'échéance puis recalcule", async () => {
    let t = 0;
    let n = 0;
    const c = new CacheLecture<number>(1000, () => t);
    const calcul = async (): Promise<number> => ++n;
    expect(await c.lire("a", calcul)).toBe(1);
    t = 999;
    expect(await c.lire("a", calcul)).toBe(1);
    t = 1001;
    expect(await c.lire("a", calcul)).toBe(2);
  });

  it("partage le calcul en cours et n'en garde pas l'erreur", async () => {
    const c = new CacheLecture<number>(1000, () => 0);
    let n = 0;
    const lent = async (): Promise<number> => {
      n += 1;
      await new Promise((r) => setTimeout(r, 5));
      return n;
    };
    expect(await Promise.all([c.lire("a", lent), c.lire("a", lent)])).toEqual([1, 1]);
    await expect(
      c.lire("b", async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(await c.lire("b", async () => 7)).toBe(7);
  });

  it("frais ignore le gardé, invalider l'oublie, un calcul antérieur à l'oubli n'est pas gardé", async () => {
    const c = new CacheLecture<number>(1000, () => 0);
    let n = 0;
    const calcul = async (): Promise<number> => ++n;
    await c.lire("a", calcul);
    expect(await c.lire("a", calcul, true)).toBe(2);
    expect(await c.lire("a", calcul)).toBe(2);
    c.invalider();
    expect(await c.lire("a", calcul)).toBe(3);
    const enCours = c.lire("z", async () => 10);
    c.invalider();
    await enCours;
    expect(await c.lire("z", async () => 11)).toBe(11);
  });
});
