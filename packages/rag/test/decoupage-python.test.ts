// SPDX-License-Identifier: MIT
/** packages/rag/test/decoupage-python.test.ts — goldens figés du chunker Python de l'ancien RAG (retiré en L9, vecteurs/decoupage.json) : mêmes textes de passages pour taille, phrase, markdown, séparateur et regex sans chevauchement. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decouperTexte } from "../src/decoupage";
import type { MethodeDecoupage } from "../src/decoupage";

interface Cas {
  nom: string;
  methode: "size" | "sentence" | "markdown" | "delimiter" | "regex";
  valeur: string | null;
  taille: number;
  maximum: number;
  chevauchement: number;
  texte: string;
  chunks: string[];
}

const METHODES: Record<Cas["methode"], MethodeDecoupage> = {
  size: "taille",
  sentence: "phrase",
  markdown: "markdown",
  delimiter: "separateur",
  regex: "regex",
};

const { cas } = JSON.parse(readFileSync(new URL("./vecteurs/decoupage.json", import.meta.url), "utf-8")) as {
  cas: Cas[];
};

describe("goldens du chunker Python", () => {
  it("couvre les cinq méthodes", () => {
    expect(new Set(cas.map((c) => c.methode))).toEqual(
      new Set(["size", "sentence", "markdown", "delimiter", "regex"]),
    );
  });

  it.each(cas.map((c) => [c.nom, c] as const))("%s : mêmes passages que le Python", (_nom, c) => {
    const ps = decouperTexte(c.texte, {
      methode: METHODES[c.methode],
      ...(c.valeur === null ? {} : { valeur: c.valeur }),
      caracteresParJeton: 1,
      tailleJetons: c.taille,
      chevauchementJetons: c.chevauchement,
      tailleMaxJetons: c.maximum,
    });
    expect(ps.map((p) => p.text)).toEqual(c.chunks);
    for (const p of ps) expect(c.texte.slice(p.char_start, p.char_end)).toBe(p.text);
  });
});
