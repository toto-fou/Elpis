// SPDX-License-Identifier: MIT
/** packages/auth/test/comptes.test.ts — comptes : vecteurs Python (noms, réglages, liste « lite ») rejoués sur SQLite et PostgreSQL. */
import { readFileSync } from "node:fs";

import { ErreurLecturePy } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createUser,
  ErreurNomUtilisateur,
  getAllUsers,
  getUserGroups,
  getUserSettings,
  getUsersLite,
  mergeUserSettings,
  nomCanonique,
  reglagesEnJson,
  resetUserPassword,
  updateUserAvatar,
  validerNomUtilisateur,
  verifyUser,
} from "../src/comptes";
import { revoquerOauthDuCompte } from "../src/oauth";

type Dict = Record<string, unknown>;
interface VecteursComptes {
  comptes: [string, number][];
  groupes: string[];
  membres: [string, string[]][];
  noms: {
    existants: string[];
    cas: { nom: string; ok?: boolean; erreur?: string }[];
    canon: Record<string, string>;
  };
  reglages: {
    ecritures: { doc: Dict; json: string }[];
    lectures: { settings_json?: string | null; absent?: boolean; reglages: Dict }[];
    fideles: { settings_json: string; relu: string; fusion: string }[];
  };
  base: {
    ids: Record<string, number>;
    lite: Record<string, { restreinte: Dict[]; complete: Dict[] }>;
    groupes: Record<string, Dict[]>;
    verif: (number | null)[];
    tous: Dict[];
  };
}

const V = JSON.parse(
  readFileSync(new URL("./vecteurs/comptes.json", import.meta.url), "utf-8"),
) as VecteursComptes;
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

function insererBrut(t: BaseDeTest, nom: string, reglages: string | null = "{}"): Promise<number> {
  return t.base.insertId(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, settings_json) VALUES (?, 's', 'h', 0, ?)",
    [nom, reglages],
  );
}

function groupesTries(l: Dict[], sep: string): Dict[] {
  return l.map((r) => ({ ...r, groups: String(r.groups).split(sep).filter(Boolean).sort().join(sep) }));
}

it.each(Object.entries(V.noms.canon))("_canon_username(%j)", (nom, canon) => {
  expect(nomCanonique(nom)).toBe(canon);
});

it.each(V.reglages.ecritures.map((e, i) => [i, e] as const))("json.dumps des réglages %i", (_i, e) => {
  expect(reglagesEnJson(e.doc)).toBe(e.json);
});

