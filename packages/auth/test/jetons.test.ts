// SPDX-License-Identifier: MIT
/** packages/auth/test/jetons.test.ts — jetons personnels : vecteurs Python (préfixes, noms, demandes, politique) et cycle de vie sur SQLite et PostgreSQL. */
import { readFileSync } from "node:fs";

import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { tokenDigest } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  creerJeton,
  FAMILLES_EXTERNES,
  lireJeton,
  listerJetons,
  nomPropre,
  PREFIXES,
  politique,
  regenererJeton,
  resoudreJeton,
  revoquerJeton,
  revoquerTousAcces,
  supprimerJetonsCompte,
  typeDe,
  validerDemandeOutils,
  VISION_TTL_S,
} from "../src/jetons";
import type { DependancesJetons, Politique } from "../src/jetons";

interface VecteursJetons {
  prefixes: Record<string, string>;
  familles_externes: string[];
  kind_of: { jeton: string; type: string | null }[];
  noms: { nom: string | null; propre: string }[];
  demandes: {
    familles: unknown;
    jours: unknown;
    max_days: number;
    retenues?: string[];
    expire?: number | null;
    erreur?: string;
  }[];
  politiques: { config: Record<string, unknown>; politique: Politique }[];
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/auth.json", import.meta.url), "utf-8")) as {
  maintenant: number;
  jetons: VecteursJetons;
};
const J = V.jetons;

function imbriquer(plat: Record<string, unknown>): Record<string, unknown> {
  const racine: Record<string, unknown> = {};
  for (const [chemin, v] of Object.entries(plat)) {
    const cles = chemin.split(".");
    let o = racine;
    for (const c of cles.slice(0, -1)) o = (o[c] ??= {}) as Record<string, unknown>;
    o[cles[cles.length - 1] as string] = v;
  }
  return racine;
}

describe("vecteurs Python (accounts/tokens.py)", () => {
  it("préfixes et familles externes", () => {
    expect(PREFIXES).toEqual(J.prefixes);
    expect(FAMILLES_EXTERNES).toEqual(J.familles_externes);
  });

  it.each(J.kind_of.map((c) => [c.jeton, c] as const))("kind_of(%j)", (_n, c) => {
    expect(typeDe(c.jeton)).toBe(c.type);
  });

  it.each(J.noms.map((c) => [c.nom, c] as const))("_clean_name(%j)", (_n, c) => {
    expect(nomPropre(c.nom, "outils")).toBe(c.propre);
  });

  it.each(J.demandes.map((c, i) => [i, c] as const))("_validate_tools_request %i", (_i, c) => {
    const pol: Politique = {
      tools_enabled: true,
      tools_families: ["fs", "shell", "git"],
      max_days: c.max_days,
      max_per_user: 20,
    };
    if (c.erreur !== undefined) {
      expect(() => validerDemandeOutils(c.familles, c.jours, pol, V.maintenant)).toThrow(c.erreur);
    } else {
      expect(validerDemandeOutils(c.familles, c.jours, pol, V.maintenant)).toEqual([c.retenues, c.expire]);
    }
  });

  it.each(J.politiques.map((c) => [JSON.stringify(c.config), c] as const))("policy %s", (_n, c) => {
    expect(politique(imbriquer(c.config))).toEqual(c.politique);
  });
});

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
let horloge = 1_791_331_200; // partagée entre moteurs : le cache de last_used_at est global au processus

