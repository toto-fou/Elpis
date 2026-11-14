// SPDX-License-Identifier: MIT
/** apps/core/test/voix/securite-voix-borne.test.ts — texte à prononcer : entrée bornée avant toute regex, longues suites de blancs sans retour arrière, résultat inchangé sous la limite. */
import { describe, expect, it } from "vitest";

import { pourLaVoix } from "../../src/voix/texte";

const LIMITE = 8000;

describe("pourLaVoix", () => {
  it.each([
    ["Avant\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAprès", "Avant Tableau. Après"],
    ["  \n\n  | a |\n  |---|\n", "Tableau."],
    ["Titre\n\n\n---\n\nSuite", "Titre Suite"],
    ["Titre\n  \t\n***\nSuite", "Titre Suite"],
    ["12\n\n|---|\n%", "12 pour cent"],
    ["a   ->   b", "a vers b"],
    ["x -> -> y", "x vers vers y"],
    ["  --> z", "vers z"],
    ["a=>b\n\n=>c", "a vers b vers c"],
    [
      "Prix : 3 € & 4 $, soit 50 %. Voir [le site](http://x.y) et ![img](u).",
      "Prix : 3 euros et 4 dollars, soit 50 pour cent. Voir le site et.",
    ],
  ])("garde le résultat de %j", (entree, attendu) => {
    expect(pourLaVoix(entree, 0)).toBe(attendu);
  });

  it("garde un texte à la limite et ignore ce qui la dépasse", () => {
    const corps = "a".repeat(LIMITE - 4);
    expect(pourLaVoix(`${corps} fin`, 0)).toBe(`${corps} fin`);
    expect(pourLaVoix(`${corps} fin de trop`, 0)).toBe(`${corps} fin`);
  });

  it("compte les caractères sans couper un émoji en deux", () => {
    const sortie = pourLaVoix(`${"é".repeat(LIMITE - 1)}\u{10348}\u{10348}`, 0);
    expect(Array.from(sortie).length).toBe(LIMITE);
    expect(sortie.endsWith("\u{10348}")).toBe(true);
  });

  it("garde le plafond et la coupe à une fin de phrase", () => {
    const sortie = pourLaVoix("Phrase courte. ".repeat(2000), 200);
    expect(sortie.length).toBeLessThanOrEqual(200);
    expect(sortie.endsWith(".")).toBe(true);
  });

  it("ne bloque pas au-delà de la limite", () => {
    const debut = performance.now();
    expect(pourLaVoix(`${"\n".repeat(16_000)}x`, 4000)).toBe("");
    expect(performance.now() - debut).toBeLessThan(1000);
  });

  it("ne bloque pas sur de longues suites de blancs sous la limite", () => {
    const debut = performance.now();
    for (let i = 0; i < 5; i++) {
      expect(pourLaVoix(`${"\n".repeat(LIMITE - 1)}x`, 4000)).toBe("x");
      expect(pourLaVoix(`${" ".repeat(LIMITE - 1)}x`, 4000)).toBe("x");
    }
    expect(performance.now() - debut).toBeLessThan(1000);
  });
});
