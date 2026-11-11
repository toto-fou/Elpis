// SPDX-License-Identifier: MIT
/** packages/auth/test/revocations.test.ts — révocation par `_sid` et par compte, sur SQLite et PostgreSQL. */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  effacerMinSession,
  estRevoquee,
  leverMinSession,
  purgerRevocations,
  revoquerSid,
} from "../src/index";

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

  it("purge les révocations plus vieilles que max_age", async () => {
    for (const [sid, ts] of [
      ["a", 100],
      ["b", 900],
      ["c", 1000],
    ] as const)
      await revoquerSid(t.base, sid, null, ts);
    expect(await purgerRevocations(t.base, 100, 1000)).toBe(1);
    expect(await estRevoquee(t.base, "a")).toBe(false);
    expect(await purgerRevocations(t.base, -5, 1000)).toBe(1);
    expect(await estRevoquee(t.base, "c")).toBe(true);
  });

  it("lève puis efface l'époque de révocation d'un compte", async () => {
    const uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', 's', 'h', 0)",
    );
    expect(await leverMinSession(t.base, uid, 1234.5)).toBe(true);
    expect((await t.base.get("SELECT session_min_ts AS v FROM users WHERE id=?", [uid]))?.v).toBe(1234.5);
    expect(await effacerMinSession(t.base, uid)).toBe(true);
    expect((await t.base.get("SELECT session_min_ts AS v FROM users WHERE id=?", [uid]))?.v).toBe(0);
    expect(await leverMinSession(t.base, uid + 1, 1)).toBe(false);
    expect(await effacerMinSession(t.base, uid + 1)).toBe(false);
  });
});
