// SPDX-License-Identifier: MIT
/** frontend/test/editor/ecriture-modele.test.ts — écritures programmatiques : édition minimale par opérations (jamais `setValue`), plage rendue, filet de remplacement complet. */
import { describe, expect, it } from "vitest";

import { editionMinimale, remplacerContenu } from "../../src/features/editor/ecriture-modele";
import { FauxModele } from "./faux-modele";

describe("écritures programmatiques", () => {
  it("édition minimale : une opération sur les lignes changées, plage rendue, aucun setValue", () => {
    const m = new FauxModele("a\nb\nc\nd");
    expect(editionMinimale(m, m.getValue(), "a\nB\nC\nd")).toMatchObject({ startLine: 2, endLine: 3 });
    expect(m.getValue()).toBe("a\nB\nC\nd");
    expect(m.operations).toBe(1);
    expect(m.setValues).toBe(0);
    expect(editionMinimale(m, m.getValue(), m.getValue())).toBeNull();
  });

  it("base fausse fournie par l'appelant : le filet remplace tout le contenu, toujours par opérations", () => {
    const m = new FauxModele("réel");
    expect(editionMinimale(m, "supposé", "voulu")).not.toBeNull();
    expect(m.getValue()).toBe("voulu");
    expect(m.setValues).toBe(0);
    expect(remplacerContenu(m, "voulu")).toBe(true);
  });
});
