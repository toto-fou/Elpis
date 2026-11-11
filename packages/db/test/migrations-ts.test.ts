// SPDX-License-Identifier: MIT
/** packages/db/test/migrations-ts.test.ts — mécanisme unique des migrations TS : registre connu de tout process (base neuve tamponnée en entier), implémentation passée par le process, report (absente ou `MigrationDifferee`), échec sans trace, ports (coffre, chiffré hors liste, Fernet) et journal seulement après validation (`apresValidation`), `secure_delete` pendant la migration, compactage après coup (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { existsSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  apresValidation,
  compacterApresMigrations,
  initialiserBase,
  infoBase,
  MigrationDifferee,
  MIGRATIONS_TS,
  registreMigrations,
  walCheckpoint,
} from "../src";
import type { Migration, PortCoffre, SecretARanger } from "../src";
import { ouvrirBaseDeTest, PG_DE_TEST } from "../src/test";
import type { BaseDeTest } from "../src/test";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const NOM = MIGRATIONS_TS[0] as string;

describe.each(MOTEURS)("migrations TS (%s)", (moteur) => {
  let t: BaseDeTest;
  beforeEach(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
  });
  afterEach(async () => t.fermer());

  const avantMiseAJour = async (): Promise<void> => {
    await t.base.run("DELETE FROM schema_migrations WHERE name = ?", [NOM]);
  };
  const tamponnee = async (): Promise<boolean> =>
    (await t.base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [NOM])) !== undefined;
  const info = () =>
    infoBase(t.base, { location: "test", ...(moteur === "sqlite" ? { cheminSqlite: t.emplacement } : {}) });

  it("base neuve : tout le registre tamponné sans implémentation ; infoBase le suit", async () => {
    const neuve = ouvrirBaseDeTest(moteur);
    try {
      const r = await initialiserBase(neuve.base);
      expect([r.neuve, r.appliquees, r.differees]).toEqual([true, [], []]);
      const faites = (await neuve.base.all<{ name: string }>("SELECT name FROM schema_migrations")).map(
        (l) => l.name,
      );
      expect(faites.sort()).toEqual(registreMigrations().sort());
    } finally {
      await neuve.fermer();
    }
    expect((await info()).pending_migrations).toEqual([]);
  });

  it("implémentation absente de ce process : différée, rien de tamponné, en attente pour infoBase", async () => {
    await avantMiseAJour();
    const r = await initialiserBase(t.base);
    expect([r.echec, r.appliquees, r.differees.map((d) => d.name)]).toEqual([null, [], [NOM]]);
    expect(r.differees[0]?.message).toMatch(/main/u);
    expect(await tamponnee()).toBe(false);
    expect((await info()).pending_migrations).toEqual([NOM]);
  });

  it("implémentation hors du registre : refusée avant toute écriture", async () => {
    const m: Migration = { name: "9999_hors_registre", tables: [], migrer: async () => undefined };
    await expect(initialiserBase(t.base, { migrations: [m] })).rejects.toThrow(/hors du registre/u);
  });

  it("MigrationDifferee : annulée, ni tamponnée ni en échec, son journal abandonné", async () => {
    await avantMiseAJour();
    const journal: string[] = [];
    const m: Migration = {
      name: NOM,
      tables: ["llm_connectors"],
      migrer: async (x) => {
        await x.run("CREATE TABLE essai_differe(id INTEGER)");
        apresValidation(x, () => journal.push("essai.differe"));
        throw new MigrationDifferee("pas les moyens ici");
      },
    };
    const r = await initialiserBase(t.base, { migrations: [m] });
    expect([r.echec, r.differees, journal, r.aCompacter]).toEqual([
      null,
      [{ name: NOM, message: "pas les moyens ici" }],
      [],
      [],
    ]);
    expect(await tamponnee()).toBe(false);
    await expect(t.base.get("SELECT COUNT(*) AS n FROM essai_differe")).rejects.toThrow();
  });

  it("échec : rien de tamponné ni d'écrit, journal abandonné, réessayée au démarrage suivant", async () => {
    await avantMiseAJour();
    let essais = 0;
    const journal: number[] = [];
    const m: Migration = {
      name: NOM,
      tables: ["llm_connectors"],
      migrer: async (x) => {
        essais += 1;
        const n = essais;
        await x.run("UPDATE llm_connectors SET label = 'touché'");
        apresValidation(x, () => journal.push(n));
        if (essais === 1) throw new Error("panne");
        return { infos: ["fait"], avertissements: ["attention"] };
      },
    };
    const r = await initialiserBase(t.base, { migrations: [m] });
    expect([r.echec, journal, r.appliquees]).toEqual([{ name: NOM, message: "panne" }, [], []]);
    expect(await tamponnee()).toBe(false);
    const r2 = await initialiserBase(t.base, { migrations: [m] });
    expect([r2.echec, r2.appliquees, r2.aCompacter]).toEqual([null, [NOM], ["llm_connectors"]]);
    expect(journal).toEqual([2]);
    expect(r2.infos).toEqual([`migration ${NOM} : fait`]);
    expect(r2.avertissements).toContain(`migration ${NOM} : attention`);
  });

  it("ports : le coffre range (id) et chiffre hors liste, son journal part après la validation ; absents : null", async () => {
    await avantMiseAJour();
    const ranges: SecretARanger[] = [];
    const journal: string[] = [];
    const coffre: PortCoffre = {
      async ranger(x, s) {
        ranges.push(s);
        apresValidation(x, () => journal.push(`vault.secret.created ${s.nom}`));
        return 41;
      },
      async chiffrer(_x, valeur, aad) {
        return `chiffre(${valeur}|${aad})`;
      },
    };
    const vus: unknown[] = [];
    const m: Migration = {
      name: NOM,
      tables: [],
      migrer: async (x, _b, ctx) => {
        vus.push(ctx.fernet?.ouvrir("jeton"));
        vus.push(
          await ctx.coffre?.ranger(x, { proprietaire: 3, genre: "llm", nom: "n", portee: {}, valeur: "v" }),
        );
        vus.push(await ctx.coffre?.chiffrer(x, "w", "aad"));
        vus.push([...journal]);
      },
    };
    const sans = await initialiserBase(t.base, { migrations: [m] });
    expect([sans.appliquees, vus, journal]).toEqual([[NOM], [undefined, undefined, undefined, []], []]);
    await avantMiseAJour();
    vus.length = 0;
    await initialiserBase(t.base, {
      migrations: [m],
      ports: { coffre, fernet: { ouvrir: () => ({ erreur: "cle_absente" }) } },
    });
    expect(vus).toEqual([{ erreur: "cle_absente" }, 41, "chiffre(w|aad)", []]);
    expect(ranges.map((s) => s.nom)).toEqual(["n"]);
    expect(journal).toEqual(["vault.secret.created n"]);
  });

  it.runIf(moteur === "sqlite")(
    "SQLite : secure_delete pendant la migration, réglage d'avant rendu, valeur absente du fichier après compactage",
    async () => {
      await avantMiseAJour();
      const temoin = "temoin-de-valeur-0123456789abcdef";
      await t.base.run(
        "INSERT INTO llm_connectors(scope, provider_type, wire, label, base_url, api_key_enc, key_scheme, default_model, " +
          "models_json, enabled, created_at, updated_at) VALUES ('shared', 'openai', 'openai', 'l', 'http://x', ?, 'plain', '', '', 1, 1, 1)",
        [temoin],
      );
      await walCheckpoint(t.base);
      const avant = await t.base.get("PRAGMA secure_delete");
      let pendant: unknown;
      const m: Migration = {
        name: NOM,
        tables: ["llm_connectors"],
        migrer: async (x) => {
          pendant = Object.values((await x.get<Record<string, unknown>>("PRAGMA secure_delete")) ?? {})[0];
          await x.run("UPDATE llm_connectors SET api_key_enc = ''");
        },
      };
      const r = await initialiserBase(t.base, { migrations: [m] });
      expect([r.appliquees, Number(pendant)]).toEqual([[NOM], 1]);
      expect(await t.base.get("PRAGMA secure_delete")).toEqual(avant);
      expect(await compacterApresMigrations(t.base, r.aCompacter)).toBe(true);
      const octets = Buffer.concat(
        [t.emplacement, `${t.emplacement}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f)),
      );
      expect(octets.includes(Buffer.from(temoin))).toBe(false);
    },
  );

  it.runIf(moteur === "postgres")("PostgreSQL : compactage par VACUUM FULL des tables touchées", async () => {
    await expect(compacterApresMigrations(t.base, ["llm_connectors"])).resolves.toBe(true);
    await expect(compacterApresMigrations(t.base, ["x; DROP TABLE users"])).rejects.toThrow(/invalide/u);
  });
});
