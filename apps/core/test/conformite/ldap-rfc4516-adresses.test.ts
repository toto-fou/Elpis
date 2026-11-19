// SPDX-License-Identifier: MIT
/** apps/core/test/conformite/ldap-rfc4516-adresses.test.ts — RFC 4516 : adresses `ldaps://hôte[:port]` (port par défaut, IPv6 littérale, casse, éléments interdits) acceptées par les réglages et par l'adaptateur. */
import { describe, expect, it } from "vitest";

import { fabriqueLdapts } from "../../src/identite/annuaire/client";
import { hotePortLdaps, validerFournisseur } from "../../src/identite/reglages";
import { fournisseur } from "../identite/annuaire/faux";
import { ldapValide } from "../identite/aides";

const accepte = (url: string): boolean => {
  try {
    validerFournisseur(ldapValide({ urls: [url] }));
    return true;
  } catch {
    return false;
  }
};

describe("RFC 4516 §2 : adresses acceptées", () => {
  it.each([
    "ldaps://ldap.exemple.lan",
    "ldaps://ldap.exemple.lan:636",
    "ldaps://ldap.exemple.lan:3269",
    "ldaps://ldap-1.corp.example:65535",
    "ldaps://10.0.0.5",
    "ldaps://10.0.0.5:6360",
    "ldaps://[2001:db8::1]",
    "ldaps://[2001:db8::1]:636",
    "ldaps://[::1]:1636",
    "ldaps://DC01",
  ])("RFC 4516 §2 (hôte, port, IPv6 littérale RFC 3986 §3.2.2) : %s accepté", (url) => {
    expect(accepte(url)).toBe(true);
  });

  it("RFC 4516 §2 : port par défaut 636, hôte en minuscules, IPv6 conservée entre crochets", () => {
    expect(hotePortLdaps("ldaps://LDAP.Exemple.LAN")).toBe("ldap.exemple.lan:636");
    expect(hotePortLdaps("ldaps://ldap.exemple.lan:3269")).toBe("ldap.exemple.lan:3269");
    expect(hotePortLdaps("ldaps://[2001:DB8::1]")).toBe("[2001:db8::1]:636");
  });

  it("RFC 4516 §2 : deux adresses qui désignent le même hôte et port (casse, port par défaut) sont refusées comme doublon", () => {
    expect(() =>
      validerFournisseur(ldapValide({ urls: ["ldaps://ldap.exemple.lan", "ldaps://LDAP.exemple.lan:636"] })),
    ).toThrowError();
  });
});

describe("RFC 4516 §2 : adresses refusées", () => {
  it.each([
    ["chemin (DN de base)", "ldaps://ldap.exemple.lan/dc=exemple,dc=lan"],
    ["barre finale", "ldaps://ldap.exemple.lan/"],
    ["attributs, portée, filtre", "ldaps://ldap.exemple.lan/dc=x?uid?sub?(uid=*)"],
    ["requête seule", "ldaps://ldap.exemple.lan?uid"],
    ["extensions", "ldaps://ldap.exemple.lan/dc=x????e-bindname=cn=x"],
    ["identifiants dans l'adresse", "ldaps://svc:secret@ldap.exemple.lan"],
    ["nom d'utilisateur seul", "ldaps://svc@ldap.exemple.lan"],
    ["fragment", "ldaps://ldap.exemple.lan#x"],
    ["ldap:// en clair", "ldap://ldap.exemple.lan"],
    ["ldap:// avec port 389", "ldap://ldap.exemple.lan:389"],
    ["ldapi://", "ldapi://%2Fvar%2Frun%2Fldapi"],
    ["https://", "https://ldap.exemple.lan"],
    ["hôte absent", "ldaps://"],
    ["port 0", "ldaps://ldap.exemple.lan:0"],
    ["port 65536", "ldaps://ldap.exemple.lan:65536"],
    ["port non numérique", "ldaps://ldap.exemple.lan:abc"],
    ["port vide", "ldaps://ldap.exemple.lan:"],
    ["port avec zéro de tête", "ldaps://ldap.exemple.lan:0636"],
    ["IPv6 sans crochets", "ldaps://2001:db8::1"],
    ["IPv6 invalide", "ldaps://[2001:db8::zz]"],
    ["IPv6 sans fermeture", "ldaps://[2001:db8::1"],
    ["IPv4 entre crochets", "ldaps://[10.0.0.5]"],
    ["espace", "ldaps://ldap .exemple.lan"],
    ["saut de ligne", "ldaps://ldap.exemple.lan\n"],
    ["hôte commençant par un tiret", "ldaps://-ldap.exemple.lan"],
  ])("RFC 4516 §2 : %s refusé", (_n, url) => {
    expect(accepte(url)).toBe(false);
  });

  it("RFC 3986 §3.1 (schéma insensible à la casse) : `LDAPS://` est refusé par choix (plus strict que la norme)", () => {
    expect(accepte("LDAPS://ldap.exemple.lan")).toBe(false);
    expect(accepte("Ldaps://ldap.exemple.lan")).toBe(false);
  });

  it("l'adaptateur refuse de lui-même une adresse hors forme, sans ouvrir de socket", async () => {
    const fabrique = fabriqueLdapts({
      connecter: () => {
        throw new Error("aucune connexion attendue");
      },
    });
    for (const url of [
      "ldap://ldap.exemple.lan",
      "ldaps://ldap.exemple.lan/dc=x",
      "ldaps://u:p@ldap.exemple.lan",
      "LDAPS://ldap.exemple.lan",
      "ldaps://ldap.exemple.lan#x",
    ])
      await expect(fabrique(fournisseur(), url)).rejects.toMatchObject({ nature: "configuration" });
  });
});
