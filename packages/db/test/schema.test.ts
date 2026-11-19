// SPDX-License-Identifier: MIT
/** packages/db/test/schema.test.ts — DDL rendue par le TS identique à celle du Python, table par table, et base neuve identique à init_db(). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  addColumnSql,
  createAll,
  createIndexSql,
  createTableSql,
  pgFtsDocument,
  tableParNom,
} from "../src/schema";
import { TABLES_REMOTE_CODE } from "../src/retrait-remote-code";
import { TABLES } from "../src/schema.gen";
import { ouvrirBaseDeTest } from "../src/test";

interface DdlDialecte {
  table: string;
  index: string[];
  ajout_colonnes: Record<string, string>;
}

/** Écart voulu : les tables de Remote code ont quitté le schéma (migration 0031). */
const retiree = (nom: string): boolean => TABLES_REMOTE_CODE.includes(nom);
const vecteur = JSON.parse(readFileSync(new URL("./vecteurs/schema.json", import.meta.url), "utf-8")) as {
  tables: ({ nom: string } & Partial<Record<"sqlite" | "postgres", DdlDialecte>>)[];
  pg_fts_document: string;
};
const tables = vecteur.tables.filter((t) => !retiree(t.nom));
const ftsPg = vecteur.pg_fts_document;
const python = JSON.parse(readFileSync(new URL("./vecteurs/base_python.json", import.meta.url), "utf-8")) as {
  objets: [string, string, string, string][];
  migrations: string[];
};

describe("DDL table par table", () => {
  it("même liste de tables, dans le même ordre", () => {
    expect(TABLES.map((t) => t.name)).toEqual(tables.map((t) => t.nom));
    expect(TABLES).toHaveLength(52);
    expect(vecteur.tables.filter((t) => retiree(t.nom))).toHaveLength(10);
  });

  const cas = tables.flatMap((t) =>
    (["sqlite", "postgres"] as const)
      .filter((d) => t[d])
      .map((d) => [`${t.nom} ${d}`, t.nom, d, t[d] as DdlDialecte] as const),
  );
  it.each(cas)("%s", (_n, nom, d, ddl) => {
    const t = tableParNom(nom);
    expect(createTableSql(t, d)).toBe(ddl.table);
    expect((t.indexes ?? []).map((ix) => createIndexSql(t, ix, d))).toEqual(ddl.index);
    for (const c of t.cols.filter((x) => x.type !== "id"))
      expect(addColumnSql(c, d)).toBe(ddl.ajout_colonnes[c.name]);
  });
});

describe("plein texte PostgreSQL", () => {
  it("document indexé identique (ponctuation remplacée par des espaces)", () => {
    expect(pgFtsDocument("content")).toBe(ftsPg);
  });
});

describe("base neuve", () => {
  it("sqlite_master identique à celui d'une base créée par init_db()", async () => {
    const t = ouvrirBaseDeTest("sqlite");
    try {
      expect((await createAll(t.base)).fts).toBe(true);
      const objets = await t.base.all<{ type: string; name: string; tbl_name: string; sql: string }>(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
      );
      expect(objets.map((o) => [o.type, o.name, o.tbl_name, o.sql])).toEqual(
        python.objets.filter(([, , table]) => !retiree(table)),
      );
    } finally {
      await t.fermer();
    }
  });
});
