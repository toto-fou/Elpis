// SPDX-License-Identifier: MIT
/** frontend/test/admin/periode.test.ts — la période commune vit en mémoire : un stockage en échec ou modifié ailleurs ne la change pas. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ecrirePeriode, lirePeriode } from "../../src/features/admin/periode";

afterEach(() => vi.unstubAllGlobals());

describe("période commune", () => {
  it("garde le choix quand l'écriture du stockage échoue, puis ignore un changement fait ailleurs", () => {
    const stockage = {
      getItem: () => "720",
      setItem: () => {
        throw new Error("quota plein");
      },
    };
    vi.stubGlobal("localStorage", stockage);
    expect(lirePeriode()).toBe(720);
    ecrirePeriode(168);
    expect(lirePeriode()).toBe(168);
    stockage.getItem = () => "24";
    expect(lirePeriode()).toBe(168);
  });
});
