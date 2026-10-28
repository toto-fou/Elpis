// SPDX-License-Identifier: MIT
/** packages/db/src/init.ts — initialisation de la base (schéma, registre des migrations, refus d'une base non à jour), infos et droits. */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Base, Executeur, StatsPool } from "./base";
import { ErreurBase } from "./erreurs";
import { TABLE_IDENTIFIANTS_AX } from "./coffre-heritage";
import { createAll, hasTable, isFresh } from "./schema";
import { BASELINE_COVERS, MIGRATIONS_PYTHON } from "./schema.gen";

export class ErreurBaseNonAJour extends ErreurBase {
  override name = "ErreurBaseNonAJour";
}

export interface Migration {
  name: string;
  migrer(x: Executeur): Promise<void>;
}

/** Migrations propres au TS, numérotées à la suite des migrations Python. */
export const MIGRATIONS_TS: readonly Migration[] = [
  {
    name: "0027_coffre_identifiants",
    migrer: async (x) => {
      if ((await hasTable(x, "ax_credentials")) && !(await hasTable(x, TABLE_IDENTIFIANTS_AX)))
        await x.run(`ALTER TABLE "ax_credentials" RENAME TO "${TABLE_IDENTIFIANTS_AX}"`);
    },
  },
];

export interface RapportInit {
  neuve: boolean;
  tamponnees: number;
  appliquees: string[];
  echec: { name: string; message: string } | null;
  fts: boolean;
  unaccent: boolean;
  /** À journaliser par l'appelant (plein texte dégradé, colonnes impossibles à ajouter). */
  avertissements: string[];
  colonnesAjoutees: string[];
  colonnesImpossibles: string[];
}

/** Ordre du registre : migrations Python (vides), puis migrations TS numérotées à la suite, noms uniques. */
export function registreMigrations(ts: readonly Migration[] = MIGRATIONS_TS): string[] {
  const noms = [...MIGRATIONS_PYTHON, ...ts.map((m) => m.name)];
  const derniere = MIGRATIONS_PYTHON[MIGRATIONS_PYTHON.length - 1] ?? "";
  for (const m of ts) {
    if (!/^\d{4}_[a-z0-9_]+$/u.test(m.name) || m.name <= derniere)
      throw new Error(`migration TS mal numérotée : ${m.name}`);
  }
  if (new Set(noms).size !== noms.length) throw new Error("nom de migration en double");
  return noms;
}

