// SPDX-License-Identifier: MIT
/** apps/core/test/identite/nom.test.ts — le nom Elpis dérivé d'un identifiant externe : forme stricte, noms réservés refusés, jamais de suffixe. */
import { describe, expect, it } from "vitest";

import { nomDerive } from "../../src/identite/nom";

describe("nomDerive", () => {
  it.each([
    ["jdupont", "jdupont"],
    ["Jean.Dupont", "jean-dupont"],
    ["JEAN_DUPONT", "jean_dupont"],
    ["jean--dupont", "jean-dupont"],
    ["--jean.dupont--", "jean-dupont"],
    ["j.dupont@exemple.lan", "j-dupont-exemple-lan"],
    ["ＪＥＡＮ", "jean"],
    ["a1", "a1"],
    ["x".repeat(64), "x".repeat(64)],
  ])("%s → %s", (entree, attendu) => {
    expect(nomDerive(entree)).toBe(attendu);
  });

  it.each([
    ["vide", ""],
    ["un seul caractère", "a"],
    ["65 caractères", "x".repeat(65)],
    ["que des séparateurs", "..."],
    ["commence par un tiret bas", "_jean"],
    ["admin", "admin"],
    ["ADMIN", "ADMIN"],
    ["root", "root"],
    ["system", "system"],
    ["elpis", "elpis"],
    ["guest", "guest"],
    ["Admin.", "Admin."],
    ["user_12", "user_12"],
    ["USER_007", "USER_007"],
    ["demi-paire isolée", "jean\ud800"],
  ])("refusé : %s", (_nom, entree) => {
    expect(nomDerive(entree)).toBeNull();
  });

  it("user_ suivi d'autre chose que des chiffres reste valide ; aucun suffixe pour lever une collision", () => {
    expect(nomDerive("user_abc")).toBe("user_abc");
    expect(nomDerive("administrateur")).toBe("administrateur");
    expect(nomDerive("jean.dupont")).toBe(nomDerive("Jean-Dupont"));
  });
});
