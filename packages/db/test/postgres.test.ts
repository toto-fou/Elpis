// SPDX-License-Identifier: MIT
/** packages/db/test/postgres.test.ts — PostgreSQL (ELPIS_TEST_PG=postgres://u:p@hôte:port/base) : mêmes contrats qu'en SQLite. */
import { setTimeout as attendre } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ErreurIntegrite,
  ErreurOperation,
  ErreurProgrammation,
  estTableAbsente,
  ouvrirBase,
} from "../src/index";
import type { Base } from "../src/index";
import { ouvrirBaseDeTest, PG_DE_TEST, reglagesPgDeTest } from "../src/test";
import type { BaseDeTest } from "../src/test";

describe.skipIf(!PG_DE_TEST)("PostgreSQL", () => {
  let t: BaseDeTest;
  let base: Base;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("postgres");
    base = t.base;
    await base.exec(
      "CREATE TABLE t (id BIGSERIAL PRIMARY KEY, nom TEXT UNIQUE, n BIGINT DEFAULT 0, v NUMERIC, b BOOLEAN, x TEXT); " +
        "CREATE TABLE c (nom TEXT PRIMARY KEY, n INTEGER)",
    );
  });

  afterAll(async () => t.fermer());

  it("convertit ?, valeurs et NUL comme l'enveloppe Python", async () => {
    const id = await base.insertId("INSERT INTO t(nom, v, b, x) VALUES (?, ?, ?, ?);", [
      "a",
      2.5,
      true,
      "a\0b",
    ]);
    expect(id).toBe(1);
    expect(await base.get("SELECT nom, n, v, b, x, '?' AS q FROM t WHERE id = ?", [id])).toEqual({
      nom: "a",
      n: 0,
      v: 2.5,
      b: 1,
      x: "ab",
      q: "?",
    });
    expect(await base.get("SELECT COUNT(*) AS n, SUM(n) AS s FROM t")).toEqual({ n: 1, s: 0 });
    expect(await base.run("UPDATE t SET n = n + 1")).toEqual({ changes: 1, lastInsertRowid: null });
  });

  it("classe les erreurs par SQLSTATE", async () => {
    await base.run("INSERT INTO t(nom) VALUES (?)", ["u"]);
    const e = await base.run("INSERT INTO t(nom) VALUES (?)", ["u"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurIntegrite);
    expect(String((e as Error).message)).toMatch(/\[SQLSTATE 23505\]$/u);
    const a = await base.all("SELECT * FROM absente").catch((x: unknown) => x);
    expect(a).toBeInstanceOf(ErreurOperation);
    expect(estTableAbsente(a)).toBe(true);
  });

  it("transaction, point de sauvegarde et erreur avalée sans avorter la transaction", async () => {
    await base.transaction(async () => {
      await base.run("INSERT INTO c(nom, n) VALUES ('s', 1)");
      await base
        .transaction(async () => base.run("INSERT INTO c(nom, n) VALUES ('s', 2)"))
        .catch(() => undefined);
      await base.run("UPDATE c SET n = 3 WHERE nom = 's'");
    });
    expect(await base.get("SELECT n FROM c WHERE nom = 's'")).toEqual({ n: 3 });
  });

  it("une erreur avalée sans point de sauvegarde fait échouer le COMMIT au lieu de perdre le travail en silence", async () => {
    await expect(
      base.transaction(async () => {
        await base.run("INSERT INTO c(nom, n) VALUES ('perdu', 1)");
        await base.run("SELECT * FROM absente").catch(() => undefined);
      }),
    ).rejects.toThrow(/annulée par le serveur/u);
    expect(await base.get("SELECT COUNT(*) AS n FROM c WHERE nom = 'perdu'")).toEqual({ n: 0 });
  });

  it("ecriture() sérialise deux processus (verrou FOR UPDATE sur elpis_locks)", async () => {
    const autre = ouvrirBase(reglagesPgDeTest(t.emplacement));
    await base.run("INSERT INTO c(nom, n) VALUES ('w', 0)");
    const incrementer = (b: Base) =>
      b.ecriture(async () => {
        const r = await b.get<{ n: number }>("SELECT n FROM c WHERE nom = 'w'");
        await attendre(2);
        await b.run("UPDATE c SET n = ? WHERE nom = 'w'", [(r?.n ?? 0) + 1]);
      });
    await Promise.all(Array.from({ length: 10 }, (_v, i) => incrementer(i % 2 ? base : autre)));
    expect(await base.get("SELECT n FROM c WHERE nom = 'w'")).toEqual({ n: 10 });
    expect(autre.stats()?.max).toBe(4);
    await autre.fermer();
  });

  it("une coupure serveur pendant une transaction rejette sans arrêter le processus", async () => {
    const autre = ouvrirBase(reglagesPgDeTest(t.emplacement));
    const pid = { v: 0 };
    await expect(
      autre.transaction(async (x) => {
        pid.v = Number((await x.get<{ p: number }>("SELECT pg_backend_pid() AS p"))?.p);
        await base.run("SELECT pg_terminate_backend(?)", [pid.v]);
        await attendre(100);
        await x.run("SELECT 1");
      }),
    ).rejects.toBeInstanceOf(ErreurOperation);
    expect(await autre.get("SELECT 1 AS un")).toEqual({ un: 1 });
    await autre.fermer();
  });

  it("ecriture() annulée puis reprise dans la même transaction reprend le verrou", async () => {
    const autre = ouvrirBase(reglagesPgDeTest(t.emplacement));
    await base.run("INSERT INTO c(nom, n) VALUES ('rv', 0)");
    const incrementer = async (b: Base) => {
      const r = await b.get<{ n: number }>("SELECT n FROM c WHERE nom = 'rv'");
      await attendre(30);
      await b.run("UPDATE c SET n = ? WHERE nom = 'rv'", [(r?.n ?? 0) + 1]);
    };
    await Promise.all([
      base.transaction(async () => {
        await base.ecriture(async () => Promise.reject(new Error("annulée"))).catch(() => undefined);
        await base.ecriture(async () => incrementer(base));
      }),
      attendre(5).then(() => autre.ecriture(async () => incrementer(autre))),
    ]);
    expect(await base.get("SELECT n FROM c WHERE nom = 'rv'")).toEqual({ n: 2 });
    await autre.fermer();
  });

  it("erreurs de connexion, schéma invalide, instructions multiples, grands entiers, script sur une connexion", async () => {
    const faux = ouvrirBase({ ...reglagesPgDeTest(t.emplacement), password: "faux" });
    await expect(faux.get("SELECT 1 AS un")).rejects.toThrow(/connexion PostgreSQL impossible/u);
    await faux.fermer();
    expect(() => ouvrirBase({ ...reglagesPgDeTest(t.emplacement), schema: 'x"; DROP' })).toThrow(
      ErreurProgrammation,
    );
    await expect(base.run("SELECT 1; SELECT 2")).rejects.toBeInstanceOf(ErreurProgrammation);
    expect(await base.get("SELECT 9007199254740993::bigint AS g, 42::bigint AS p")).toEqual({
      g: 9007199254740993n,
      p: 42,
    });
    await base.exec("CREATE TEMP TABLE tt(x INTEGER); INSERT INTO tt VALUES (1)");
  });
});
