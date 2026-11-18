// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-motifs.test.ts — un PEM ou un texte hostile se refuse en temps borné, les noms de propriété du prototype sont refusés, les hôtes LDAP commencent par un caractère alphanumérique, les champs figés LDAP suivent les hôtes et la base. */
import { describe, expect, it } from "vitest";

import { champsFigesChanges } from "../src/identite/fournisseurs";
import { validerFournisseur } from "../src/identite/reglages";
import { CA_PEM, ldapValide, oidcValide } from "./identite/aides";

const refuse = (f: unknown): string => {
  try {
    validerFournisseur(f);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("motifs et bornes des réglages d'entreprise", () => {
  it("200 certificats suivis d'un texte invalide : refusé en moins de 50 ms", () => {
    const bloc = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    for (const ca_pem of [
      `${bloc.repeat(200)}texte`,
      `${bloc.repeat(200)}-----BEGIN`,
      `${CA_PEM}${"\n".repeat(20_000)}x`,
    ]) {
      const t0 = performance.now();
      expect(refuse(ldapValide({ ca_pem }))).toMatch(/ca_pem/u);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it("un PEM valide est accepté, y compris relu (verdict mis en cache)", () => {
    for (let i = 0; i < 3; i++) expect(refuse(ldapValide({ ca_pem: CA_PEM }))).toBe("");
    expect(refuse(ldapValide({ ca_pem: `${CA_PEM}\n${CA_PEM}` }))).toBe("");
  });

  it("autres motifs appliqués à du texte long : filtre, DN, adresses, en moins de 50 ms", () => {
    const long = "a".repeat(100_000);
    const t0 = performance.now();
    for (const f of [
      ldapValide({ user_filter: `(${long}{username})` }),
      ldapValide({ bind_dn: long }),
      ldapValide({ urls: [`ldaps://${"a.".repeat(5000)}`] }),
      oidcValide({ issuer: `https://${long}` }),
      oidcValide({ scopes: [long] }),
    ])
      expect(refuse(f)).not.toBe("");
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "a.__proto__",
    "constructor.prototype",
  ])("nom de propriété %s : refusé pour les revendications OIDC et les attributs LDAP", (nom) => {
    for (const champ of ["subject_claim", "username_claim", "email_claim", "name_claim", "groups_claim"])
      expect(refuse(oidcValide({ [champ]: nom })), champ).toMatch(new RegExp(champ, "u"));
    for (const champ of ["id", "username", "email", "name"])
      expect(
        refuse(
          ldapValide({
            attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn", [champ]: nom },
          }),
        ),
        champ,
      ).toMatch(/attrs/u);
  });

  it("noms de revendication : motif strict, chemin pointé permis", () => {
    expect(refuse(oidcValide({ groups_claim: "realm_access.roles" }))).toBe("");
    expect(refuse(oidcValide({ groups_claim: "https://x.lan/groups" }))).toMatch(/groups_claim/u);
    expect(refuse(oidcValide({ groups_claim: "a b" }))).toMatch(/groups_claim/u);
    expect(refuse(oidcValide({ groups_claim: "g".repeat(65) }))).toMatch(/groups_claim/u);
    expect(refuse(oidcValide({ groups_claim: "urn:elpis:groupes" }))).toBe("");
  });

  it("hôtes LDAP : `ldaps://.` et `ldaps://-` refusés", () => {
    for (const u of ["ldaps://.", "ldaps://-", "ldaps://.x.lan", "ldaps://-x.lan:636"])
      expect(refuse(ldapValide({ urls: [u] })), u).toMatch(/urls/u);
    expect(refuse(ldapValide({ urls: ["ldaps://a-b.lan:636", "ldaps://[::1]"] }))).toBe("");
  });

  it("champs figés LDAP : base des utilisateurs et hôtes (au moins un hôte d'origine doit rester)", () => {
    const av = validerFournisseur(ldapValide({ urls: ["ldaps://a.lan", "ldaps://b.lan:1636"] }));
    const ap = (extra: Record<string, unknown>) =>
      validerFournisseur(ldapValide({ urls: ["ldaps://a.lan", "ldaps://b.lan:1636"], ...extra }));
    if (av.type !== "ldap") throw new Error("ldap");
    expect(champsFigesChanges(av, ap({ user_base_dn: "cn=autres,dc=exemple,dc=lan" }))).toEqual([
      "user_base_dn",
    ]);
    expect(champsFigesChanges(av, ap({ urls: ["ldaps://a.lan:7636"] }))).toEqual([]);
    expect(champsFigesChanges(av, ap({ urls: ["ldaps://B.lan", "ldaps://c.lan"] }))).toEqual([]);
    expect(champsFigesChanges(av, ap({ urls: ["ldaps://c.lan"] }))).toEqual(["urls"]);
    expect(champsFigesChanges(av, ap({ urls: ["ldaps://a.lan", "ldaps://c.lan"] }))).toEqual([]);
  });
});
