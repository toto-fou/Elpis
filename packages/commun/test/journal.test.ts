// SPDX-License-Identifier: MIT
/** packages/commun/test/journal.test.ts — journal des ports : stderr par défaut (niveaux de Python), un seul branchement. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { brancherJournal, journalDe, journalStderr } from "../src/journal";
import type { Journal } from "../src/journal";

afterEach(() => {
  brancherJournal(null);
  vi.restoreAllMocks();
});

describe("journal des ports", () => {
  it("stderr par défaut : niveau Python et domaine, debug muet", () => {
    const lignes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((t: string | Uint8Array) => {
      lignes.push(String(t));
      return true;
    });
    const j = journalStderr("essai");
    j.debug("rien");
    j.warn("attention", new Error("cause"));
    j.fatal("arrêt");
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z WARNING \[essai\] attention cause\n$/u);
    expect(lignes[1]).toMatch(/ CRITICAL \[essai\] arrêt\n$/u);
  });

  it("le journal branché sert tous les paquets ; null revient à stderr", () => {
    const vus: string[] = [];
    const fabrique = (domaine: string): Journal => ({
      debug: () => undefined,
      info: () => undefined,
      warn: (...a: unknown[]) => vus.push(`${domaine}:${a.join(" ")}`),
      error: () => undefined,
    });
    brancherJournal(fabrique);
    journalDe("mcp").warn("un");
    expect(vus).toEqual(["mcp:un"]);
    expect(journalDe("x").fatal).toBeUndefined();
    brancherJournal(null);
    expect(typeof journalDe("x").fatal).toBe("function");
  });
});
