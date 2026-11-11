// SPDX-License-Identifier: MIT
/** packages/auth/test/fastify.test.ts — installerAuth et gardes dans Fastify, sur une vraie base initialisée (SQLite et PostgreSQL). */
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { AttributsCookie } from "@elpis/config";
import type { BaseDeTest } from "@elpis/db/test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { creerGardes, installerAuth, leverMinSession, revaliderFlux, revoquerSid } from "../src/index";
import type { DependancesAuth } from "../src/index";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
let t: BaseDeTest;
let app: FastifyInstance;
let dep: DependancesAuth;
let horloge = 1_791_331_200;
let config: Record<string, unknown> = {};
let attributs: AttributsCookie;
const refus: unknown[][] = [];

async function creer(moteur: "sqlite" | "postgres"): Promise<void> {
  t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  for (const [nom, role, changer] of [
    ["alice", 0, 0],
    ["admin", 1, 0],
    ["modo", 2, 0],
    ["neuf", 0, 1],
  ] as const) {
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, must_change_pwd) VALUES (?, 's', 'h', 0, ?, ?)",
      [nom, role, changer],
    );
  }
  dep = {
    base: t.base,
    config: () => config,
    attributsCookie: () => attributs,
    secret: () => "secret-de-test",
    jetonService: () => "jeton-svc",
    maintenant: () => horloge,
    signalerRefus: (r, motif, d) => {
      refus.push([motif, r.url, d]);
    },
  };
  app = Fastify();
  app.setErrorHandler((e, _req, rep) => {
    if (e instanceof HttpError)
      return rep
        .code(e.statusCode)
        .headers(e.entetes ?? {})
        .send({ detail: e.detail });
    return rep.code(500).send({ detail: String(e) });
  });
  installerAuth(app, dep);
  const g = creerGardes(dep);
  app.post("/connexion/:uid", async (req) => {
    req.session.set("user_id", Number((req.params as { uid: string }).uid));
    req.session.set("_login_ts", horloge);
    req.session.set("_sid", `sid-${(req.params as { uid: string }).uid}`);
    return { ok: true };
  });
  app.post("/deconnexion", async (req) => {
    req.session.vider();
    return { ok: true };
  });
  app.get("/moi", { onRequest: g.session }, async (req) => ({
    id: req.utilisateur?.id,
    nom: req.utilisateur?.username,
  }));
  app.post("/ecrire", { onRequest: g.session }, async () => ({ ok: true }));
  app.get("/api/me-lite", { onRequest: g.session }, async () => ({ ok: true }));
  app.get("/staff", { onRequest: g.staff }, async () => ({ ok: true }));
  app.get("/admin", { onRequest: g.admin }, async () => ({ ok: true }));
  app.get("/boucle", { onRequest: g.loopback }, async () => ({ ok: true }));
  app.get("/service", { onRequest: g.service }, async () => ({ ok: true }));
  app.post("/api/webhooks/x", async () => ({ ok: true }));
  app.post("/api/login-lite", async () => ({ ok: true }));
  app.get("/api/users/change-password", { onRequest: g.session }, async () => ({ ok: true }));
  app.get("/api/:nom", { onRequest: g.session }, async () => ({ ok: true }));
  app.post("/cookie-route", async (req, rep) => {
    void rep.header("set-cookie", "autre=1; path=/");
    req.session.set("x", 1);
    return { ok: true };
  });
  await app.ready();
}

async function connecter(uid: number): Promise<string> {
  const r = await app.inject({ method: "POST", url: `/connexion/${uid}` });
  const cookie = String(r.headers["set-cookie"]).split(";")[0] ?? "";
  expect(cookie.startsWith("mcpwebui_session=")).toBe(true);
  return cookie;
}

