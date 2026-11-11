// SPDX-License-Identifier: MIT
/** packages/rag/test/bm25.test.ts — tokenisation FR/EN, hachage FNV-1a, vecteurs creux de passage et de requête. */
import { describe, expect, it } from "vitest";

import {
  BM25_B,
  BM25_K1,
  BM25_LONGUEUR_MOYENNE,
  hacherToken,
  normaliserTexte,
  texteBm25,
  tokeniser,
  vecteurDocument,
  vecteurRequete,
} from "../src/bm25";

describe("tokeniser", () => {
  it("passe en minuscules sans diacritiques et coupe hors alphanumérique", () => {
    expect(tokeniser("Résiliation anticipée : cœur, Straße & ﬁn-de-contrat 2026!")).toEqual([
      "resiliation",
      "anticipee",
      "coeur",
      "strasse",
      "fin",
      "contrat",
      "2026",
    ]);
  });

  it("retire les mots vides français et anglais, les lettres seules et garde un chiffre seul", () => {
    expect(
      tokeniser("Le renouvellement de la clause et the termination of this clause, l'article 3 a été signé"),
    ).toEqual(["renouvellement", "clause", "termination", "clause", "article", "3", "signe"]);
  });

  it("tronque un mot géant et ne plante pas sur du texte vide", () => {
    const [t] = tokeniser("x".repeat(500));
    expect(t).toHaveLength(64);
    expect(tokeniser("")).toEqual([]);
    expect(tokeniser("   ...  ")).toEqual([]);
  });

  it("normalise de la même façon l'écriture composée et décomposée", () => {
    expect(normaliserTexte("été")).toBe("ete");
    expect(tokeniser("Été")).toEqual(tokeniser("Été"));
  });
});

describe("hacherToken", () => {
  it("est le FNV-1a 32 bits de l'UTF-8 (vecteurs de référence)", () => {
    expect(hacherToken("")).toBe(0x811c9dc5);
    expect(hacherToken("a")).toBe(0xe40c292c);
    expect(hacherToken("foobar")).toBe(0xbf9cf968);
  });

  it("reste un entier de 32 bits non signé", () => {
    for (const t of ["contrat", "résiliation", "日本語", "x".repeat(64)]) {
      const h = hacherToken(t);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("vecteurDocument", () => {
  it("donne des indices triés et uniques avec la composante tf de BM25", () => {
    const v = vecteurDocument("contrat contrat résiliation");
    expect(v.indices).toEqual([...v.indices].sort((a, b) => a - b));
    expect(new Set(v.indices).size).toBe(v.indices.length);
    const norme = 1 - BM25_B + (BM25_B * 3) / BM25_LONGUEUR_MOYENNE;
    const tf = (n: number): number => (n * (BM25_K1 + 1)) / (n + BM25_K1 * norme);
    const valeur = (mot: string): number | undefined => v.values[v.indices.indexOf(hacherToken(mot))];
    expect(valeur("contrat")).toBeCloseTo(tf(2), 12);
    expect(valeur("resiliation")).toBeCloseTo(tf(1), 12);
    expect(valeur("contrat") ?? 0).toBeGreaterThan(valeur("resiliation") ?? 0);
  });

  it("sature la fréquence et pénalise les passages longs", () => {
    const court = vecteurDocument("alpha beta");
    const long = vecteurDocument(`alpha beta ${"gamma ".repeat(600)}`);
    const a = hacherToken("alpha");
    expect(long.values[long.indices.indexOf(a)] ?? 0).toBeLessThan(
      court.values[court.indices.indexOf(a)] ?? 0,
    );
    const dix = vecteurDocument("alpha ".repeat(10));
    const cent = vecteurDocument("alpha ".repeat(100));
    expect(cent.values[0] ?? 0).toBeLessThan((BM25_K1 + 1) * 1.001);
    expect(cent.values[0] ?? 0).toBeGreaterThan(dix.values[0] ?? 0);
  });

  it("accepte des paramètres explicites et un texte sans token", () => {
    expect(vecteurDocument("le la les")).toEqual({ indices: [], values: [] });
    const v = vecteurDocument("alpha", { k1: 2, b: 0, longueurMoyenne: 10 });
    expect(v.values[0]).toBeCloseTo((1 * 3) / (1 + 2), 12);
  });

  it("est déterministe", () => {
    const t = "Le renouvellement du contrat est automatique, sauf résiliation.";
    expect(vecteurDocument(t)).toEqual(vecteurDocument(t));
  });
});

describe("vecteurRequete", () => {
  it("met un poids de 1 par token distinct, accents et casse ignorés", () => {
    const v = vecteurRequete("Résiliation résiliation CONTRAT");
    expect(v.indices).toHaveLength(2);
    expect(v.values).toEqual([1, 1]);
    expect(v.indices).toContain(hacherToken("resiliation"));
    expect(vecteurRequete("question")).toEqual(vecteurRequete("QUESTION"));
  });

  it("est vide quand la requête n'a que des mots vides", () => {
    expect(vecteurRequete("de la et le")).toEqual({ indices: [], values: [] });
  });
});

describe("texteBm25", () => {
  it("ajoute le chemin des titres devant le texte", () => {
    expect(texteBm25({ heading_path: "3 › 3.2 Renouvellement", text: "Corps" })).toBe(
      "3 › 3.2 Renouvellement\nCorps",
    );
    expect(texteBm25({ heading_path: "", text: "Corps" })).toBe("Corps");
  });
});