async function appliquees(x: Executeur): Promise<Set<string>> {
  if (!(await hasTable(x, "schema_migrations"))) return new Set();
  return new Set((await x.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
}

/** Formes SQLite anciennes des tables AX que `upgrade_legacy_sqlite` du Python met à niveau (v1 `selector_json`, identifiants sans `owner`) ; vide sinon. */
async function axHeritee(x: Executeur): Promise<string[]> {
  if (x.dialecte !== "sqlite") return [];
  const sql = async (table: string): Promise<string> =>
    (
      await x.get<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [
        table,
      ])
    )?.sql ?? "";
  const formes: string[] = [];
  if ((await sql("ax_nodes")).includes("selector_json")) formes.push("ax_nodes v1 (selector_json)");
  const identifiants = await sql("ax_credentials");
  if (identifiants && !identifiants.includes("owner")) formes.push("ax_credentials sans owner");
  return formes;
}

async function tamponner(x: Executeur, name: string): Promise<void> {
  await x.run("INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?) ON CONFLICT(name) DO NOTHING", [
    name,
    Date.now() / 1000,
  ]);
}

/** `init_db` sous verrou d'écriture : base neuve créée d'un coup et tamponnée ; base existante exigée à jour côté Python, sans quoi rien n'est modifié. */
export async function initialiserBase(base: Base): Promise<RapportInit> {
  return base.ecriture(async (x) => {
    const neuve = await isFresh(x);
    if (!neuve) {
      const faites = await appliquees(x);
      const manquantes = MIGRATIONS_PYTHON.filter((n) => !faites.has(n));
      if (manquantes.length) {
        throw new ErreurBaseNonAJour(
          `base antérieure à la version Python finale (migrations absentes : ${manquantes.join(", ")}) : ` +
            "démarrer une fois la dernière version Python d'Elpis pour la mettre à jour, puis relancer Elpis",
        );
      }
      const ax = await axHeritee(x);
      if (ax.length) {
        throw new ErreurBaseNonAJour(
          `base antérieure à la version Python finale (tables AX de forme ancienne : ${ax.join(", ")}) : ` +
            "démarrer une fois la dernière version Python d'Elpis pour la mettre à jour, puis relancer Elpis",
        );
      }
    }
    const schema = await createAll(base);
    const avant = await appliquees(x);
    if (neuve) for (const n of BASELINE_COVERS) await tamponner(x, n);
    const rapport: RapportInit = {
      neuve,
      tamponnees: neuve ? BASELINE_COVERS.filter((n) => !avant.has(n)).length : 0,
      appliquees: [],
      echec: null,
      fts: schema.fts,
      unaccent: schema.unaccent,
      avertissements: [
        ...schema.avertissements,
        ...schema.impossibles.map(
          (c) => `${c} manque et ne peut pas être ajoutée (clé, unicité ou NOT NULL sans défaut)`,
        ),
      ],
      colonnesAjoutees: schema.ajoutees,
      colonnesImpossibles: schema.impossibles,
    };
    const faites = await appliquees(x);
    registreMigrations();
    for (const m of MIGRATIONS_TS) {
      if (faites.has(m.name)) continue;
      try {
        await base.transaction(async (y) => {
          await m.migrer(y);
          await tamponner(y, m.name);
        });
        rapport.appliquees.push(m.name);
      } catch (e) {
        rapport.echec = { name: m.name, message: e instanceof Error ? e.message : String(e) };
        break;
      }
    }
    return rapport;
  });
}

export interface InfoBase {
  backend: string;
  location: string;
  generation: number;
  version: string;
  size_bytes: number | null;
  migrations: number;
  last_migration: string | null;
  pending_migrations: string[];
  pool: StatsPool | null;
}

export interface OptionsInfo {
  location: string;
  /** Obligatoire en SQLite : la taille est celle du fichier et de son journal WAL. */
  cheminSqlite?: string;
  generation?: number;
}

/** Emplacement lisible sans mot de passe (`describe` de transfer.py). */
export function decrireEmplacement(r: {
  backend: string;
  path?: string;
  user?: string;
  host?: string;
  port?: number;
  name?: string;
  schema?: string | null;
}): string {
  if (r.backend === "sqlite") return `sqlite:${r.path ?? ""}`;
  return `${r.backend}://${r.user ?? ""}@${r.host ?? ""}:${r.port ?? ""}/${r.name ?? ""}${r.schema ? `#${r.schema}` : ""}`;
}

/** `db_info` : moteur, version, emplacement, taille, migrations, pool. */
export async function infoBase(base: Base, options: OptionsInfo): Promise<InfoBase> {
  const cheminSqlite = options.cheminSqlite;
  if (base.dialecte === "sqlite" && !cheminSqlite)
    throw new Error("infoBase : cheminSqlite requis en SQLite");
  let version: string;
  try {
    version =
      base.dialecte === "sqlite"
        ? `SQLite ${(await base.get<{ v: string }>("SELECT sqlite_version() AS v"))?.v ?? "?"}`
        : (((await base.get<{ v: string }>("SELECT version() AS v"))?.v ?? "?").split(" on ")[0] ?? "?");
  } catch (e) {
    version = `? (${e instanceof Error ? e.message : String(e)})`;
  }
  let taille: number | null;
  try {
    if (base.dialecte === "postgres") {
      const r = await base.get<{ n: number }>(
        "SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS n FROM pg_class c " +
          "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'",
      );
      taille = Number(r?.n ?? 0);
    } else {
      taille = [cheminSqlite, cheminSqlite && `${cheminSqlite}-wal`]
        .filter((p): p is string => Boolean(p) && existsSync(p as string))
        .reduce((s, p) => s + statSync(p).size, 0);
    }
  } catch {
    taille = null;
  }
  const faites = await appliquees(base);
  const derniere = (await hasTable(base, "schema_migrations"))
    ? ((await base.get<{ m: string | null }>("SELECT MAX(name) AS m FROM schema_migrations"))?.m ?? null)
    : null;
  const connues = registreMigrations();
  return {
    backend: base.dialecte,
    location: options.location,
    generation: options.generation ?? 0,
    version,
    size_bytes: taille,
    migrations: faites.size,
    last_migration: derniere,
    pending_migrations: connues.filter((n) => !faites.has(n)),
    pool: base.stats(),
  };
}

/** `_harden_data_perms` (SQLite, avant ouvrirBase) : fichier et annexes en 0600, dossier en 0700 s'il est `<racine>/user_db`. */
export function durcirDroits(chemin: string, racineProjet?: string): string[] {
  if (chemin === ":memory:") return [];
  const corriges: string[] = [];
  const dossier = dirname(chemin);
  mkdirSync(dossier, { recursive: true });
  if (!existsSync(chemin)) closeSync(openSync(chemin, "a", 0o600));
  const cibles: [string, number][] = ["", "-wal", "-shm", "-journal"].map((s) => [`${chemin}${s}`, 0o600]);
  try {
    if (racineProjet && realpathSync(dossier) === realpathSync(join(racineProjet, "user_db")))
      cibles.push([dossier, 0o700]);
  } catch {
    cibles.length = 4;
  }
  for (const [p, voulu] of cibles) {
    try {
      if (statSync(p).mode & 0o077) {
        chmodSync(p, voulu);
        corriges.push(p);
      }
    } catch {
      continue;
    }
  }
  return corriges;
}

/** `wal_checkpoint` : compacte le journal WAL (SQLite seulement), une fois au démarrage parmi les processus. */
export async function walCheckpoint(base: Base): Promise<void> {
  if (base.dialecte === "sqlite") await base.exec("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
}
