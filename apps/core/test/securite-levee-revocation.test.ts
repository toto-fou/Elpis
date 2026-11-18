// SPDX-License-Identifier: MIT
/** apps/core/test/securite-levee-revocation.test.ts — lever la révocation d'un compte ne fait pas revivre une session émise avant la coupure (409 tant que la coupure est plus récente que la durée de vie d'une session). */
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

  it("coupure plus vieille que la durée de vie d'une session : levée faite et auditée", async () => {
    await leverMinSession(t.base, uid, maintenant - MAX_AGE - 1);
    const r = await app.inject({ method: "POST", url: URL(uid) });
    expect(r.statusCode).toBe(200);
    expect(await minCompte()).toBe(0);
    expect(j.derniere("admin.security.sessions.clear_user_revocation").details).toEqual({
      target_user_id: uid,
    });
    expect(j.de("admin.security.sessions.clear_user_revocation.denied")).toHaveLength(0);
  });

  it("coupure exactement à la limite : refusée ; une seconde plus tard : permise", async () => {
    await leverMinSession(t.base, uid, maintenant - MAX_AGE);
    expect((await app.inject({ method: "POST", url: URL(uid) })).statusCode).toBe(409);
    maintenant += 1;
    expect((await app.inject({ method: "POST", url: URL(uid) })).statusCode).toBe(200);
  });

  it("compte sans coupure : comportement actuel (200, audit de succès)", async () => {
    const r = await app.inject({ method: "POST", url: URL(uid) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, user_id: uid });
    expect(j.derniere("admin.security.sessions.clear_user_revocation").details).toEqual({
      target_user_id: uid,
    });
  });
});