describe.each(MOTEURS)("cycle de vie (%s)", (moteur) => {
  let t: BaseDeTest;
  let dep: DependancesJetons;
  let config: Record<string, unknown>;
  let alice = 0;
  let bob = 0;

  beforeEach(async () => {
    horloge += 10_000_000;
    config = {};
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    const ids: number[] = [];
    for (const nom of ["alice", "bob"]) {
      ids.push(
        await t.base.insertId(
          "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, must_change_pwd) VALUES (?, 's', 'h', 0, 0, 0)",
          [nom],
        ),
      );
    }
    [alice, bob] = ids as [number, number];
    dep = { base: t.base, config: () => config, maintenant: () => horloge };
  });

  afterEach(async () => {
    await t.fermer();
  });

  it("crée un jeton d'outils, ne garde que son empreinte et le résout", async () => {
    const [jeton, l] = await creerJeton(dep, alice, "tools", "  Mon \t jeton ", ["git", " fs "], 30);
    expect(jeton).toMatch(/^ept_[A-Za-z0-9_-]{40}$/);
    expect(l).toEqual({
      id: l.id,
      user_id: alice,
      kind: "tools",
      name: "Mon jeton",
      hint: jeton.slice(-4),
      families: ["fs", "git"],
      created_at: horloge,
      expires_at: horloge + 30 * 86400,
      last_used_at: null,
    });
    const brut = await t.base.all("SELECT * FROM tool_tokens");
    expect(brut).toHaveLength(1);
    expect(brut[0]?.token_hash).toBe(tokenDigest(jeton));
    expect(JSON.stringify(brut)).not.toContain(jeton);
    const attendu = {
      id: l.id,
      user_id: alice,
      username: "alice",
      kind: "tools",
      name: "Mon jeton",
      families: ["fs", "git"],
      expires_at: horloge + 30 * 86400,
    };
    expect(await resoudreJeton(dep, jeton)).toEqual(attendu);
    expect(await resoudreJeton(dep, `\x1c ${jeton}\n`)).toEqual(attendu);
    expect(await resoudreJeton(dep, jeton, ["vision"])).toBeNull();
    expect(await resoudreJeton(dep, jeton.slice(0, -1) + (jeton.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await resoudreJeton(dep, "ept_court")).toBeNull();
    expect(await lireJeton(t.base, alice, l.id)).toEqual({ ...l, last_used_at: horloge });
    expect(await lireJeton(t.base, bob, l.id)).toBeNull();
  });

  it("refuse un jeton expiré, hors politique ou d'un compte supprimé", async () => {
    const [jeton] = await creerJeton(dep, alice, "tools", "", ["fs", "git"], 1);
    config = { mcp: { tokens: { tools_families: "git" } } };
    expect((await resoudreJeton(dep, jeton))?.families).toEqual(["git"]);
    config = { mcp: { tokens: { tools_families: "shell" } } };
    expect(await resoudreJeton(dep, jeton)).toBeNull();
    config = { mcp: { tokens: { tools_enabled: "off" } } };
    expect(await resoudreJeton(dep, jeton)).toBeNull();
    config = {};
    horloge += 86400;
    expect(await resoudreJeton(dep, jeton)).toBeNull();
    horloge -= 1;
    expect(await resoudreJeton(dep, jeton)).not.toBeNull();
    await t.base.run("DELETE FROM users WHERE id=?", [alice]);
    expect(await resoudreJeton(dep, jeton)).toBeNull();
  });

  it("respecte les interrupteurs de l'administrateur et les types ; un ancien jeton `pcr_` ne résout plus rien", async () => {
    for (const type of ["autre", "opencode"])
      await expect(creerJeton(dep, alice, type)).rejects.toThrow("Type de jeton inconnu.");
    const ancien = `pcr_${"a".repeat(40)}`;
    await t.base.run(
      "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
      [alice, "opencode", "opencode", tokenDigest(ancien), "aaaa", "", horloge],
    );
    for (const types of [undefined, ["opencode"], ["tools", "vision"]])
      expect(await resoudreJeton(dep, ancien, types)).toBeNull();
    config = { mcp: { tokens: { tools_enabled: false } } };
    await expect(creerJeton(dep, alice, "tools", "", ["fs"])).rejects.toThrow(
      "Les jetons d'outils sont désactivés par l'administrateur.",
    );
    config = { mcp: { tokens: { max_days: 10 } } };
    await expect(creerJeton(dep, alice, "tools", "", ["fs"], 11)).rejects.toThrow(
      "Durée maximale : 10 jours.",
    );
    expect((await creerJeton(dep, alice, "tools", "", ["fs"]))[1].expires_at).toBe(horloge + 10 * 86400);
  });

  it("plafonne les jetons valides par compte, hors vision et expirés", async () => {
    config = { mcp: { tokens: { max_per_user: 2 } } };
    await creerJeton(dep, alice, "tools", "", ["fs"], 1);
    await creerJeton(dep, alice, "tools", "", ["git"]);
    await creerJeton(dep, alice, "vision");
    await expect(creerJeton(dep, alice, "tools", "", ["fs"])).rejects.toThrow(
      "Nombre maximal de jetons atteint (2). Révoquez-en un d'abord.",
    );
    await creerJeton(dep, bob, "tools", "", ["fs"]);
    horloge += 86400;
    await creerJeton(dep, alice, "tools", "", ["fs"]);
    expect(await t.base.all("SELECT id FROM tool_tokens WHERE user_id=?", [alice])).toHaveLength(4);
  });

  it("vision : 12 h, vingt par compte au plus, masqués de la liste", async () => {
    const [ancien] = await creerJeton(dep, bob, "vision");
    horloge += VISION_TTL_S + 1;
    const vus: string[] = [];
    for (let i = 0; i < 21; i++) {
      horloge += 1;
      vus.push((await creerJeton(dep, alice, "vision"))[0]);
    }
    expect(await t.base.all("SELECT id FROM tool_tokens WHERE user_id=?", [bob])).toHaveLength(0);
    expect(await listerJetons(t.base, alice)).toEqual([]);
    const caches = await listerJetons(t.base, alice, true);
    expect(caches).toHaveLength(20);
    expect(await lireJeton(t.base, alice, caches[0]?.id ?? 0)).toBeNull();
    expect(await resoudreJeton(dep, vus[0] ?? "", ["vision"])).toBeNull();
    expect((await resoudreJeton(dep, vus[20] ?? "", ["vision"]))?.kind).toBe("vision");
    expect(await resoudreJeton(dep, vus[20] ?? "")).toBeNull();
    expect(await resoudreJeton(dep, ancien, ["vision"])).toBeNull();
    horloge += VISION_TTL_S;
    expect(await resoudreJeton(dep, vus[20] ?? "", ["vision"])).toBeNull();
  });

  it("liste, révoque un jeton, purge un compte", async () => {
    const [, a] = await creerJeton(dep, alice, "tools", "a", ["git"]);
    await creerJeton(dep, alice, "tools", "b", ["fs"]);
    horloge += 1;
    await creerJeton(dep, alice, "tools", "c", ["shell"]);
    await creerJeton(dep, bob, "tools", "", ["fs"]);
    expect((await listerJetons(t.base, alice)).map((l) => l.name)).toEqual(["c", "b", "a"]);
    expect(await revoquerJeton(t.base, bob, a.id)).toBe(false);
    expect(await revoquerJeton(t.base, alice, a.id)).toBe(true);
    expect(await revoquerJeton(t.base, alice, a.id)).toBe(false);
    expect((await listerJetons(t.base, alice)).map((l) => l.name)).toEqual(["c", "b"]);
    await supprimerJetonsCompte(t.base, bob);
    expect(await t.base.all("SELECT id FROM tool_tokens")).toHaveLength(2);
    await supprimerJetonsCompte(t.base, alice);
    expect(await t.base.all("SELECT id FROM tool_tokens")).toHaveLength(0);
  });

  it("régénère sous les mêmes nom, familles et durée, et laisse l'ancien intact en cas de refus", async () => {
    const [vieux, l] = await creerJeton(dep, alice, "tools", "ci", ["shell", "fs"], 30);
    expect(await regenererJeton(dep, bob, l.id)).toBeNull();
    config = { mcp: { tokens: { tools_families: "git" } } };
    await expect(regenererJeton(dep, alice, l.id)).rejects.toThrow(
      "Aucune des familles de ce jeton n'est encore autorisée.",
    );
    config = { mcp: { tokens: { tools_enabled: false } } };
    await expect(regenererJeton(dep, alice, l.id)).rejects.toThrow(
      "Les jetons d'outils sont désactivés par l'administrateur.",
    );
    config = {};
    expect(await resoudreJeton(dep, vieux)).not.toBeNull();
    horloge += 1000;
    config = { mcp: { tokens: { tools_families: "fs,git", max_days: 10 } } };
    const r = await regenererJeton(dep, alice, l.id);
    expect(r?.[0]).not.toBe(vieux);
    expect(r?.[1]).toMatchObject({
      name: "ci",
      kind: "tools",
      families: ["fs"],
      expires_at: horloge + 10 * 86400,
    });
    expect(await resoudreJeton(dep, vieux)).toBeNull();
    expect((await resoudreJeton(dep, r?.[0] ?? ""))?.id).toBe(r?.[1].id);
  });

  it("n'écrit last_used_at qu'au plus toutes les cinq minutes", async () => {
    const [jeton, l] = await creerJeton(dep, alice, "tools", "", ["fs"]);
    const vu = async (): Promise<unknown> =>
      (await t.base.get<{ v: number | null }>("SELECT last_used_at AS v FROM tool_tokens WHERE id=?", [l.id]))
        ?.v;
    await resoudreJeton(dep, jeton, ["tools"], false);
    expect(await vu()).toBeNull();
    await resoudreJeton(dep, jeton);
    const premier = horloge;
    expect(await vu()).toBe(premier);
    horloge += 299;
    await resoudreJeton(dep, jeton);
    expect(await vu()).toBe(premier);
    horloge += 1;
    await resoudreJeton(dep, jeton);
    expect(await vu()).toBe(horloge);
  });

  it("révoque tous les accès non interactifs d'un compte", async () => {
    await creerJeton(dep, alice, "tools", "", ["git"]);
    await creerJeton(dep, alice, "tools", "", ["fs"]);
    await creerJeton(dep, alice, "vision");
    await creerJeton(dep, bob, "tools", "", ["fs"]);
    const oauth: number[] = [];
    dep.revoquerOauth = async (uid) => {
      oauth.push(uid);
      return 2;
    };
    expect(await revoquerTousAcces(dep, alice)).toEqual({ tokens: 3, oauth: 2 });
    expect(oauth).toEqual([alice]);
    const avis: string[] = [];
    dep.revoquerOauth = () => Promise.reject(new Error("oauth indisponible"));
    dep.avertir = (m, e) => avis.push(`${m} : ${(e as Error).message}`);
    expect(await revoquerTousAcces(dep, bob)).toEqual({ tokens: 1, oauth: 0 });
    expect(avis).toEqual([`[tokens] révocation OAuth du compte ${bob} impossible : oauth indisponible`]);
  });
});