describe.each(MOTEURS)("comptes (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
  });

  afterEach(async () => {
    await t.fermer();
  });

  it("validate_username face aux comptes existants (vecteurs)", async () => {
    for (const n of V.noms.existants) await insererBrut(t, n);
    for (const c of V.noms.cas) {
      const r = await validerNomUtilisateur(t.base, c.nom).then(
        () => ({ ok: true }),
        (e: unknown) => ({ erreur: (e as Error).message, classe: e instanceof ErreurNomUtilisateur }),
      );
      expect(r).toEqual(c.ok ? { ok: true } : { erreur: c.erreur, classe: true });
    }
    await expect(validerNomUtilisateur(t.base, "zed\n")).rejects.toThrow(ErreurNomUtilisateur);
  });

  it("get_user_settings (vecteurs) et avertissement sur JSON corrompu", async () => {
    const avis: string[] = [];
    for (const c of V.reglages.lectures) {
      const uid = c.absent
        ? 999_999
        : await insererBrut(t, `u${avis.length}${Math.random()}`.replace(".", ""), c.settings_json ?? null);
      expect(await getUserSettings(t.base, uid, (m) => avis.push(m))).toEqual(c.reglages);
    }
    expect(avis).toHaveLength(1);
    expect(avis[0]).toMatch(/^\[users\] settings_json corrompu pour uid=\d+ — retour aux défauts/u);
  });

  it("réglages trop imbriqués : RecursionError propagée, ligne intacte ; entier de 4 301 chiffres : ValueError → {}", async () => {
    const profond = `{"a": ${"[".repeat(10_000)}${"]".repeat(10_000)}}`;
    const uid = await insererBrut(t, "profond", profond);
    const avis: string[] = [];
    await expect(getUserSettings(t.base, uid, (m) => avis.push(m))).rejects.toMatchObject({
      nature: "RecursionError",
    });
    await expect(mergeUserSettings(t.base, uid, (s) => void (s.x = 1))).rejects.toThrow(ErreurLecturePy);
    expect((await t.base.get("SELECT settings_json AS s FROM users WHERE id=?", [uid]))?.s).toBe(profond);
    expect(avis).toEqual([]);
    const geant = await insererBrut(t, "geant", `{"n": ${"9".repeat(4301)}}`);
    expect(await getUserSettings(t.base, geant, (m) => avis.push(m))).toEqual({});
    expect(avis).toHaveLength(1);
    expect(await mergeUserSettings(t.base, geant, (s) => void (s.x = 1))).toEqual({ x: 1 });
  });

  it("réglages relus et fusionnés sans perte : NaN, ±Infinity, flottants entiers, grands entiers (vecteurs)", async () => {
    for (const [i, c] of V.reglages.fideles.entries()) {
      const uid = await insererBrut(t, `fidele${i}`, c.settings_json);
      expect(reglagesEnJson(await getUserSettings(t.base, uid))).toBe(c.relu);
      await mergeUserSettings(t.base, uid, (s) => {
        s["assistant_avatar"] = "bot_1_2.png";
      });
      expect((await t.base.get("SELECT settings_json AS s FROM users WHERE id=?", [uid]))?.s).toBe(c.fusion);
    }
  });

  it("base peuplée : ids, liste « lite », groupes, verify_user, get_all_users (vecteurs)", async () => {
    const ids: Record<string, number> = {};
    for (const [nom, admin] of V.comptes)
      ids[nom] = await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
    expect(ids).toEqual(V.base.ids);
    const gids: Record<string, number> = {};
    for (const g of V.groupes)
      gids[g] = await t.base.insertId('INSERT INTO "groups"(name, description, created_at) VALUES(?,?,?)', [
        g,
        `desc ${g}`,
        0,
      ]);
    for (const [nom, gs] of V.membres)
      for (const g of gs)
        await t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [
          ids[nom] ?? 0,
          gids[g] ?? 0,
        ]);
    for (const [nom, uid] of Object.entries(ids)) {
      const attendu = V.base.lite[nom];
      expect(groupesTries(await getUsersLite(t.base, uid, true), ",")).toEqual(
        groupesTries(attendu?.restreinte ?? [], ","),
      );
      expect(groupesTries(await getUsersLite(t.base, uid, false), ", ")).toEqual(
        groupesTries(attendu?.complete ?? [], ", "),
      );
      expect(await getUserGroups(t.base, uid)).toEqual(V.base.groupes[nom]);
    }
    expect([
      await verifyUser(t.base, "bob", "mdp-bob"),
      await verifyUser(t.base, "bob", "faux"),
      await verifyUser(t.base, "zed", "x"),
      await verifyUser(t.base, "Bob", "mdp-bob"),
    ]).toEqual(V.base.verif);
    expect((await getAllUsers(t.base)).map(({ created_at: _c, ...r }) => r)).toEqual(V.base.tous);
  });

  it("create_user refuse un nom invalide sans rien écrire ; must_change_pwd et réglages vides", async () => {
    await expect(createUser(t.base, "a b", "x")).rejects.toThrow(ErreurNomUtilisateur);
    expect(await getAllUsers(t.base)).toEqual([]);
    const uid = await createUser(t.base, "neuf", "x", { mustChangePwd: 1, maintenant: 12.5 });
    expect(
      await t.base.get("SELECT must_change_pwd, settings_json, created_at, is_admin FROM users WHERE id=?", [
        uid,
      ]),
    ).toEqual({
      must_change_pwd: 1,
      settings_json: "{}",
      created_at: 12.5,
      is_admin: 0,
    });
  });

  it("reset du mot de passe, avatar, fusion atomique des réglages", async () => {
    const uid = await createUser(t.base, "alice", "ancien");
    expect(await resetUserPassword(t.base, uid, "nouveau")).toBe(true);
    expect(await verifyUser(t.base, "alice", "ancien")).toBeNull();
    expect(await verifyUser(t.base, "alice", "nouveau")).toBe(uid);
    expect(await resetUserPassword(t.base, uid + 1, "x")).toBe(false);
    await updateUserAvatar(t.base, uid, "1_2.png");
    expect((await t.base.get("SELECT avatar FROM users WHERE id=?", [uid]))?.avatar).toBe("1_2.png");
    await updateUserAvatar(t.base, uid, null);
    expect((await t.base.get("SELECT avatar FROM users WHERE id=?", [uid]))?.avatar).toBeNull();
    await Promise.all(
      Array.from({ length: 10 }, (_v, i) =>
        mergeUserSettings(t.base, uid, (s) => {
          s[`k${i}`] = i;
        }),
      ),
    );
    expect(Object.keys(await getUserSettings(t.base, uid))).toHaveLength(10);
    expect(await mergeUserSettings(t.base, uid + 1, (s) => void (s.x = 1))).toEqual({});
    await t.base.run("UPDATE users SET settings_json='pas du json' WHERE id=?", [uid]);
    expect(await mergeUserSettings(t.base, uid, (s) => void (s.é = "ü"))).toEqual({ é: "ü" });
    expect((await t.base.get("SELECT settings_json AS s FROM users WHERE id=?", [uid]))?.s).toBe(
      '{"é": "ü"}',
    );
  });

  it("révocation OAuth du compte : autorisations valables comptées par grant, jetons et codes supprimés", async () => {
    const alice = await insererBrut(t, "alice");
    const bob = await insererBrut(t, "bob");
    await t.base.run("INSERT INTO oauth_clients(client_id, name, created_at) VALUES ('c1', 'Client', 0)");
    let n = 0;
    const jeton = (uid: number, grant: string, kind: string, extra: Record<string, number | null> = {}) =>
      t.base.run(
        "INSERT INTO oauth_tokens(grant_id, user_id, client_id, kind, token_hash, families, created_at, expires_at, used_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          grant,
          uid,
          "c1",
          kind,
          `h${n++}`,
          "fs",
          1,
          extra.expires_at ?? 1000,
          extra.used_at ?? null,
          extra.revoked_at ?? null,
        ],
      );
    await jeton(alice, "g1", "refresh");
    await jeton(alice, "g1", "refresh");
    await jeton(alice, "g1", "access");
    await jeton(alice, "g2", "refresh");
    await jeton(alice, "g3", "refresh", { revoked_at: 5 });
    await jeton(alice, "g4", "refresh", { used_at: 5 });
    await jeton(alice, "g5", "refresh", { expires_at: 100 });
    await jeton(bob, "g6", "refresh");
    await t.base.run(
      "INSERT INTO oauth_codes(code_hash, client_id, user_id, grant_id, created_at, expires_at) VALUES ('k1','c1',?,'g1',0,1000), ('k2','c1',?,'g6',0,1000)",
      [alice, bob],
    );
    expect(await revoquerOauthDuCompte(t.base, alice, 100)).toBe(2);
    expect(await t.base.all("SELECT grant_id FROM oauth_tokens ORDER BY id")).toEqual([{ grant_id: "g6" }]);
    expect(await t.base.all("SELECT code_hash FROM oauth_codes")).toEqual([{ code_hash: "k2" }]);
    expect(await revoquerOauthDuCompte(t.base, alice, 100)).toBe(0);
  });
});
