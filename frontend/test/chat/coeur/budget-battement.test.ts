// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/budget-battement.test.ts — budget du battement : cadence selon le coût moyen (1 à 6 images), marge de redescente, plafond de 60 battements par seconde. */
import { describe, expect, it } from "vitest";

import { creerBudget, noterCout, sauterImage } from "../../../src/features/chat/coeur/budget-battement";

const IMAGE = 1000 / 60;

function cadenceApres(couts: number[]): number {
  const b = creerBudget();
  for (const c of couts) noterCout(b, c);
  return b.cadence;
}

/** Nombre de battements exécutés sur `images` images espacées de `pas` ms. */
function executes(b: ReturnType<typeof creerBudget>, images: number, pas: number): number {
  let n = 0;
  for (let k = 0; k < images; k++) if (!sauterImage(b, k * pas)) n++;
  return n;
}

describe("budget du battement", () => {
  it("sous 5 ms, un battement à chaque image", () => {
    expect(cadenceApres([1, 2, 3, 4, 5])).toBe(1);
    expect(executes(creerBudget(), 60, IMAGE)).toBe(60);
  });

  it("au-dessus de 5 ms, une image sur deux, puis sur trois, jusqu'à une sur six", () => {
    expect(cadenceApres([6, 6, 6, 6, 6, 6])).toBe(2);
    expect(cadenceApres([12, 12, 12, 12])).toBe(3);
    expect(cadenceApres([18, 18, 18, 18])).toBe(4);
    expect(cadenceApres([40, 40, 40, 40])).toBe(6);
    expect(cadenceApres([400, 400])).toBe(6);
  });

  it("à la cadence n, un battement sur n images", () => {
    for (const n of [2, 3, 4, 6]) {
      const b = creerBudget();
      b.cadence = n;
      expect(executes(b, 120, IMAGE)).toBe(120 / n);
    }
  });

  it("la cadence ne redescend qu'avec une marge sous le seuil", () => {
    const b = creerBudget();
    for (let k = 0; k < 8; k++) noterCout(b, 7);
    expect(b.cadence).toBe(2);
    b.moyenne = 4.5;
    noterCout(b, 4.5);
    expect(b.cadence).toBe(2);
    for (let k = 0; k < 20; k++) noterCout(b, 2);
    expect(b.cadence).toBe(1);
  });

  it("jamais plus de 60 battements par seconde, même sur un écran à 144 Hz", () => {
    expect(executes(creerBudget(), 144, 1000 / 144)).toBeLessThanOrEqual(62);
  });

  it("après une pause, le premier battement part tout de suite", () => {
    const b = creerBudget();
    b.cadence = 6;
    expect(sauterImage(b, 0)).toBe(false);
    expect(sauterImage(b, IMAGE)).toBe(true);
    expect(sauterImage(b, 5000)).toBe(false);
  });
});
