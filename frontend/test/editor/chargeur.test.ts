// SPDX-License-Identifier: MIT
/** frontend/test/editor/chargeur.test.ts — chargeur de Monaco : import unique, nouvel essai après un échec. */
import { describe, expect, it, vi } from "vitest";

const etat = vi.hoisted(() => ({ installs: 0, echecs: 0 }));

vi.mock("../../src/features/editor/monaco", () => ({
  installerMonaco: () => {
    if (etat.echecs > 0) {
      etat.echecs--;
      throw new Error("chunk indisponible");
    }
    etat.installs++;
    return { editor: {} };
  },
}));

const { chargerMonaco } = await import("../../src/features/editor/chargeur");

describe("chargeur de Monaco", () => {
  it("purge la mémoïsation après un échec puis importe une seule fois", async () => {
    etat.echecs = 1;
    await expect(chargerMonaco()).rejects.toThrow("chunk indisponible");
    const [a, b] = await Promise.all([chargerMonaco(), chargerMonaco()]);
    expect(a).toBe(b);
    await chargerMonaco();
    expect(etat.installs).toBe(1);
  });
});