describe.each(MOTEURS)("session et gardes (%s)", (moteur) => {
  beforeEach(async () => {
    horloge = 1_791_331_200;
    config = {};
    refus.length = 0;
    attributs = { cookie_name: "mcpwebui_session", same_site: "lax", https_only: false, max_age: 86400 };
    await creer(moteur);
  });

  afterEach(async () => {
    await app.close();
    await t.fermer();
  });

  it("session portée par le cookie, Vary: Cookie, cookie non réémis sans modification", async () => {
    const c = await connecter(1);
    const r = await app.inject({ method: "GET", url: "/moi", headers: { cookie: c } });
    expect(r.json()).toEqual({ id: 1, nom: "alice" });
    expect(r.headers.vary).toContain("Cookie");
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/moi" })).json()).toEqual({ detail: "not logged in" });
  });

  it("inactivité : _last_activity_ts réécrit, cookie réémis ; déconnexion : cookie effacé", async () => {
    config = { security: { session: { idle_timeout_sec: 600 } } };
    const c = await connecter(1);
    horloge += 100;
    const r = await app.inject({ method: "GET", url: "/moi", headers: { cookie: c } });
    expect(String(r.headers["set-cookie"])).toMatch(
      /^mcpwebui_session=.+; path=\/; Max-Age=86400; httponly; samesite=lax$/u,
    );
    horloge += 700;
    const expiree = await app.inject({ method: "GET", url: "/moi", headers: { cookie: c } });
    expect(expiree.json()).toEqual({ detail: "session revoked or expired" });
    expect(String(expiree.headers["set-cookie"])).toContain(
      'mcpwebui_session=""; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; httponly',
    );
    const d = await app.inject({
      method: "POST",
      url: "/deconnexion",
      headers: { cookie: await connecter(1) },
    });
    expect(String(d.headers["set-cookie"])).toContain(
      'mcpwebui_session=""; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; httponly',
    );
  });

  it("session révoquée par _sid, mot de passe à changer", async () => {
    const c = await connecter(1);
    await revoquerSid(t.base, "sid-1", 1, horloge);
    expect((await app.inject({ method: "GET", url: "/moi", headers: { cookie: c } })).statusCode).toBe(401);
    const n = await connecter(4);
    expect((await app.inject({ method: "GET", url: "/moi", headers: { cookie: n } })).json()).toEqual({
      detail: "must_change_password",
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: n } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/users/change-password", headers: { cookie: n } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ method: "GET", url: "/api/users%2Fchange-password", headers: { cookie: n } })
      ).json(),
    ).toEqual({ detail: "must_change_password" });
  });

  it("Set-Cookie de la route gardé une seule fois ; cookie de session en double : le dernier l'emporte", async () => {
    const r = await app.inject({ method: "POST", url: "/cookie-route" });
    const cookies = r.headers["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe("autre=1; path=/");
    expect(cookies[1]).toMatch(/^mcpwebui_session=/u);
    const c = await connecter(1);
    const double = await app.inject({
      method: "GET",
      url: "/moi",
      headers: { cookie: `mcpwebui_session=faux; ${c}` },
    });
    expect(double.json()).toEqual({ id: 1, nom: "alice" });
  });

  it("flux : compte supprimé, révoqué par compte ou par _sid", async () => {
    expect(await revaliderFlux(dep, 1, horloge - 10, "sid-1")).toBe(true);
    await revoquerSid(t.base, "sid-1", 1, horloge);
    expect(await revaliderFlux(dep, 1, horloge - 10, "sid-1")).toBe(false);
    expect(await revaliderFlux(dep, 1, horloge - 10, null)).toBe(true);
    await leverMinSession(t.base, 1, horloge - 5);
    expect(await revaliderFlux(dep, 1, horloge - 10, null)).toBe(false);
    expect(await revaliderFlux(dep, 2, horloge - 10, null)).toBe(true);
    await t.base.run("DELETE FROM users WHERE id=?", [2]);
    expect(await revaliderFlux(dep, 2, horloge - 10, null)).toBe(false);
  });

  it("attributs du cookie figés à l'installation : un changement ultérieur ne déconnecte personne", async () => {
    const c = await connecter(1);
    attributs = { cookie_name: "autre", same_site: "strict", https_only: true, max_age: 10 };
    horloge += 100;
    expect((await app.inject({ method: "GET", url: "/moi", headers: { cookie: c } })).json()).toEqual({
      id: 1,
      nom: "alice",
    });
    expect(await connecter(2)).toMatch(/^mcpwebui_session=/u);
  });

  it("rôles : staff (admin, modérateur), admin seul", async () => {
    const [a, m, u] = [await connecter(2), await connecter(3), await connecter(1)];
    expect((await app.inject({ method: "GET", url: "/staff", headers: { cookie: m } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/staff", headers: { cookie: u } })).json()).toEqual({
      detail: "Staff required",
    });
    expect((await app.inject({ method: "GET", url: "/admin", headers: { cookie: a } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin", headers: { cookie: m } })).json()).toEqual({
      detail: "Admin required",
    });
    expect(refus).toEqual([
      ["role", "/staff", { required: "staff", role: 0 }],
      ["role", "/admin", { required: "admin", role: 2 }],
    ]);
  });

  it("CSRF : mutante cross-site avec cookie refusée, sans cookie ou webhook laissée passer", async () => {
    const c = await connecter(1);
    const autre = { cookie: c, origin: "http://autre:3000", host: "localhost:80" };
    expect((await app.inject({ method: "POST", url: "/ecrire", headers: autre })).json()).toEqual({
      detail: "Requête cross-site refusée.",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/ecrire",
          headers: { ...autre, origin: "http://localhost:80" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/ecrire", headers: { "sec-fetch-site": "cross-site" } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/webhooks/x", headers: autre })).statusCode).toBe(
      200,
    );
    expect(refus).toEqual([["csrf", "/ecrire", { origin: "http://autre:3000", sec_fetch_site: "" }]]);
  });

  it("CSRF de connexion : /api/login-lite contrôlée même sans cookie, clients sans en-têtes de navigateur admis", async () => {
    const statut = async (headers: Record<string, string>): Promise<number> =>
      (await app.inject({ method: "POST", url: "/api/login-lite", headers })).statusCode;
    expect(await statut({ "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await statut({ "sec-fetch-site": "same-site" })).toBe(403);
    expect(await statut({ origin: "http://autre:3000", host: "localhost:80" })).toBe(403);
    expect(await statut({ origin: "null" })).toBe(403);
    expect(await statut({ "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await statut({ origin: "http://localhost:80", host: "localhost:80" })).toBe(200);
    expect(await statut({})).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/cookie-route",
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("boucle locale (socket, pas d'en-tête de relais) et jeton de service", async () => {
    expect((await app.inject({ method: "GET", url: "/boucle", remoteAddress: "127.0.0.1" })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/boucle",
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "10.0.0.1" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: "/boucle", remoteAddress: "10.0.0.2" })).statusCode).toBe(
      403,
    );
    expect(refus).toEqual([
      ["loopback", "/boucle", {}],
      ["loopback", "/boucle", {}],
    ]);
    expect(
      (await app.inject({ method: "GET", url: "/service", headers: { authorization: "Bearer jeton-svc" } }))
        .statusCode,
    ).toBe(200);
    const r = await app.inject({ method: "GET", url: "/service", headers: { authorization: "Bearer faux" } });
    expect([r.statusCode, r.headers["www-authenticate"]]).toEqual([401, "Bearer"]);
  });
});
