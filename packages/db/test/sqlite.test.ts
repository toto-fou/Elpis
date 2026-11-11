// SPDX-License-Identifier: MIT
/** packages/db/test/sqlite.test.ts — SQLite : exécution, transactions réentrantes, points de sauvegarde, verrou tenu par un autre processus. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ErreurIntegrite,
  ErreurOperation,
  ErreurProgrammation,
  estTableAbsente,
  ouvrirBase,
} from "../src/index";
import type { Base } from "../src/index";

let dossier: string;
let chemin: string;
let base: Base;

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-db-"));
  chemin = join(dossier, "sous", "app.db");
  base = ouvrirBase({ backend: "sqlite", path: chemin, lockTimeoutMs: 2000 });
  await base.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, nom TEXT UNIQUE, n INTEGER DEFAULT 0, b INTEGER)");
});

afterEach(async () => {
  await base.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("exécution", () => {
  it("insère, relit et rend l'id", async () => {
    expect(await base.insertId("INSERT INTO t(nom, b) VALUES (?, ?)", ["a", true])).toBe(1);
    expect(await base.get("SELECT nom, b FROM t WHERE id = ?", [1])).toEqual({ nom: "a", b: 1 });
    const r = await base.run("UPDATE t SET n = n + 1 WHERE nom = ?", ["a"]);
    expect(r).toEqual({ changes: 1, lastInsertRowid: null });
    expect(await base.all("SELECT id FROM t WHERE nom = ?", ["zz"])).toEqual([]);
    expect(await base.all("INSERT INTO t(nom) VALUES ('c')")).toEqual([]);
  });

  it("RETURNING passe par run", async () => {
    expect(await base.run("INSERT INTO t(nom) VALUES ('r') RETURNING id")).toEqual({
      changes: 1,
      lastInsertRowid: null,
    });
  });

  it("classe les erreurs comme sqlite3", async () => {
    await base.run("INSERT INTO t(nom) VALUES ('x')");
    await expect(base.run("INSERT INTO t(nom) VALUES ('x')")).rejects.toBeInstanceOf(ErreurIntegrite);
    const e = await base.all("SELECT * FROM absente").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurOperation);
    expect(estTableAbsente(e)).toBe(true);
    await expect(base.run("SELECT ?", [undefined as unknown as null])).rejects.toBeInstanceOf(
      ErreurProgrammation,
    );
  });

  it("refuse tout emprunt quand la garde lève", async () => {
    const autre = ouvrirBase(
      { backend: "sqlite", path: chemin },
      {
        garde: () => {
          throw new ErreurOperation("base de données basculée : ce processus doit être rechargé");
        },
      },
    );
    const p = autre.all("SELECT 1");
    await expect(p).rejects.toThrow("basculée");
    await expect(autre.transaction(async () => 1)).rejects.toThrow("basculée");
    await autre.fermer();
  });
});

describe("transactions", () => {
  it("valide à la sortie, annule sur exception", async () => {
    await base.transaction(async (tx) => {
      await tx.run("INSERT INTO t(nom) VALUES ('ok')");
    });
    await expect(
      base.transaction(async (tx) => {
        await tx.run("INSERT INTO t(nom) VALUES ('ko')");
        throw new Error("échec");
      }),
    ).rejects.toThrow("échec");
    expect((await base.all<{ nom: string }>("SELECT nom FROM t")).map((r) => r.nom)).toEqual(["ok"]);
  });

  it("imbriquée : point de sauvegarde, n'annule que son travail", async () => {
    await base.transaction(async () => {
      await base.run("INSERT INTO t(nom) VALUES ('dehors')");
      await base
        .transaction(async () => {
          await base.run("INSERT INTO t(nom) VALUES ('dedans')");
          throw new Error("annule dedans");
        })
        .catch(() => undefined);
      expect(await base.get("SELECT COUNT(*) AS n FROM t")).toEqual({ n: 1 });
    });
    expect(await base.all("SELECT nom FROM t")).toEqual([{ nom: "dehors" }]);
  });

  it("une lecture hors contexte ne voit pas l'écriture non validée", async () => {
    let pendant: unknown;
    await base.transaction(async () => {
      await base.run("INSERT INTO t(nom) VALUES ('pendant')");
      pendant = await new Promise((r) => {
        setImmediate(() => r(base.get("SELECT COUNT(*) AS n FROM t WHERE nom = 'pendant'")));
      });
    });
    expect(pendant).toEqual({ n: 1 });
    const lecteur = ouvrirBase({ backend: "sqlite", path: chemin });
    let dehors: unknown;
    await base.transaction(async () => {
      await base.run("INSERT INTO t(nom) VALUES ('cache')");
      dehors = await lecteur.get("SELECT COUNT(*) AS n FROM t WHERE nom = 'cache'");
    });
    expect(dehors).toEqual({ n: 0 });
    await lecteur.fermer();
  });

  it("sérialise les transactions concurrentes du process (aucune mise à jour perdue)", async () => {
    await base.run("INSERT INTO t(nom, n) VALUES ('c', 0)");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        base.transaction(async () => {
          const r = await base.get<{ n: number }>("SELECT n FROM t WHERE nom = 'c'");
          await attendre(1);
          await base.run("UPDATE t SET n = ? WHERE nom = 'c'", [(r?.n ?? 0) + 1]);
        }),
      ),
    );
    expect(await base.get("SELECT n FROM t WHERE nom = 'c'")).toEqual({ n: 20 });
  });

  it("une tâche lancée pendant la transaction et finie après n'utilise plus la transaction close", async () => {
    let tardive: Promise<unknown> | undefined;
    await base.transaction(async () => {
      tardive = attendre(20).then(() => base.run("INSERT INTO t(nom) VALUES ('tardive')"));
    });
    await tardive;
    expect(await base.get("SELECT COUNT(*) AS n FROM t WHERE nom = 'tardive'")).toEqual({ n: 1 });
  });
});

describe("verrou d'un autre processus", () => {
  it("attend sans bloquer la boucle d'événements, puis écrit", async () => {
    const autre = new Database(chemin);
    autre.exec("BEGIN IMMEDIATE");
    let minuteur = false;
    setTimeout(() => (minuteur = true), 20);
    setTimeout(() => autre.exec("COMMIT"), 150);
    await base.run("INSERT INTO t(nom) VALUES ('apres')");
    expect(minuteur).toBe(true);
    await base.ecriture(async (tx) => tx.run("INSERT INTO t(nom) VALUES ('apres2')"));
    autre.close();
    expect(await base.get("SELECT COUNT(*) AS n FROM t")).toEqual({ n: 2 });
  });

  it("échoue au-delà du délai", async () => {
    const court = ouvrirBase({ backend: "sqlite", path: chemin, lockTimeoutMs: 100 });
    const autre = new Database(chemin);
    autre.exec("BEGIN IMMEDIATE");
    await expect(court.run("INSERT INTO t(nom) VALUES ('bloque')")).rejects.toBeInstanceOf(ErreurOperation);
    await expect(court.transaction(async () => 1)).rejects.toThrow(/locked/u);
    autre.exec("ROLLBACK");
    autre.close();
    await court.fermer();
  });
});

/** Plus grand écart entre deux ticks d'un intervalle de 5 ms pendant `fn` : la boucle ne doit jamais être affamée. */
async function ecartMax(fn: () => Promise<unknown>): Promise<number> {
  let dernier = performance.now();
  let max = 0;
  const h = setInterval(() => {
    const t = performance.now();
    max = Math.max(max, t - dernier);
    dernier = t;
  }, 5);
  try {
    await fn();
  } finally {
    clearInterval(h);
  }
  return max;
}

