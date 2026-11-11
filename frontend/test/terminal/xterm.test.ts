// SPDX-License-Identifier: MIT
/** frontend/test/terminal/xterm.test.ts — chargement de xterm à la demande et terminal possédé : non réactif, libéré une fois. */
import { describe, expect, it, vi } from "vitest";
import { isReactive, reactive } from "vue";

const liberes: string[] = [];

vi.mock("../../src/features/terminal/xterm-module", () => ({
  Terminal: class {
    addons: unknown[] = [];
    loadAddon(a: unknown): void {
      this.addons.push(a);
    }
    dispose(): void {
      liberes.push("term");
    }
  },
  FitAddon: class {
    fit(): void {}
  },
}));

describe("xterm", () => {
  it("création refusée avant chargement, puis terminal et ajustement non réactifs, libération idempotente", async () => {
    const { chargerXterm, creerTerminal } = await import("../../src/features/terminal/xterm");
    expect(() => creerTerminal({})).toThrow(/non chargé/);
    const a = chargerXterm();
    expect(chargerXterm()).toBe(a);
    await a;
    const t = creerTerminal({ fontSize: 13 });
    const etat = reactive({ t: t.term });
    expect(isReactive(etat.t)).toBe(false);
    expect((t.term as unknown as { addons: unknown[] }).addons).toEqual([t.fitAddon]);
    t.liberer();
    t.liberer();
    expect(liberes).toEqual(["term"]);
  });
});
