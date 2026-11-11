// SPDX-License-Identifier: MIT
/** packages/auth/test/securite-verify-user-cout.test.ts — `verifyUser` : un refus coûte le même PBKDF2 pour un nom inconnu, un compte à jour et un compte au format ancien. */
import * as crypto from "node:crypto";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUser, verifyUser } from "../src/comptes";

const iterations: number[] = [];

vi.mock("node:crypto", async (original) => {
  const reel = await original<typeof crypto>();
  return {
    ...reel,
    pbkdf2: (...a: Parameters<typeof reel.pbkdf2>) => {
      iterations.push(a[2]);
      reel.pbkdf2(...a);
    },
  };
});

async function cout(action: () => Promise<number | null>): Promise<[number | null, number]> {
  iterations.length = 0;
  const r = await action();
  return [r, iterations.reduce((s, n) => s + n, 0)];
}

describe("verifyUser : coût d'un refus", () => {
  let t: BaseDeTest;
  const sel = "00112233445566778899aabbccddeeff";
  const ancien = crypto.pbkdf2Sync("ancien", Buffer.from(sel, "hex"), 150_000, 32, "sha256").toString("hex");

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "bon");
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, ?, ?, 0, 0)",
      ["carla", sel, ancien],
    );
  });

  afterEach(async () => {
    await t.fermer();
  });

  it("nom inconnu, compte à jour et compte ancien : 600 000 itérations pour chaque mauvais mot de passe", async () => {
    expect(await cout(() => verifyUser(t.base, "nobody", "faux"))).toEqual([null, 600_000]);
    expect(await cout(() => verifyUser(t.base, "alice", "faux"))).toEqual([null, 600_000]);
    expect(await cout(() => verifyUser(t.base, "carla", "faux"))).toEqual([null, 600_000]);
  });

  it("bon mot de passe : compte rendu, sans calcul en plus", async () => {
    const [a, coutA] = await cout(() => verifyUser(t.base, "alice", "bon"));
    expect([typeof a, coutA]).toEqual(["number", 600_000]);
    const [c, coutC] = await cout(() => verifyUser(t.base, "carla", "ancien"));
    expect([typeof c, coutC]).toEqual(["number", 150_000]);
  });

  it("mot de passe non encodable : même refus partout, sans erreur ni calcul", async () => {
    for (const nom of ["nobody", "alice", "carla"])
      expect(await cout(() => verifyUser(t.base, nom, "\ud800")), nom).toEqual([null, 0]);
  });
});
