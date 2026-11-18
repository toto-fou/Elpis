// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/filtre.test.ts — l'identifiant tapé est échappé par la bibliothèque et ne sort jamais de sa valeur dans le filtre rendu. */
import { describe, expect, it } from "vitest";

import { ErreurAnnuaire } from "../../../src/identite/annuaire/erreur";
import { filtreEgal, rendreFiltre } from "../../../src/identite/annuaire/filtre";

const GABARIT = "(&(objectClass=person)(uid={username}))";

describe("rendreFiltre", () => {
  it("rend un identifiant simple", () => {
    expect(rendreFiltre(GABARIT, "jdupont")).toBe("(&(objectClass=person)(uid=jdupont))");
  });

  it.each([
    ["*", "\\2a"],
    [")(uid=*", "\\29\\28uid=\\2a"],
    ["a\\b", "a\\5cb"],
    ["x)(|(objectClass=*", "x\\29\\28|\\28objectClass=\\2a"],
    ["(", "\\28"],
  ])("échappe %j", (saisie, attendu) => {
    expect(rendreFiltre(GABARIT, saisie)).toBe(`(&(objectClass=person)(uid=${attendu}))`);
  });

  it("garde les caractères non ASCII tels quels", () => {
    expect(rendreFiltre(GABARIT, "Zoë.Élan")).toBe("(&(objectClass=person)(uid=Zoë.Élan))");
  });

  it.each(["", "a\0b", "a\nb", "a\tb", "x".repeat(257), "\ud800"])("refuse %j", (saisie) => {
    expect(() => rendreFiltre(GABARIT, saisie)).toThrow(ErreurAnnuaire);
  });

  it("accepte 256 caractères", () => {
    expect(rendreFiltre("(uid={username})", "x".repeat(256))).toBe(`(uid=${"x".repeat(256)})`);
  });

  it("exige exactement un {username}", () => {
    expect(() => rendreFiltre("(uid=x)", "a")).toThrow(ErreurAnnuaire);
    expect(() => rendreFiltre("(|(uid={username})(mail={username}))", "a")).toThrow(ErreurAnnuaire);
  });

  it("un identifiant hostile ne change pas le nombre de parenthèses du filtre", () => {
    const rendu = rendreFiltre("(uid={username})", ")(uid=*))(&(a=b");
    expect(rendu.match(/\(/gu)?.length).toBe(1);
    expect(rendu.match(/\)/gu)?.length).toBe(1);
  });
});

describe("filtreEgal", () => {
  it("échappe une valeur chaîne", () => {
    expect(filtreEgal("memberOf", "cn=a*,dc=x")).toBe("(memberOf=cn=a\\2a,dc=x)");
  });

  it("échappe chaque octet d'une valeur binaire", () => {
    expect(filtreEgal("objectGUID", Buffer.from([0, 15, 255]))).toBe("(objectGUID=\\00\\0f\\ff)");
  });

  it("accepte la règle en chaîne d'Active Directory", () => {
    expect(filtreEgal("memberOf:1.2.840.113556.1.4.1941:", "cn=g")).toBe(
      "(memberOf:1.2.840.113556.1.4.1941:=cn=g)",
    );
  });

  it.each([["a=b"], ["(x)"], [""], ["1abc"]])("refuse l'attribut %j", (attribut) => {
    expect(() => filtreEgal(attribut, "v")).toThrow(ErreurAnnuaire);
  });

  it("refuse une valeur vide", () => {
    expect(() => filtreEgal("a", "")).toThrow(ErreurAnnuaire);
    expect(() => filtreEgal("a", Buffer.alloc(0))).toThrow(ErreurAnnuaire);
  });
});
