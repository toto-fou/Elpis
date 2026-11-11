// SPDX-License-Identifier: MIT
/** packages/db/test/rag.test.ts — tables du RAG intégré sur SQLite et PostgreSQL : création par createAll, contraintes, unicités, cascades. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAll, tableNames } from "../src/schema";
import { ouvrirBaseDeTest, PG_DE_TEST } from "../src/test";
import type { BaseDeTest } from "../src/test";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const TABLES_RAG = ["rag_collections", "rag_documents", "rag_grants", "rag_hidden", "rag_jobs"];
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const D1 = "33333333-3333-4333-8333-333333333333";
const J1 = "44444444-4444-4444-8444-444444444444";

describe.each(MOTEURS)("%s", (moteur) => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await createAll(t.base);
  });
  afterEach(async () => t.fermer());

  async function compte(nom: string): Promise<number> {
    return t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES(?, '', '', 1)",
      [nom],
    );
  }

  async function collection(id: string, owner: number, nom: string, visibilite = "private"): Promise<void> {
    await t.base.run(
      "INSERT INTO rag_collections(id, owner_user_id, name, visibility, created_at, updated_at) VALUES(?,?,?,?,1,1)",
      [id, owner, nom, visibilite],
    );
  }

  async function nombre(table: string): Promise<number> {
    return Number((await t.base.valeurs(`SELECT COUNT(*) FROM ${table}`))[0]?.[0]);
  }

  async function echoue(f: () => Promise<unknown>): Promise<boolean> {
    try {
      await t.base.transaction(async () => f());
      return false;
    } catch {
      return true;
    }
  }

  it("créées par createAll, défauts posés, recréées si une base existante ne les a pas", async () => {
    expect((await tableNames(t.base)).filter((n) => n.startsWith("rag_"))).toEqual(TABLES_RAG);
    const alice = await compte("alice");
    await collection(C1, alice, "Contrats");
    const c = await t.base.get("SELECT * FROM rag_collections WHERE id=?", [C1]);
    expect(c).toMatchObject({
      description: "",
      visibility: "private",
      allow_source_open: 0,
      chunk_json: "{}",
      meta_json: "{}",
      status: "ready",
      doc_count: 0,
      bytes: 0,
    });
    for (const n of ["rag_hidden", "rag_jobs", "rag_documents", "rag_grants", "rag_collections"])
      await t.base.run(`DROP TABLE ${n}`);
    await createAll(t.base);
    expect((await tableNames(t.base)).filter((n) => n.startsWith("rag_"))).toEqual(TABLES_RAG);
  });

  it("visibilité, type de principal et genre de travail fermés ; unicités (compte, nom) et (collection, chemin)", async () => {
    const alice = await compte("alice");
    const bob = await compte("bob");
    await collection(C1, alice, "Contrats");
    expect(await echoue(() => collection(C2, alice, "Contrats"))).toBe(true);
    await collection(C2, bob, "Contrats");
    expect(await echoue(() => collection(J1, alice, "Autre", "public"))).toBe(true);
    expect(
      await echoue(() =>
        t.base.run(
          "INSERT INTO rag_grants(collection_id, principal_type, principal_id, created_at) VALUES(?,?,?,1)",
          [C1, "role", 1],
        ),
      ),
    ).toBe(true);
    expect(
      await echoue(() =>
        t.base.run(
          "INSERT INTO rag_grants(collection_id, principal_type, principal_id, created_at) VALUES(?,?,?,1)",
          ["inconnue", "group", 1],
        ),
      ),
    ).toBe(true);
    expect(
      await echoue(() =>
        t.base.run(
          "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, created_at) VALUES(?,?,?,?,1)",
          [J1, C1, alice, "delete"],
        ),
      ),
    ).toBe(true);
    const doc =
      "INSERT INTO rag_documents(id, collection_id, rel_path, name, ext, created_at) VALUES(?,?,?,?,?,1)";
    await t.base.run(doc, [D1, C1, "a/b.pdf", "b.pdf", "pdf"]);
    expect(await echoue(() => t.base.run(doc, [J1, C1, "a/b.pdf", "b.pdf", "pdf"]))).toBe(true);
    await t.base.run(doc, [J1, C2, "a/b.pdf", "b.pdf", "pdf"]);
  });

  it("cascades : compte supprimé → ses collections et tout ce qui en dépend ; ajout gardé, auteur effacé", async () => {
    const alice = await compte("alice");
    const bob = await compte("bob");
    await collection(C1, alice, "Contrats", "groups");
    await collection(C2, bob, "Notes", "all");
    await t.base.run(
      "INSERT INTO rag_grants(collection_id, principal_type, principal_id, created_at) VALUES(?, 'group', 7, 1)",
      [C1],
    );
    await t.base.run(
      "INSERT INTO rag_documents(id, collection_id, rel_path, name, ext, added_by, created_at) VALUES(?,?,?,?,?,?,1)",
      [D1, C2, "x.md", "x.md", "md", alice],
    );
    await t.base.run(
      "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, created_at) VALUES(?,?,?,?,1)",
      [J1, C1, alice, "ingest"],
    );
    await t.base.run("INSERT INTO rag_hidden(user_id, collection_id, created_at) VALUES(?,?,1)", [alice, C2]);
    await t.base.run("INSERT INTO rag_hidden(user_id, collection_id, created_at) VALUES(?,?,1)", [bob, C1]);
    await t.base.run("DELETE FROM users WHERE id=?", [alice]);
    expect(await t.base.valeurs("SELECT id FROM rag_collections")).toEqual([[C2]]);
    expect(await nombre("rag_grants")).toBe(0);
    expect(await nombre("rag_jobs")).toBe(0);
    expect(await nombre("rag_hidden")).toBe(0);
    expect(await t.base.valeurs("SELECT id, added_by FROM rag_documents")).toEqual([[D1, null]]);
    await t.base.run("DELETE FROM rag_collections WHERE id=?", [C2]);
    expect(await nombre("rag_documents")).toBe(0);
  });
});
