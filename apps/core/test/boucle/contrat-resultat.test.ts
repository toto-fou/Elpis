// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/contrat-resultat.test.ts — échec d'un résultat d'outil et échec de l'outil lui-même (vecteurs Python). */
import { describe, expect, it } from "vitest";

import { resultIsError, resultIsToolFailure } from "../../src/boucle/contrat-resultat";
import { lireVecteurs } from "../vecteurs-moteur";

const v = lireVecteurs<{ cas: { entree: unknown; erreur: boolean; echec_outil: boolean }[] }>(
  "contrat-resultat",
);

describe("vecteurs Python de llm_core/engine/result_contract.py", () => {
  it("couvre tous les cas générés", () => {
    expect(v.cas.length).toBeGreaterThan(70);
  });

  it("même classement que json.loads de Python (NaN, Infinity, entiers de plus de 4 300 chiffres, doublons)", () => {
    for (const c of v.cas) {
      const contexte = JSON.stringify(c.entree)?.slice(0, 80) ?? String(c.entree);
      expect(resultIsError(c.entree), contexte).toBe(c.erreur);
      expect(resultIsToolFailure(c.entree), contexte).toBe(c.echec_outil);
    }
  });
});

describe("comportements des tests pytest", () => {
  it("contrat : enveloppe ok:false, filet « error » seul, le reste est un succès", () => {
    expect(resultIsError('{"ok": false, "error": "x"}')).toBe(true);
    expect(resultIsError('{"error": "x"}')).toBe(true);
    expect(resultIsError('{"error": "x", "hint": "y"}')).toBe(false);
    expect(resultIsError('{"results": [], "count": 0}')).toBe(false);
    expect(resultIsError("pas du JSON")).toBe(false);
    expect(resultIsError(null)).toBe(false);
    expect(resultIsError('["error"]')).toBe(false);
  });

  it("une commande au code de sortie non nul n'est pas un échec de l'outil", () => {
    const rc = '{"ok": false, "returncode": 1, "stdout": "", "stderr": "E"}';
    expect(resultIsError(rc)).toBe(true);
    expect(resultIsToolFailure(rc)).toBe(false);
    expect(resultIsToolFailure('{"ok": false, "returncode": 124, "error": "timeout"}')).toBe(true);
  });

  it("dernier résultat gardé : contrôles alternés et répétés toujours justes", () => {
    const echec = '{"ok": false, "error": "x"}';
    const succes = '{"ok": true}';
    for (const [r, attendu] of [
      [echec, true],
      [echec, true],
      [succes, false],
      [echec, true],
      ["texte libre", false],
      [succes, false],
    ] as const) {
      expect(resultIsError(r)).toBe(attendu);
      expect(resultIsToolFailure(r)).toBe(attendu);
    }
  });
});
