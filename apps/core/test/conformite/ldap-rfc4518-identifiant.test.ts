// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-rfc4518-identifiant.test.ts — RFC 4518 / 4517 : préparation des chaînes de l'identifiant tapé (NFKC, caractères sans effet, espaces, casse) face à la comparaison de l'annuaire (caseIgnoreMatch). */
import { describe, expect, it } from "vitest";

import { cleComparee, cleIdentifiant } from "../../src/identite/cle-identifiant";

describe("RFC 4518 §2.2 : caractères convertis en rien : saisie refusée", () => {
  it.each([
    ["U+00AD trait d'union conditionnel", "\u00AD"],
    ["U+1806 tiret souple mongol", "᠆"],
    ["U+034F", "͏"],
    ["U+180B à U+180D sélecteurs mongols", "᠋"],
    ["U+200B espace de largeur nulle", "\u200B"],
    ["U+200C", "‌"],
    ["U+200D", "‍"],
    ["U+2060 lieur de mots", "⁠"],
    ["U+FE00 sélecteur de variante", "︀"],
    ["U+FEFF marque d'ordre des octets", "\uFEFF"],
    ["U+FFFC caractère de remplacement d'objet", "￼"],
  ])("%s : clé nulle, le compte local et l'annuaire ne peuvent pas être confondus", (_n, c) => {
    expect(cleIdentifiant(`jea${c}n`)).toBeNull();
    expect(cleComparee(`jea${c}n`)).toBe("jean");
  });
});

describe("RFC 4518 §2.2 : caractères convertis en espace : saisie refusée", () => {
  it.each([
    ["tabulation", "\t"],
    ["saut de ligne", "\n"],
    ["retour chariot", "\r"],
    ["U+0085", "\u0085"],
    ["U+2028 séparateur de ligne", "\u2028"],
  ])("%s au milieu d'un identifiant : refusé", (_n, c) => {
    expect(cleIdentifiant(`jean${c}dupont`)).toBeNull();
  });
});

describe("RFC 4518 §2.2 : espaces de formes variées ramenées à une espace par NFKC", () => {
  it.each([
    ["U+00A0 espace insécable", "\u00A0"],
    ["U+2003 cadratin", "\u2003"],
    ["U+3000 espace idéographique", "\u3000"],
  ])("%s : devient l'espace ordinaire, comme le fait l'annuaire", (_n, c) => {
    expect(cleIdentifiant(`jean${c}dupont`)).toBe("jean dupont");
  });
});

describe("RFC 4518 §2.3, §2.6.1 : normalisation et espaces non significatives", () => {
  it.each([
    ["NFKC : pleine largeur", "ＪＥＡＮ", "jean"],
    ["NFKC : ligature", "ﬁn", "fin"],
    ["NFKC : chiffre romain", "Ⅻ", "xii"],
    ["NFKC : forme décomposée ramenée à la forme composée (é)", "e\u0301", "\u00e9"],
    ["NFC déjà composé", "é", "é"],
    ["espaces de bord retirées", "  jean  ", "jean"],
    ["une espace intérieure conservée", "jean dupont", "jean dupont"],
    ["casse repliée", "JeAn.DuPoNt", "jean.dupont"],
  ])("RFC 4518 : %s", (_n, saisie, attendu) => {
    expect(cleIdentifiant(saisie)).toBe(attendu);
  });

  it("RFC 4518 §2.6.1 : deux espaces de suite à l'intérieur : refusé par choix (plus strict que la norme, qui les réduit)", () => {
    expect(cleIdentifiant("jean  dupont")).toBeNull();
  });

  it("RFC 4518 §2.6.1 : saisie faite d'espaces seules : refusée", () => {
    expect(cleIdentifiant("   ")).toBeNull();
    expect(cleIdentifiant("")).toBeNull();
  });

  it("RFC 3629 : chaîne mal formée (substitut isolé) : refusée", () => {
    expect(cleIdentifiant("a\uD800b")).toBeNull();
  });
});

describe("RFC 4517 §4.2.11 caseIgnoreMatch + RFC 3454 B.2 : repli de casse de la comparaison locale", () => {
  it.each([
    ["ß", "gauß", "gauss"],
    ["ſ s long", "ſam", "sam"],
    ["ŉ", "ŉ", "ʼn"],
    ["K Kelvin", "Kevin", "kevin"],
    ["ﬃ ligature", "ﬃ", "ffi"],
  ])("%s : même clé que la forme repliée par l'annuaire", (_n, saisie, attendu) => {
    expect(cleComparee(saisie)).toBe(attendu);
  });

  it("RFC 3454 B.2 : sigma final et sigma ordinaire se comparent égaux, majuscule comprise", () => {
    expect(cleComparee("οδος")).toBe(cleComparee("οδοσ"));
    expect(cleComparee("ΟΔΟΣ")).toBe(cleComparee("οδος"));
  });

  it("U+0131 (i sans point) : repliée en `i` par la forme locale, plus large que RFC 3454 B.2 : plus de collisions, jamais moins (sens sûr)", () => {
    expect(cleComparee("ı")).toBe("i");
  });

  it("espaces de bord et caractères sans effet : retirés de la forme de comparaison, jamais refusés", () => {
    expect(cleComparee("  Jea\u00ADn  ")).toBe("jean");
  });
});
