// SPDX-License-Identifier: MIT
/** packages/db/test/retrait-remote-code.test.ts — migration 0031_remove_remote_code (SQLite, PostgreSQL si ELPIS_TEST_PG) : base neuve tamponnée sans rien à supprimer ; base d'avant : laissée à main par les autres process, puis tables de Remote code supprimées avec leurs index, jetons `opencode` retirés, jetons d'outils et de vision gardés. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialiserBase, MIGRATION_RETRAIT_REMOTE_CODE, TABLES_REMOTE_CODE } from "../src";
import type { Base } from "../src";
import { hasTable } from "../src/schema";
import { ouvrirBaseDeTest, PG_DE_TEST } from "../src/test";
import type { BaseDeTest } from "../src/test";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const NOM = "0031_remove_remote_code";
const MIGRATIONS = { migrations: [MIGRATION_RETRAIT_REMOTE_CODE] };

/** Tables de Remote code présentes dans la base. */
async function restantes(base: Base): Promise<string[]> {
  const l: string[] = [];
  for (const n of TABLES_REMOTE_CODE) if (await hasTable(base, n)) l.push(n);
  return l;
}

/** Index de ce nom, quel que soit le moteur. */
async function indexPresent(base: Base, nom: string): Promise<boolean> {
  const sql =
    base.dialecte === "sqlite"
      ? "SELECT 1 AS un FROM sqlite_master WHERE type='index' AND name=?"
      : "SELECT 1 AS un FROM pg_indexes WHERE indexname=?";
  return (await base.get(sql, [nom])) !== undefined;
}

describe.each(MOTEURS)("migration 0031_remove_remote_code (%s)", (moteur) => {
  let t: BaseDeTest;
  let uid = 0;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, 0)",
      ["alice"],
    );
  });
  afterEach(async () => t.fermer());

  const jetons = async (): Promise<string[]> =>
    (await t.base.all<{ kind: string; name: string }>("SELECT kind, name FROM tool_tokens ORDER BY id")).map(
      (j) => `${j.kind}:${j.name}`,
    );
  const tamponnee = async (base: Base = t.base): Promise<boolean> =>
    (await base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [NOM])) !== undefined;

  /** Base d'avant 0031 : `tables` de Remote code (une ligne chacune, un index), jetons de `genres`, 0031 jamais jouée. */
  async function avant(tables: readonly string[], genres: readonly string[]): Promise<void> {
    for (const n of tables) {
      await t.base.exec(`CREATE TABLE ${n} (user_id INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT)`);
      await t.base.run(`INSERT INTO ${n} (user_id, id, payload) VALUES (?, ?, ?)`, [
        uid,
        "s1",
        "pcr_en_clair",
      ]);
    }
    if (tables.includes("code_commands"))
      await t.base.exec("CREATE INDEX idx_code_commands_user ON code_commands(user_id, id)");
    for (const [i, kind] of genres.entries())
      await t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES (?,?,?,?,?,?,?)",
        [uid, kind, `j${i}`, `empreinte-${i}`, "abcd", kind === "tools" ? "git" : "", 1],
      );
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [NOM]);
  }

  it("base neuve : tamponnée d'office, rien à supprimer, aucune table de Remote code", async () => {
    const neuve = ouvrirBaseDeTest(moteur);
    try {
      const r = await initialiserBase(neuve.base, MIGRATIONS);
      expect([r.neuve, r.appliquees, r.infos, r.aCompacter]).toEqual([true, [], [], []]);
      expect(await tamponnee(neuve.base)).toBe(true);
      expect(await restantes(neuve.base)).toEqual([]);
    } finally {
      await neuve.fermer();
    }
  });

  it("base d'avant, process sans l'implémentation (admin, hôte d'outils) : laissée à main, rien de touché", async () => {
    await avant(TABLES_REMOTE_CODE, ["tools", "opencode", "vision"]);
    const r = await initialiserBase(t.base);
    expect([r.appliquees, r.differees.map((d) => d.name)]).toEqual([[], [NOM]]);
    expect(await tamponnee()).toBe(false);
    expect(await restantes(t.base)).toEqual([...TABLES_REMOTE_CODE]);
    expect(await jetons()).toEqual(["tools:j0", "opencode:j1", "vision:j2"]);
  });

  it("base d'avant, main : les 11 tables supprimées avec leurs index, jetons opencode retirés, outils et vision gardés ; une seule fois", async () => {
    await avant(TABLES_REMOTE_CODE, ["tools", "opencode", "opencode", "vision"]);
    expect(await indexPresent(t.base, "idx_code_commands_user")).toBe(true);
    const r = await initialiserBase(t.base, MIGRATIONS);
    expect([r.echec, r.appliquees, r.infos, r.aCompacter]).toEqual([
      null,
      [NOM],
      [`migration ${NOM} : 11 table(s) supprimée(s), 2 jeton(s) retiré(s)`],
      [],
    ]);
    expect(await tamponnee()).toBe(true);
    expect(await restantes(t.base)).toEqual([]);
    expect(await indexPresent(t.base, "idx_code_commands_user")).toBe(false);
    expect(await jetons()).toEqual(["tools:j0", "vision:j3"]);
    const encore = await initialiserBase(t.base, MIGRATIONS);
    expect([encore.appliquees, encore.infos]).toEqual([[], []]);
  });

  it("base d'avant partielle : seules les tables présentes partent ; sans table ni jeton opencode, aucune note", async () => {
    await avant(["code_sessions", "code_remote_tokens"], ["tools"]);
    const r = await initialiserBase(t.base, MIGRATIONS);
    expect([r.appliquees, r.infos]).toEqual([
      [NOM],
      [`migration ${NOM} : 2 table(s) supprimée(s), 0 jeton(s) retiré(s)`],
    ]);
    expect(await restantes(t.base)).toEqual([]);
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [NOM]);
    const vide = await initialiserBase(t.base, MIGRATIONS);
    expect([vide.appliquees, vide.infos]).toEqual([[NOM], []]);
    expect(await jetons()).toEqual(["tools:j0"]);
  });
});
