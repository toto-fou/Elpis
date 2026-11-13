// SPDX-License-Identifier: MIT
/** frontend/test/platform/repos.test.ts — file de fond au repos prolongé : rien avant le calme, une tranche par rappel, reportée par un geste ou un flux. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function charger() {
  vi.resetModules();
  return import("../../src/platform/repos");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("requestIdleCallback", (f: () => void) => setTimeout(f, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("repos prolongé", () => {
  it("attend le calme, puis lance les tranches dans l'ordre, chacune dans sa propre tâche", async () => {
    const { auReposProlonge, CALME_MS } = await charger();
    const faites: string[] = [];
    auReposProlonge(
      () => {
        faites.push("a");
        queueMicrotask(() => faites.push("fin de la tâche a"));
      },
      () => faites.push("b"),
    );
    await vi.advanceTimersByTimeAsync(CALME_MS - 100);
    expect(faites).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(faites).toEqual(["a", "fin de la tâche a", "b"]);
  });

  it("une frappe reporte la tranche suivante au prochain calme", async () => {
    const { auReposProlonge, CALME_MS } = await charger();
    const faites: number[] = [];
    auReposProlonge(() => faites.push(1));
    await vi.advanceTimersByTimeAsync(CALME_MS - 1000);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(CALME_MS - 500);
    expect(faites).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(faites).toEqual([1]);
  });

  it("rien pendant un flux ; la tranche suivante attend la fin de la précédente", async () => {
    const { auReposProlonge, definirOccupation, CALME_MS } = await charger();
    let flux = true;
    definirOccupation(() => flux);
    const faites: string[] = [];
    let finir = (): void => undefined;
    auReposProlonge(
      () =>
        new Promise<void>((ok) => {
          faites.push("longue");
          finir = ok;
        }),
      () => faites.push("suite"),
    );
    await vi.advanceTimersByTimeAsync(CALME_MS * 3);
    expect(faites).toEqual([]);
    flux = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(faites).toEqual(["longue"]);
    await vi.advanceTimersByTimeAsync(CALME_MS);
    expect(faites).toEqual(["longue"]);
    finir();
    await vi.advanceTimersByTimeAsync(100);
    expect(faites).toEqual(["longue", "suite"]);
  });

  it("une tranche qui échoue n'arrête pas la file", async () => {
    const { auReposProlonge, CALME_MS } = await charger();
    const faites: string[] = [];
    auReposProlonge(
      () => Promise.reject(new Error("réseau")),
      () => faites.push("suite"),
    );
    await vi.advanceTimersByTimeAsync(CALME_MS + 500);
    expect(faites).toEqual(["suite"]);
  });
});
