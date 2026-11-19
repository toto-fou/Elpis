// SPDX-License-Identifier: MIT
/** packages/auth/test/securite-session-reservee.test.ts — `Session.set` refuse les clés d'identité, seul `ouvrirSession` les écrit. */
import { describe, expect, it } from "vitest";

import { ouvrirSession, renouvelerSession, Session } from "../src/index";
import { poserIdentite } from "./aides-session";

const RESERVEES = ["uid", "user", "user_id", "_sid", "_auth", "_login_ts"];

describe("clés d'identité de la session", () => {
  it.each(RESERVEES)("set(%s) lève et ne modifie rien", (cle) => {
    const s = new Session();
    expect(() => s.set(cle, 1)).toThrow(/reserved/u);
    expect(s.contenu()).toEqual({});
    expect(s.modifiee).toBe(false);
  });

  it("les clés ordinaires passent, vider reste permis", () => {
    const s = new Session();
    s.set("_last_activity_ts", 5);
    s.set("oauth_state", "x");
    s.set("csrf", "y");
    expect(s.contenu()).toEqual({ _last_activity_ts: 5, oauth_state: "x", csrf: "y" });
    s.vider();
    expect(s.vide).toBe(true);
  });

  it("le champ interne n'est pas atteignable de l'extérieur", () => {
    const s = new Session({ user_id: 3 });
    expect(Object.keys(s)).toEqual(["lue", "modifiee"]);
    expect(JSON.stringify(s)).toBe('{"lue":false,"modifiee":false}');
    expect((s as unknown as Record<string, unknown>)["donnees"]).toBeUndefined();
    s.contenu()["user_id"] = 99;
    expect(s.get("user_id")).toBe(3);
  });

  it("la porte d'identité de test écrit les clés réservées", () => {
    const s = new Session();
    poserIdentite(s, { user_id: 2, _login_ts: 1 });
    expect(s.contenu()).toEqual({ user_id: 2, _login_ts: 1 });
  });
});

describe("renouvelerSession", () => {
  it("ne remet que _login_ts d'une session ouverte", () => {
    const s = new Session();
    const sid = ouvrirSession(s, { uid: 4, methode: "password", maintenant: 10, dureeMax: 100 });
    renouvelerSession(s, 99);
    expect(s.get("_login_ts")).toBe(99);
    expect(s.get("_sid")).toBe(sid);
    expect(s.get("user_id")).toBe(4);
  });

  it("lève sans session ouverte et n'écrit rien", () => {
    const s = new Session({ csrf: "x" });
    expect(() => renouvelerSession(s, 1)).toThrow();
    expect(s.contenu()).toEqual({ csrf: "x" });
  });
});

describe("ouvrirSession : méthode contrôlée à l'exécution", () => {
  const ouvrir = (methode: string) =>
    ouvrirSession(new Session(), { uid: 1, methode: methode as "password", maintenant: 1, dureeMax: 100 });

  it.each(["password", "ldap:a", "oidc:sso-1", `ldap:${"a".repeat(31)}`])("accepte %s", (m) => {
    expect(() => ouvrir(m)).not.toThrow();
  });

  it.each([
    "",
    "Password",
    "ldap:",
    "ldap:-a",
    "ldap:A",
    "saml:x",
    `ldap:${"a".repeat(32)}`,
    "oidc:a b",
    "password\n",
  ])("refuse %j sans toucher la session", (m) => {
    const s = new Session({ csrf: "x" });
    expect(() =>
      ouvrirSession(s, { uid: 1, methode: m as "password", maintenant: 1, dureeMax: 100 }),
    ).toThrow();
    expect(s.contenu()).toEqual({ csrf: "x" });
  });
});
