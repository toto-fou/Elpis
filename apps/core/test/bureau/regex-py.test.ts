// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/regex-py.test.ts — `re.search` et `re.escape` de Python rejoués sur la traduction RegExp. */
import { describe, expect, it } from "vitest";

import { chercherRe, compilerRe, echapperPy, ErreurRe, RegexNonGeree } from "@elpis/commun";
import { lireVecteurs } from "../vecteurs-moteur";

type Recherche = { motif: string; texte: string; valeur?: [number, number] | null; erreur?: string };
const { regex } = lireVecteurs<{
  regex: { recherches: Recherche[]; echappements: { texte: string; valeur: string }[] };
}>("bureau");

/** Motifs valides en Python que RegExp ne sait pas traduire ou rendre à l'identique (écarts assumés). */
const NON_TRADUITS = new Set(["\\N{LATIN SMALL LETTER E WITH ACUTE}", "(a)(?(1)b|c)"]);
/** Références arrière : JS les fait correspondre à vide si le groupe n'a pas participé et oublie les captures d'une itération à l'autre. */
const ECARTS = new Set(["(a)?b\\1", "(?:(a)|b)*\\1"]);

describe("re.search de Python", () => {
  it(`${regex.recherches.length} motifs : même position, même refus`, () => {
    expect(regex.recherches.length).toBeGreaterThan(200);
    for (const r of regex.recherches) {
      const contexte = `${JSON.stringify(r.motif)} sur ${JSON.stringify(r.texte)}`;
      if (NON_TRADUITS.has(r.motif)) {
        expect(() => compilerRe(r.motif), contexte).toThrow(RegexNonGeree);
        continue;
      }
      if (ECARTS.has(r.motif)) continue;
      if (r.erreur !== undefined) {
        let levee: unknown = null;
        try {
          chercherRe(r.motif, r.texte);
        } catch (e) {
          levee = e;
        }
        expect(levee, contexte).toBeInstanceOf(Error);
        expect(levee instanceof ErreurRe ? "error" : (levee as Error).name, contexte).toBe(r.erreur);
        continue;
      }
      expect(chercherRe(r.motif, r.texte), contexte).toEqual(r.valeur);
    }
  });

  it("références arrière : groupe absent ou capture d'une itération précédente (écarts connus)", () => {
    expect(chercherRe("(a)?b\\1", "b")).toEqual([0, 1]);
    expect(chercherRe("(?:(a)|b)*\\1", "aba")).toEqual([0, 2]);
  });

  it("une erreur de motif est une ErreurRe ; un motif est compilé une fois", () => {
    expect(() => compilerRe("(")).toThrow(ErreurRe);
    expect(compilerRe("a+b")).toBe(compilerRe("a+b"));
  });
});

describe("re.escape de Python", () => {
  it("mêmes caractères échappés", () => {
    for (const e of regex.echappements) expect(echapperPy(e.texte), e.texte).toBe(e.valeur);
  });
});
