// SPDX-License-Identifier: MIT
/** packages/auth/test/revocations.test.ts — révocation par `_sid` et par compte, sur SQLite et PostgreSQL. */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dureeMaxSession, estRevoquee, leverMinSession, purgerRevocations, revoquerSid } from "../src/index";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe.each(MOTEURS)("révocations (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
  });

  afterEach(async () => {
    await t.fermer();
  });

  it("révoque un _sid une fois, tronqué à 128 caractères", async () => {
    expect(await revoquerSid(t.base, "", 1, 10)).toBe(false);
    expect(await estRevoquee(t.base, "")).toBe(false);
    expect(await revoquerSid(t.base, "abc", 1, 10)).toBe(true);
    expect(await revoquerSid(t.base, "abc", null, 20)).toBe(true);
    expect(await t.base.all("SELECT sid, user_id, revoked_at FROM revoked_sessions")).toEqual([
      { sid: "abc", user_id: 1, revoked_at: 10 },
    ]);
    const long = "é".repeat(127) + "😀xyz";
    await revoquerSid(t.base, long, null, 10);
    expect(await estRevoquee(t.base, long)).toBe(true);
    expect(await estRevoquee(t.base, "é".repeat(127) + "😀")).toBe(true);
    expect(await estRevoquee(t.base, "abd")).toBe(false);
  });

  it("purge les révocations dont l'échéance est passée, jamais celles sans échéance", async () => {
    await revoquerSid(t.base, "a", null, 100, 500);
    await revoquerSid(t.base, "b", null, 100, 1500);
    await revoquerSid(t.base, "c", null, 100);
    expect(await purgerRevocations(t.base, 1000)).toBe(1);
    expect(await estRevoquee(t.base, "a")).toBe(false);
    expect(await estRevoquee(t.base, "b")).toBe(true);
    expect(await estRevoquee(t.base, "c")).toBe(true);
  });

  it("lève l'époque de révocation d'un compte sans jamais la baisser", async () => {
    const uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', 's', 'h', 0)",
    );
    const lire = async () =>
      (await t.base.get<{ v: number }>("SELECT session_min_ts AS v FROM users WHERE id=?", [uid]))?.v;
    expect(await leverMinSession(t.base, uid, 1234.5)).toBe(true);
    expect(await lire()).toBe(1234.5);
    expect(await leverMinSession(t.base, uid, 1000)).toBe(false);
    expect(await leverMinSession(t.base, uid, 1234.5)).toBe(false);
    expect(await lire()).toBe(1234.5);
    expect(await leverMinSession(t.base, uid, 2000)).toBe(true);
    expect(await lire()).toBe(2000);
    expect(await leverMinSession(t.base, uid + 1, 1)).toBe(false);
  });

  it("la coupure d'un compte supprime ses lignes de session du fournisseur d'identité, pas celles des autres", async () => {
    const compte = (nom: string): Promise<number> =>
      t.base.insertId(
        `INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('${nom}', 's', 'h', 0)`,
      );
    const [a, b] = [await compte("alice"), await compte("bob")];
    for (const [sid, uid] of [
      ["s1", a],
      ["s2", a],
      ["s3", b],
    ] as const)
      await t.base.run(
        "INSERT INTO auth_ext_sessions(sid, user_id, provider_id, subject, expires_at) VALUES(?,?,?,?,?)",
        [sid, uid, "sso", "x", 9999],
      );
    await leverMinSession(t.base, a, 10);
    expect(await t.base.valeurs("SELECT sid FROM auth_ext_sessions")).toEqual([["s3"]]);
  });

  it("purge par échéance : la ligne reste tant que la session n'a pas expiré, quelle que soit la durée de configuration", async () => {
    await revoquerSid(t.base, "vivante", null, 100, 5000);
    await revoquerSid(t.base, "expiree", null, 100, 900);
    await revoquerSid(t.base, "sans-echeance", null, 100);
    await revoquerSid(t.base, "sans-echeance-recente", null, 990);
    expect(await purgerRevocations(t.base, 1000, 50)).toBe(1);
    expect(await estRevoquee(t.base, "expiree")).toBe(false);
    expect(await estRevoquee(t.base, "vivante")).toBe(true);
    expect(await estRevoquee(t.base, "sans-echeance")).toBe(true);
    expect(await estRevoquee(t.base, "sans-echeance-recente")).toBe(true);
    expect(await purgerRevocations(t.base, 5051, 50)).toBe(1);
    expect(await estRevoquee(t.base, "vivante")).toBe(false);
    expect(await estRevoquee(t.base, "sans-echeance")).toBe(true);
  });

  it("échéance inconnue : la ligne part quand la révocation dépasse la durée maximale d'une session, plus tôt jamais", async () => {
    await revoquerSid(t.base, "ancienne", null, 100);
    await revoquerSid(t.base, "recente", null, 600);
    expect(await purgerRevocations(t.base, 1000, 50, 400)).toBe(1);
    expect(await estRevoquee(t.base, "ancienne")).toBe(false);
    expect(await estRevoquee(t.base, "recente")).toBe(true);
  });

  it("durée de vie d'une session lue dans la configuration, 86400 par défaut", () => {
    expect(dureeMaxSession({ security: { session: { max_age_sec: 120 } } })).toBe(120);
    expect(dureeMaxSession({})).toBe(86400);
    expect(dureeMaxSession(null)).toBe(86400);
    expect(dureeMaxSession({ security: { session: { max_age_sec: 90 * 86400 } } })).toBe(2_592_000);
  });
});
