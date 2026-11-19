// SPDX-License-Identifier: MIT
/** apps/core/test/identite/ancre.test.ts — l'ancre d'une identité d'annuaire porte la base des comptes normalisée comme tout nom distinctif : deux écritures de la même base donnent la même ancre. */
import { describe, expect, it } from "vitest";

import { ancreIdentite } from "../../src/identite/ancre";
import { validerFournisseur } from "../../src/identite/reglages";
import { ldapValide, oidcValide } from "./aides";

describe("ancre d'identité", () => {
  const ancre = (user_base_dn: string, id = "entryUUID"): string =>
    ancreIdentite(
      validerFournisseur(
        ldapValide({ user_base_dn, attrs: { id, username: "uid", email: "mail", name: "cn" } }),
      ),
    );

  it("annuaire : base normalisée (casse, blancs autour des séparateurs, échappements équivalents) et attribut d'identifiant en minuscules", () => {
    expect(ancre("ou=people,dc=exemple,dc=lan")).toBe("ldap:ou=people,dc=exemple,dc=lan#entryuuid");
    expect(ancre("OU=People , DC=Exemple,DC=LAN")).toBe(ancre("ou=people,dc=exemple,dc=lan"));
    expect(ancre("ou=a\\2C b,dc=x")).toBe(ancre("ou=a\\, b,dc=x"));
    expect(ancre("ou=a\\, b,dc=x")).not.toBe(ancre("ou=a\\,b,dc=x"));
    expect(ancre("ou=people,dc=x", "objectGUID")).toBe("ldap:ou=people,dc=x#objectguid");
  });

  it("SSO : l'émetteur exact, jamais normalisé", () => {
    const f = validerFournisseur(oidcValide({ issuer: "https://SSO.exemple.lan/Realms/A" }));
    expect(ancreIdentite(f)).toBe("oidc:https://SSO.exemple.lan/Realms/A");
  });
});
