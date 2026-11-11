// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fs-regex.test.ts — motifs `re` de Python traduits en RegExp : erreurs, recherche, finditer et subn rejoués contre Python (vecteurs). */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  chercher,
  compilerPy,
  ErreurPyRe,
  ErreurRe,
  RE_IGNORECASE,
  RegexNonGeree,
  subn,
  trouverTout,
} from "@elpis/commun";

interface Cas {
  motif: string;
  flags: number;
  erreur?: { type: string; message: string };
  groupes?: number;
  textes?: {
    texte: string;
    search: { span: [number, number]; groupes: (string | null)[] } | null;
    spans: [number, number][];
    sub?: Record<string, [string, number] | { type: string; message: string }>;
    sub1: [string, number];
  }[];
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/fs-regex.json", import.meta.url), "utf-8")) as {
  cas: Cas[];
};

/** Écarts consignés : \N{…} et groupes conditionnels non pris en charge ; itération après une correspondance vide (JS avance d'un caractère, Python tente d'abord une correspondance non vide au même endroit). */
const NON_PRIS = new Set(["\\N{EM DASH}", "(a)(?(1)b|c)"]);

function enPoints(texte: string, i: number): number {
  return Array.from(texte.slice(0, i)).length;
}

function erreurDe(f: () => unknown): { type: string; message: string } | null {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof ErreurRe) return { type: "error", message: e.message };
    if (e instanceof ErreurPyRe) return { type: e.name, message: e.message };
    throw e;
  }
}

function adjacentVide(c: Cas): boolean {
  return (c.textes ?? []).some((t) => {
    const s = t.spans;
    return s.some(
      (x, i) => i > 0 && x[0] === x[1] && s[i - 1]?.[1] === x[0] && (s[i - 1]?.[0] ?? 0) === x[0],
    );
  });
}

describe("re → RegExp (vecteurs Python)", () => {
  it.each(V.cas.filter((c) => !NON_PRIS.has(c.motif)).map((c) => [`${c.motif} /${c.flags}`, c] as const))(
    "%s",
    (_n, c) => {
      if (c.erreur) {
        expect(erreurDe(() => compilerPy(c.motif, c.flags))).toEqual(c.erreur);
        return;
      }
      const m = compilerPy(c.motif, c.flags);
      expect(m.groupes).toBe(c.groupes);
      for (const t of c.textes ?? []) {
        const r = chercher(m, t.texte);
        expect(
          r === null
            ? null
            : {
                span: [enPoints(t.texte, r.debut), enPoints(t.texte, r.fin)],
                groupes: Array.from({ length: m.groupes }, (_, k) => r.groupe(k + 1) ?? null),
              },
          JSON.stringify(t.texte),
        ).toEqual(t.search);
        if (adjacentVide(c)) continue;
        expect(
          [...trouverTout(m, t.texte)]
            .slice(0, 50)
            .map((x) => [enPoints(t.texte, x.debut), enPoints(t.texte, x.fin)]),
          JSON.stringify(t.texte),
        ).toEqual(t.spans);
        expect(subn(m, "#", t.texte, 1)).toEqual(t.sub1);
        for (const [g, attendu] of Object.entries(t.sub ?? {})) {
          if (Array.isArray(attendu)) expect(subn(m, g, t.texte), g).toEqual(attendu);
          else
            expect(
              erreurDe(() => subn(m, g, t.texte)),
              g,
            ).toEqual(attendu);
        }
      }
    },
  );

  it("écarts consignés : \\N{…} et groupes conditionnels refusés (RegexNonGeree), sans masquer une erreur de Python plus loin", () => {
    for (const motif of NON_PRIS) expect(() => compilerPy(motif)).toThrow(RegexNonGeree);
    expect(erreurDe(() => compilerPy("\\N{EM DASH}("))).toEqual({
      type: "error",
      message: "missing ), unterminated subpattern at position 11",
    });
  });

  it("IGNORECASE sur de très grandes plages : même ensemble que _sre, compilé sans parcourir chaque point de code", () => {
    const debut = performance.now();
    const plages = [
      "[\\u0100-\\U0010ffff]",
      "[\\x00-\\U0010ffff]",
      "[^\\x00-\\U0001ffff]",
      "[\\U00010000-\\U0010ffff]",
      "[\\u0080-\\uffff]",
    ];
    for (const motif of plages) compilerPy(motif, RE_IGNORECASE);
    expect(performance.now() - debut).toBeLessThan(2500);
    expect(chercher(compilerPy("[\\u0100-\\U0010ffff]", RE_IGNORECASE), "K")?.debut).toBe(0);
    expect(chercher(compilerPy("[\\u0100-\\U0010ffff]", RE_IGNORECASE), "a")).toBeNull();
    expect(chercher(compilerPy("[\\x00-\\U0010ffff]", RE_IGNORECASE), "é")?.fin).toBe(1);
  });
});
