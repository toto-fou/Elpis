// SPDX-License-Identifier: MIT
/** packages/auth/test/cookie.test.ts — cookie signé (aller-retour, falsification, âge) et en-têtes Set-Cookie de Starlette. */
import { describe, expect, it } from "vitest";

import { enteteCookie, enteteEffacement, lireSession, signerSession, valeurCookie } from "../src/cookie";

describe("cookie de session", () => {
  const t = 1_791_331_200;

  it("aller-retour, signature, âge maximal et date future refusés", () => {
    const v = signerSession({ user_id: 7, _sid: "abc" }, "secret", t);
    expect(lireSession(v, "secret", 3600, t + 3600)).toEqual({ user_id: 7, _sid: "abc" });
    expect(lireSession(v, "secret", 3600, t + 3601)).toBeNull();
    expect(lireSession(v, "secret", 3600, t - 1)).toBeNull();
    expect(lireSession(v, "autre", 3600, t)).toBeNull();
    expect(lireSession(`${v}x`, "secret", 3600, t)).toBeNull();
    expect(lireSession("eyJ.abc", "secret", 3600, t)).toBeNull();
    expect(lireSession("ancien-cookie-itsdangerous.YWJj.def", "secret", 3600, t)).toBeNull();
  });

  it("en-têtes Set-Cookie : pose comme Starlette ; effacement sous une forme unique (HttpOnly, Max-Age=0, expiration datée)", () => {
    const a = { cookie_name: "mcpwebui_session", same_site: "lax" as const, https_only: true, max_age: 600 };
    expect(enteteCookie(a, "VAL")).toBe(
      "mcpwebui_session=VAL; path=/; Max-Age=600; httponly; samesite=lax; secure",
    );
    expect(enteteEffacement({ ...a, https_only: false })).toBe(
      'mcpwebui_session=""; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; httponly; samesite=lax',
    );
    expect(enteteEffacement(a, 1_791_331_260.9)).toBe(
      'mcpwebui_session=""; path=/; expires=Wed, 07 Oct 2026 00:01:00 GMT; Max-Age=0; httponly; samesite=lax; secure',
    );
  });

  it("lecture de l'en-tête Cookie", () => {
    expect(valeurCookie('a=1; mcpwebui_session="x.y"; b=2', "mcpwebui_session")).toBe("x.y");
    expect(valeurCookie("a=1;b", "b")).toBeUndefined();
    expect(valeurCookie(undefined, "a")).toBeUndefined();
  });
});
