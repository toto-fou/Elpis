// SPDX-License-Identifier: MIT
/** frontend/test/mascotte/accueil-boucle.test.ts — scène d'accueil : au repos, un dessin par image du sprite au lieu d'un par image d'écran ; hors de la vue, plus aucun dessin, reprise à son retour. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { montrerAccueil } from "../../src/features/mascotte/accueil";

let effacements = 0;
let signaler: (visible: boolean) => void = () => undefined;

beforeEach(() => {
  effacements = 0;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
  const contexte = new Proxy(
    {
      clearRect: () => void effacements++,
      createImageData: (l: number, h: number) => ({ data: new Uint8ClampedArray(l * h * 4) }),
      measureText: () => ({ width: 10 }),
    } as Record<string, unknown>,
    { get: (c, cle: string) => c[cle] ?? (() => undefined) },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(contexte as never);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(rappel: (e: { isIntersecting: boolean }[]) => void) {
        signaler = (visible) => rappel([{ isIntersecting: visible }]);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("scène d'accueil", () => {
  it("au repos, cinq dessins par seconde (cadence du sprite) ; hors de la vue, aucun", async () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const scene = montrerAccueil(hote, {
      scenario: "repos",
      intro: false,
      mouvement: "toujours",
      donnees: { anims: { idle: [["O"], ["D"]] } },
    });
    await scene.pret;
    signaler(true);
    vi.advanceTimersByTime(2500);
    const debut = effacements;
    vi.advanceTimersByTime(10_000);
    const parDixSecondes = effacements - debut;
    expect(parDixSecondes).toBeGreaterThanOrEqual(45);
    expect(parDixSecondes).toBeLessThanOrEqual(55);
    signaler(false);
    const cache = effacements;
    vi.advanceTimersByTime(5_000);
    expect(effacements).toBe(cache);
    signaler(true);
    vi.advanceTimersByTime(1_000);
    expect(effacements).toBeGreaterThan(cache);
    scene.detruire();
  });
});
