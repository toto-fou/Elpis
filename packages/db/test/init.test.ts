// SPDX-License-Identifier: MIT
/** packages/db/test/init.test.ts — initialiserBase : base neuve tamponnée, idempotence, base Python à jour acceptée, base en retard ou à tables AX anciennes refusée intacte. */
import { readFileSync, statSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setTimeout as attendre } from "node:timers/promises";

import { ouvrirBase } from "../src/index";
import {
  decrireEmplacement,
  durcirDroits,
  ErreurBaseNonAJour,
  infoBase,
  initialiserBase,
  registreMigrations,
} from "../src/init";
import { tableNames } from "../src/schema";
import { MIGRATIONS_TS } from "../src/migration";
import { BASELINE_COVERS, MIGRATIONS_PYTHON } from "../src/schema.gen";
import { ouvrirBaseDeTest, PG_DE_TEST, reglagesPgDeTest } from "../src/test";
import type { BaseDeTest } from "../src/test";

const python = JSON.parse(readFileSync(new URL("./vecteurs/base_python.json", import.meta.url), "utf-8")) as {
  objets: [string, string, string, string][];
  migrations: string[];
};
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const DERNIERE = MIGRATIONS_PYTHON[MIGRATIONS_PYTHON.length - 1] as string;

describe.each(MOTEURS)("%s", (moteur) => {
  let t: BaseDeTest;
  beforeEach(() => {
    t = ouvrirBaseDeTest(moteur);
  });
  afterEach(async () => t.fermer());

  it("base neuve : schéma posé, migrations Python tamponnées, puis idempotente", async () => {
    const r = await initialiserBase(t.base);
    expect(r).toMatchObject({
      neuve: true,
      tamponnees: BASELINE_COVERS.length + MIGRATIONS_TS.length,
      echec: null,
      fts: true,
    });
    expect(r.colonnesImpossibles).toEqual([]);
    const r2 = await initialiserBase(t.base);
    expect(r2).toMatchObject({ neuve: false, tamponnees: 0, colonnesAjoutees: [] });
    const info = await infoBase(t.base, {
      location: "test",
      generation: 3,
      ...(moteur === "sqlite" ? { cheminSqlite: t.emplacement } : {}),
    });
    expect(info.generation).toBe(3);
    expect(r.avertissements).toEqual([]);
    expect(r.unaccent).toBe(true);
    expect([r.appliquees, r.differees]).toEqual([[], []]);
    expect(info).toMatchObject({
      backend: moteur,
      migrations: registreMigrations().length,
      last_migration: registreMigrations().at(-1),
      pending_migrations: [],
    });
    expect(info.version).toMatch(moteur === "sqlite" ? /^SQLite 3\./u : /^PostgreSQL 17/u);
  });

  it("refuse une base existante à qui manque la dernière migration Python, sans la modifier", async () => {
    await initialiserBase(t.base);
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [DERNIERE]);
    await t.base.run("DROP TABLE runs");
    await expect(initialiserBase(t.base)).rejects.toBeInstanceOf(ErreurBaseNonAJour);
    await expect(initialiserBase(t.base)).rejects.toThrow(DERNIERE);
    expect(await t.base.get("SELECT COUNT(*) AS n FROM schema_migrations")).toEqual({
      n: registreMigrations().length - 1,
    });
    expect(await tableNames(t.base)).not.toContain("runs");
  });

  it.skipIf(moteur !== "sqlite")(
    "refuse une base à jour dont les tables AX ont encore leur forme ancienne (mise à niveau Python en échec), sans la modifier",
    async () => {
      await initialiserBase(t.base);
      await t.base.exec("ALTER TABLE ax_nodes ADD COLUMN selector_json TEXT");
      await expect(initialiserBase(t.base)).rejects.toBeInstanceOf(ErreurBaseNonAJour);
      await expect(initialiserBase(t.base)).rejects.toThrow("ax_nodes v1 (selector_json)");
      await t.base.exec("ALTER TABLE ax_nodes DROP COLUMN selector_json");
      await t.base.exec("DROP TABLE ax_credentials");
      await t.base.exec(
        "CREATE TABLE ax_credentials (site TEXT PRIMARY KEY, username TEXT, password TEXT, last_ok REAL, use_count INTEGER)",
      );
      await t.base.run("INSERT INTO ax_credentials(site, username, password) VALUES ('s', 'u', 'p')");
      await expect(initialiserBase(t.base)).rejects.toThrow("ax_credentials sans owner");
      expect(await t.base.get("SELECT COUNT(*) AS n FROM ax_credentials")).toEqual({ n: 1 });
    },
  );

  it("recherche plein texte de session_messages", async () => {
    await initialiserBase(t.base);
    const uid = await t.base.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('u', 's', 'h', 0)",
    );
    await t.base.run(
      "INSERT INTO session_messages(user_id, app, session_id, role, content, ts) VALUES (?, 'chat', 's', 'user', ?, 0)",
      [uid, "Le Café crème, déjà servi !"],
    );
    const sql =
      moteur === "sqlite"
        ? "SELECT m.content FROM session_messages_fts f JOIN session_messages m ON m.id = f.rowid WHERE session_messages_fts MATCH ?"
        : "SELECT content FROM session_messages WHERE content_tsv @@ plainto_tsquery('elpis_simple', ?)";
    expect(await t.base.all(sql, ["cafe"])).toEqual([{ content: "Le Café crème, déjà servi !" }]);
  });
});

