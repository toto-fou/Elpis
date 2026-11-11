// SPDX-License-Identifier: MIT
/** apps/core/test/flux-session.test.ts — réponse en flux détournée : cookie de session, Vary et Set-Cookie multiples posés par entetesFlux. */
import { creerGardes, installerAuth } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entetesFlux, installerEntetesSecurite } from "@elpis/http";

let t: BaseDeTest;
let app: FastifyInstance;
let horloge = 1_791_331_200;

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', 's', 'h', 0)",
  );
  const dep: DependancesAuth = {
    base: t.base,
    config: () => ({ security: { session: { idle_timeout_sec: 600 } } }),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => "secret-de-test",
    jetonService: () => "",
    maintenant: () => horloge,
  };
  app = Fastify();
  installerAuth(app, dep);
  installerEntetesSecurite(app);
  const g = creerGardes(dep);
  app.post("/connexion", async (req) => {
    req.session.set("user_id", 1);
    req.session.set("_login_ts", horloge);
    return { ok: true };
  });
  app.get("/flux", { onRequest: g.session }, async (_req, rep) => {
    void rep.header("set-cookie", "autre=1; path=/");
    rep.hijack();
    rep.raw.writeHead(200, entetesFlux(rep, { "content-type": "text/event-stream" }));
    rep.raw.end("data: ok\n\n");
  });
  app.get("/flux-anonyme", async (req, rep) => {
    req.session.get("user_id");
    rep.hijack();
    rep.raw.writeHead(200, entetesFlux(rep, { "content-type": "text/event-stream" }));
    rep.raw.end("data: ok\n\n");
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await t.fermer();
});

describe("réponse en flux détournée", () => {
  it("cookie de session réécrit (_last_activity_ts), Vary, Set-Cookie de la route et sécurité", async () => {
    const connexion = await app.inject({ method: "POST", url: "/connexion" });
    const cookie = String(connexion.headers["set-cookie"]).split(";")[0] ?? "";
    horloge += 100;
    const r = await app.inject({ method: "GET", url: "/flux", headers: { cookie } });
    expect(r.body).toBe("data: ok\n\n");
    const cookies = r.headers["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe("autre=1; path=/");
    expect(cookies[1]).toMatch(/^mcpwebui_session=.+; path=\/; Max-Age=86400; httponly; samesite=lax$/u);
    expect(cookies[1]).not.toBe(cookie);
    expect(r.headers.vary).toBe("Cookie");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-type"]).toBe("text/event-stream");
  });

  it("session lue sans modification : Vary seul, aucun cookie", async () => {
    const r = await app.inject({ method: "GET", url: "/flux-anonyme" });
    expect(r.headers.vary).toBe("Cookie");
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
});
