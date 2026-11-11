// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques/moteur-erreurs.test.ts — textes des exceptions du moteur (timedelta, floor, log10) identiques à CPython sur les valeurs extrêmes. */
import { ErreurPython } from "@elpis/commun";
import { describe, expect, it } from "vitest";

import { plancherLog10 } from "../../src/graphiques/moteur/py";
import { dureeJours } from "../../src/graphiques/moteur/temps";

function erreur(f: () => unknown): [string, string] {
  try {
    f();
  } catch (e) {
    if (e instanceof ErreurPython) return [e.type, e.message];
    throw e;
  }
  return ["", ""];
}

describe("exceptions du moteur aux valeurs extrêmes", () => {
  it("timedelta(days=…) : au-delà de 999999999 jours, puis au-delà d'un int C (mesuré sous Python 3.13)", () => {
    expect(erreur(() => dureeJours(999_999_999))).toEqual(["", ""]);
    expect(erreur(() => dureeJours(1_000_000_000))).toEqual([
      "OverflowError",
      "days=1000000000; must have magnitude <= 999999999",
    ]);
    expect(erreur(() => dureeJours(2_147_483_647))).toEqual([
      "OverflowError",
      "days=2147483647; must have magnitude <= 999999999",
    ]);
    expect(erreur(() => dureeJours(-2_147_483_648))).toEqual([
      "OverflowError",
      "days=-2147483648; must have magnitude <= 999999999",
    ]);
    for (const jours of [2_147_483_648, -2_147_483_649, 1e12, -1e12])
      expect(erreur(() => dureeJours(jours))).toEqual([
        "OverflowError",
        "Python int too large to convert to C int",
      ]);
  });

  it("timedelta(days=NaN|±inf) et math.floor(math.log10(inf)) disent NaN ou infinity", () => {
    expect(erreur(() => dureeJours(Number.NaN))).toEqual([
      "ValueError",
      "cannot convert float NaN to integer",
    ]);
    expect(erreur(() => dureeJours(Number.POSITIVE_INFINITY))).toEqual([
      "OverflowError",
      "cannot convert float infinity to integer",
    ]);
    expect(erreur(() => plancherLog10(Number.POSITIVE_INFINITY))).toEqual([
      "OverflowError",
      "cannot convert float infinity to integer",
    ]);
    expect(plancherLog10(1234)).toBe(3);
  });
});
