// SPDX-License-Identifier: MIT
/** packages/auth/test/ouverture.test.ts — ouvrirSession remplace tout le contenu de la session et pose la méthode de connexion. */
import { describe, expect, it } from "vitest";

import { ouvrirSession, Session } from "../src/index";

describe("ouvrirSession", () => {
  it("vide la session puis pose les clés d'identité dans l'ordre et la méthode", () => {
    const s = new Session({ csrf: "x", user_id: 9, _sid: "ancien", autre: 1 });
    const sid = ouvrirSession(s, { uid: 4, methode: "password", maintenant: 1234.5 });
    expect(Object.keys(s.contenu())).toEqual(["uid", "user", "user_id", "_login_ts", "_sid", "_auth"]);
    expect(s.contenu()).toEqual({
      uid: 4,
      user: 4,
      user_id: 4,
      _login_ts: 1234.5,
      _sid: sid,
      _auth: "password",
    });
    expect(sid).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(s.modifiee).toBe(true);
  });

  it("rend un _sid neuf à chaque appel et garde la méthode donnée", () => {
    const s = new Session();
    const a = ouvrirSession(s, { uid: 1, methode: "ldap:annuaire", maintenant: 1 });
    expect(s.get("_auth")).toBe("ldap:annuaire");
    const b = ouvrirSession(s, { uid: 1, methode: "oidc:sso", maintenant: 2 });
    expect(b).not.toBe(a);
    expect(s.get("_sid")).toBe(b);
    expect(s.get("_auth")).toBe("oidc:sso");
  });
});
