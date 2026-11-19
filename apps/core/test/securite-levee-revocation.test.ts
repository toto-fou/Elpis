// SPDX-License-Identifier: MIT
/** apps/core/test/securite-levee-revocation.test.ts — lever la révocation d'un compte n'écrit rien et ne fait jamais revivre une session émise avant la coupure, même si la durée de vie d'une session est allongée ensuite (409 tant que la coupure protège encore). */
import {
  createUser,
  dependancesParDefaut,
  dependancesSession,
  leverMinSession,
  Session,
  validerSession,
} from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleAdminSecurite } from "../src/familles/admin-securite";
import { journalDeTest } from "./journal-securite/aides-journal";
import type { JournalDeTest } from "./journal-securite/aides-journal";
import { appTest, journalMuet } from "./aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const MAX_AGE = 1000;
const URL = (uid: number): string => `/api/admin/security/sessions/clear-user-revocation/${uid}`;

describe.each(MOTEURS)("levée de révocation (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let j: JournalDeTest;
  let maintenant = 100_000;
  let uid = 0;

  const auth = (base: BaseDeTest["base"]) => ({
    ...dependancesParDefaut(base),
    maintenant: () => maintenant,
    config: () => ({ security: { session: { max_age_sec: MAX_AGE } } }),
  });

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await createUser(t.base, "root", "mdp-root", { isAdmin: 1 });
    uid = await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
    j = journalDeTest("admin");
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminSecurite({
          base: t.base,
          auth: auth(t.base),
          journal: journalMuet,
          revoquer: async () => null,
          diffuser: async () => true,
        }),
      ],
      gardes: {
        admin: (req) => {
          req.utilisateur = { id: 1, username: "root" };
        },
        staff: (req) => {
          req.utilisateur = { id: 1, username: "root" };
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
    j.fermer();
    await t.fermer();
  });

  const minCompte = async (): Promise<unknown> =>
    (await t.base.get<{ v: number | null }>("SELECT session_min_ts AS v FROM users WHERE id=?", [uid]))?.v;

  it("coupure récente : 409, la coupure reste et l'ancienne session reste refusée", async () => {
    await leverMinSession(t.base, uid, maintenant - 10);
    const r = await app.inject({ method: "POST", url: URL(uid) });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail ?? r.body).toMatch(/Levée possible à partir du/u);
    expect(await minCompte()).toBe(maintenant - 10);
    const s = new Session({ _login_ts: maintenant - 500, _sid: "s" });
    const v = await validerSession(s, uid, dependancesSession(auth(t.base)));
    expect(v.valide).toBe(false);
    expect(j.derniere("admin.security.sessions.clear_user_revocation.denied")).toMatchObject({
      outcome: "failure",
      details: { target_user_id: uid },
    });
    expect(j.de("admin.security.sessions.clear_user_revocation")).toHaveLength(0);
  });

  it("coupure plus vieille que la durée de vie d'une session : 200, la route n'écrit rien et n'audite rien", async () => {
    await leverMinSession(t.base, uid, maintenant - MAX_AGE - 1);
    const r = await app.inject({ method: "POST", url: URL(uid) });
    expect(r.statusCode).toBe(200);
    expect(await minCompte()).toBe(maintenant - MAX_AGE - 1);
    expect(j.de("admin.security.sessions.clear_user_revocation")).toHaveLength(0);
    expect(j.de("admin.security.sessions.clear_user_revocation.denied")).toHaveLength(0);
  });

  it("cookie d'avant la coupure, levée acceptée, durée de vie allongée : le cookie reste refusé", async () => {
    const coupure = maintenant - MAX_AGE - 1;
    await leverMinSession(t.base, uid, coupure);
    expect((await app.inject({ method: "POST", url: URL(uid) })).statusCode).toBe(200);
    const volee = () => new Session({ _login_ts: coupure - 10, _sid: "s" });
    const longue = {
      ...auth(t.base),
      config: () => ({ security: { session: { max_age_sec: 100 * MAX_AGE } } }),
    };
    expect((await validerSession(volee(), uid, dependancesSession(longue))).valide).toBe(false);
    await leverMinSession(t.base, uid, coupure - 500);
    expect(await minCompte()).toBe(coupure);
  });

  it("la vue d'ensemble ne liste que les coupures qui protègent encore", async () => {
    const autre = await createUser(t.base, "carl", "mdp-carl", { isAdmin: 0 });
    await leverMinSession(t.base, uid, maintenant - 10);
    await leverMinSession(t.base, autre, maintenant - MAX_AGE - 1);
    const r = await app.inject({ method: "GET", url: "/api/admin/security/sessions" });
    expect(r.json().revoked_users.map((u: { user_id: number }) => u.user_id)).toEqual([uid]);
  });

  it("coupure exactement à la limite : refusée ; une seconde plus tard : permise", async () => {
    await leverMinSession(t.base, uid, maintenant - MAX_AGE);
    expect((await app.inject({ method: "POST", url: URL(uid) })).statusCode).toBe(409);
    maintenant += 1;
    expect((await app.inject({ method: "POST", url: URL(uid) })).statusCode).toBe(200);
    expect(await minCompte()).toBe(maintenant - 1 - MAX_AGE);
  });

  it("compte sans coupure : 200 sans audit", async () => {
    const r = await app.inject({ method: "POST", url: URL(uid) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, user_id: uid });
    expect(j.de("admin.security.sessions.clear_user_revocation")).toHaveLength(0);
  });
});
