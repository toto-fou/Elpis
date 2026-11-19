// SPDX-License-Identifier: MIT
/** apps/core/test/identite/cle-identifiant.test.ts — la clé d'identifiant refuse les caractères sans effet de RFC 4518 et les marques combinantes ; la forme de comparaison replie la casse complète. */
import { describe, expect, it } from "vitest";

import { cleComparee, cleIdentifiant } from "../../src/identite/cle-identifiant";

describe("cleIdentifiant", () => {
  it("normalise et met en minuscules", () => {
    expect(cleIdentifiant("  Jean.Dupont  ")).toBe("jean.dupont");
    expect(cleIdentifiant("ＪＥＡＮ")).toBe("jean");
  });

  it.each([
    ["U+FFFC", "jea￼n"],
    ["U+1806", "jea᠆n"],
    ["U+00AD (trait d'union conditionnel)", "jea­n"],
    ["U+034F", "jea͏n"],
    ["U+180B", "jea᠋n"],
    ["U+FE0F", "jea️n"],
    ["U+200B", "jea​n"],
    ["marque combinante", "jex\u0301an"],
    ["deux espaces", "jean  dupont"],
    ["caractère de contrôle", "jea\u0007n"],
  ])("refuse %s", (_n, saisie) => {
    expect(cleIdentifiant(saisie)).toBeNull();
  });
});

describe("cleComparee", () => {
  it("replie la casse complète et retire les caractères sans effet", () => {
    expect(cleComparee("Gauß")).toBe("gauss");
    expect(cleComparee("GAUSS")).toBe("gauss");
    expect(cleComparee("jea￼n")).toBe("jean");
    expect(cleComparee(" Jean ")).toBe("jean");
  });
});