describe("boucle d'événements et verrous (relecture B1-08)", () => {
  it("20 écritures en attente d'une transaction du process n'affament pas la boucle", async () => {
    const ecart = await ecartMax(async () => {
      const tx = base.transaction(async (x) => {
        await x.run("INSERT INTO t(nom) VALUES ('tx')");
        await attendre(300);
      });
      const ecritures = Array.from({ length: 20 }, (_v, i) =>
        base.run("INSERT INTO t(nom) VALUES (?)", [`e${i}`]),
      );
      await Promise.all([tx, ...ecritures]);
    });
    expect(ecart).toBeLessThan(80);
    expect(await base.get("SELECT COUNT(*) AS n FROM t")).toEqual({ n: 21 });
  });

  it("20 écritures en attente du verrou d'un autre processus n'affament pas la boucle", async () => {
    const autre = new Database(chemin);
    autre.exec("BEGIN IMMEDIATE");
    setTimeout(() => autre.exec("COMMIT"), 300);
    const ecart = await ecartMax(() =>
      Promise.all(
        Array.from({ length: 20 }, (_v, i) => base.run("INSERT INTO t(nom) VALUES (?)", [`p${i}`])),
      ),
    );
    autre.close();
    expect(ecart).toBeLessThan(80);
  });

  it("le verrou interne respecte le délai (database is locked)", async () => {
    const court = ouvrirBase({ backend: "sqlite", path: chemin, lockTimeoutMs: 100 });
    const longue = court.transaction(async () => attendre(400));
    const debut = performance.now();
    await expect(court.run("INSERT INTO t(nom) VALUES ('x')")).rejects.toThrow(/database is locked/u);
    expect(performance.now() - debut).toBeLessThan(300);
    await longue;
    await court.fermer();
  });

  it("un script hors transaction attend le verrou d'un autre processus et reste atomique", async () => {
    const autre = new Database(chemin);
    autre.exec("BEGIN IMMEDIATE");
    setTimeout(() => autre.exec("COMMIT"), 150);
    await base.exec("INSERT INTO t(nom) VALUES ('s1'); INSERT INTO t(nom) VALUES ('s2')");
    await expect(
      base.exec("INSERT INTO t(nom) VALUES ('s3'); INSERT INTO t(nom) VALUES ('s1')"),
    ).rejects.toBeInstanceOf(ErreurIntegrite);
    autre.close();
    expect(await base.all("SELECT nom FROM t WHERE nom LIKE 's%' ORDER BY nom")).toEqual([
      { nom: "s1" },
      { nom: "s2" },
    ]);
  });

  it("classe les erreurs de programmation de better-sqlite3", async () => {
    await expect(base.run("SELECT 1; SELECT 2")).rejects.toBeInstanceOf(ErreurProgrammation);
    await expect(base.run("SELECT ?", [])).rejects.toBeInstanceOf(ErreurProgrammation);
  });
});
