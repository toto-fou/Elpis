// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-motifs.test.ts — un PEM ou un texte hostile se refuse en temps borné, les noms de propriété du prototype sont refusés et les champs figés d'un fournisseur suivent l'émetteur, le client et la revendication du sujet. */
import { describe, expect, it } from "vitest";

import { champsFigesChanges } from "../src/identite/fournisseurs";
import { validerFournisseur } from "../src/identite/reglages";
import { CA_PEM, oidcValide } from "./identite/aides";

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
      expect(refuse(oidcValide({ ca_pem }))).toMatch(/ca_pem/u);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });

  it("un PEM valide est accepté, y compris relu (verdict mis en cache)", () => {
    for (let i = 0; i < 3; i++) expect(refuse(oidcValide({ ca_pem: CA_PEM }))).toBe("");
    expect(refuse(oidcValide({ ca_pem: `${CA_PEM}\n${CA_PEM}` }))).toBe("");
  });

  it("autres motifs appliqués à du texte long : adresses, portées, en moins de 50 ms", () => {
    const long = "a".repeat(100_000);
    const t0 = performance.now();
    for (const f of [
      oidcValide({ issuer: `https://${"a.".repeat(5000)}` }),
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
  ])("nom de propriété %s : refusé pour les revendications OIDC", (nom) => {
    for (const champ of ["subject_claim", "username_claim", "email_claim", "name_claim", "groups_claim"])
      expect(refuse(oidcValide({ [champ]: nom })), champ).toMatch(new RegExp(champ, "u"));
  });

  it("noms de revendication : motif strict, chemin pointé permis", () => {
    expect(refuse(oidcValide({ groups_claim: "realm_access.roles" }))).toBe("");
    expect(refuse(oidcValide({ groups_claim: "https://x.lan/groups" }))).toMatch(/groups_claim/u);
    expect(refuse(oidcValide({ groups_claim: "a b" }))).toMatch(/groups_claim/u);
    expect(refuse(oidcValide({ groups_claim: "g".repeat(65) }))).toMatch(/groups_claim/u);
    expect(refuse(oidcValide({ groups_claim: "urn:elpis:groupes" }))).toBe("");
  });

  it("champs figés : émetteur, client et revendication du sujet", () => {
    const av = validerFournisseur(oidcValide());
    const ap = (extra: Record<string, unknown>) => validerFournisseur(oidcValide(extra));
    expect(champsFigesChanges(av, ap({ issuer: "https://autre.exemple.lan/realms/elpis" }))).toEqual([
      "issuer",
    ]);
    expect(champsFigesChanges(av, ap({ client_id: "autre" }))).toEqual(["client_id"]);
    expect(champsFigesChanges(av, ap({ subject_claim: "oid" }))).toEqual(["subject_claim"]);
    expect(champsFigesChanges(av, ap({ username_claim: "upn", label: "Autre" }))).toEqual([]);
  });
});
