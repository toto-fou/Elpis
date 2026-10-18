// SPDX-License-Identifier: MIT
/** packages/db/src/test.ts — bases jetables pour les tests : SQLite dans un dossier temporaire, PostgreSQL dans un schéma à part. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import type { Base } from "./base";
import { BasePostgres } from "./postgres";
import type { ReglagesPostgres } from "./postgres";
import { BaseSqlite } from "./sqlite";

/** URL du PostgreSQL de test (`postgres://u:p@hôte:port/base`), absente = tests PostgreSQL sautés. */
export const PG_DE_TEST = process.env.ELPIS_TEST_PG ?? "";

export interface BaseDeTest {
  base: Base;
  /** SQLite : chemin du fichier ; PostgreSQL : nom du schéma. */
  emplacement: string;
  fermer(): Promise<void>;
}

export function reglagesPgDeTest(schema: string): ReglagesPostgres {
  if (!PG_DE_TEST) throw new Error("ELPIS_TEST_PG absent : PostgreSQL de test indisponible");
  const u = new URL(PG_DE_TEST);
  return {
    backend: "postgres",
    host: u.hostname,
    port: Number(u.port || 5432),
    name: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    schema,
    poolMax: 4,
    timeout: 20,
  };
}

export function ouvrirBaseDeTest(moteur: "sqlite" | "postgres"): BaseDeTest {
  if (moteur === "sqlite") {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-db-"));
    const chemin = join(dossier, "app.db");
    const base = new BaseSqlite({ backend: "sqlite", path: chemin, lockTimeoutMs: 2000 });
    return {
      base,
      emplacement: chemin,
      fermer: async () => {
        await base.fermer();
        rmSync(dossier, { recursive: true, force: true });
      },
    };
  }
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const r = reglagesPgDeTest(schema);
  const base = new BasePostgres(r);
  return {
    base,
    emplacement: schema,
    fermer: async () => {
      await base.fermer();
      const admin = new pg.Client({
        host: r.host,
        port: r.port,
        database: r.name,
        user: r.user,
        password: r.password,
      });
      await admin.connect();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