describe.skipIf(!PG_DE_TEST)("PostgreSQL, deux processus", () => {
  it("initialisent ensemble une base neuve sans heurt (6 séries)", async () => {
    for (let i = 0; i < 6; i++) {
      const t = ouvrirBaseDeTest("postgres");
      const autre = ouvrirBase(reglagesPgDeTest(t.emplacement));
      try {
        const [a, b] = await Promise.all([initialiserBase(t.base), initialiserBase(autre)]);
        expect([a.neuve, b.neuve].sort()).toEqual([false, true]);
      } finally {
        await autre.fermer();
        await t.fermer();
      }
    }
  });

  it("une base existante s'initialise sans attendre une transaction d'un autre processus", async () => {
    const t = ouvrirBaseDeTest("postgres");
    const autre = ouvrirBase(reglagesPgDeTest(t.emplacement));
    try {
      await initialiserBase(t.base);
      let fin = 0;
      const longue = autre.transaction(async (x) => {
        await x.run(
          "INSERT INTO ax_credentials(owner, site, username, password) VALUES ('o', 's', 'u', 'p')",
        );
        await attendre(1500);
        fin = performance.now();
      });
      await attendre(100);
      const debut = performance.now();
      await initialiserBase(t.base);
      expect(performance.now() - debut).toBeLessThan(1000);
      await longue;
      expect(fin).toBeGreaterThan(0);
    } finally {
      await autre.fermer();
      await t.fermer();
    }
  });
});

describe("registre des migrations", () => {
  it("Python puis TS, numérotation contrôlée", () => {
    expect(registreMigrations()).toEqual([
      ...MIGRATIONS_PYTHON,
      "0027_vault_git",
      "0028_vault_llm_images",
      "0029_vault_mcp",
    ]);
    expect(registreMigrations(["0027_essai"]).at(-1)).toBe("0027_essai");
    expect(() => registreMigrations(["0001_avant"])).toThrow(/mal numérotée/u);
    expect(() => registreMigrations(["0028_b", "0027_a"])).toThrow(/mal numérotée/u);
    expect(() => registreMigrations(["0027_essai", "0027_essai"])).toThrow(/mal numérotée|double/u);
  });
});

describe("base Python réelle (SQLite, init_db() de la version Python)", () => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    const rang = (type: string, sql: string) =>
      ["table", "virtuelle", "index", "trigger"].indexOf(
        sql.startsWith("CREATE VIRTUAL") ? "virtuelle" : type,
      );
    const objets = python.objets
      .filter(
        ([type, name]) =>
          !(type === "table" && (name === "sqlite_sequence" || name.startsWith("session_messages_fts_"))),
      )
      .sort((a, b) => rang(a[0], a[3]) - rang(b[0], b[3]));
    for (const [, , , sql] of objets) await t.base.exec(sql);
    await t.base.runMany(
      "INSERT INTO schema_migrations(name, applied_at) VALUES (?, 0)",
      python.migrations.map((n) => [n]),
    );
  });
  afterEach(async () => t.fermer());

  it("à jour : acceptée sans rien changer au schéma", async () => {
    const r = await initialiserBase(t.base);
    expect(r).toMatchObject({
      neuve: false,
      tamponnees: 0,
      colonnesAjoutees: [],
      colonnesImpossibles: [],
      echec: null,
    });
  });

  it("sans sa dernière migration : refusée avec la marche à suivre", async () => {
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [python.migrations.at(-1) ?? ""]);
    await expect(initialiserBase(t.base)).rejects.toThrow(/version Python finale.*relancer Elpis/u);
  });
});

describe("droits et emplacement", () => {
  let dossier: string;
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-droits-"));
  });
  afterEach(() => rmSync(dossier, { recursive: true, force: true }));

  it("resserre fichier, annexes et dossier user_db de la racine", () => {
    const chemin = join(dossier, "user_db", "app.db");
    durcirDroits(chemin, dossier);
    writeFileSync(`${chemin}-wal`, "");
    chmodSync(`${chemin}-wal`, 0o644);
    chmodSync(join(dossier, "user_db"), 0o755);
    expect(durcirDroits(chemin, dossier).sort()).toEqual([`${chemin}-wal`, join(dossier, "user_db")].sort());
    expect(statSync(chemin).mode & 0o777).toBe(0o600);
    expect(statSync(join(dossier, "user_db")).mode & 0o777).toBe(0o700);
  });

  it("ne touche pas au dossier d'une base placée ailleurs", () => {
    const chemin = join(dossier, "ailleurs", "app.db");
    durcirDroits(chemin, dossier);
    chmodSync(join(dossier, "ailleurs"), 0o755);
    expect(durcirDroits(chemin, dossier)).toEqual([]);
  });

  it("décrit l'emplacement sans mot de passe", () => {
    expect(decrireEmplacement({ backend: "sqlite", path: "/b/app.db" })).toBe("sqlite:/b/app.db");
    expect(
      decrireEmplacement({ backend: "postgres", user: "u", host: "h", port: 5432, name: "e", schema: "s" }),
    ).toBe("postgres://u@h:5432/e#s");
  });
});
