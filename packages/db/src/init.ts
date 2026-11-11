// SPDX-License-Identifier: MIT
/** packages/db/src/init.ts — initialisation de la base (schéma, registre des migrations, refus d'une base non à jour), infos et droits. */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Base, Executeur, StatsPool } from "./base";
import { ErreurBase } from "./erreurs";
import { MigrationDifferee, MIGRATIONS_TS } from "./migration";
import type { ContexteMigration, Migration, NotesMigration, PortsMigration } from "./migration";
import { createAll, hasTable, isFresh } from "./schema";
import { BASELINE_COVERS, MIGRATIONS_PYTHON } from "./schema.gen";

export class ErreurBaseNonAJour extends ErreurBase {
  override name = "ErreurBaseNonAJour";
}

export interface RapportInit {
  neuve: boolean;
  tamponnees: number;
  appliquees: string[];
  echec: { name: string; message: string } | null;
  /** Laissées à un process qui en a les moyens (implémentation absente ici, ou `MigrationDifferee`) : ni appliquées ni tamponnées. */
  differees: { name: string; message: string }[];
  /** Notes des migrations appliquées, à journaliser par l'appelant. */
  infos: string[];
  /** Tables touchées par les migrations appliquées ici, à compacter une fois par main (`compacterApresMigrations`). */
  aCompacter: string[];
  fts: boolean;
  unaccent: boolean;
  /** À journaliser par l'appelant (plein texte dégradé, colonnes impossibles à ajouter). */
  avertissements: string[];
  colonnesAjoutees: string[];
  colonnesImpossibles: string[];
}

/** Ordre du registre : migrations Python (vides), puis migrations TS numérotées à la suite, noms uniques. */
export function registreMigrations(ts: readonly string[] = MIGRATIONS_TS): string[] {
  const noms = [...MIGRATIONS_PYTHON, ...ts];
  const derniere = MIGRATIONS_PYTHON[MIGRATIONS_PYTHON.length - 1] ?? "";
  let precedente = derniere;
  for (const n of ts) {
    if (!/^\d{4}_[a-z0-9_]+$/u.test(n) || n <= precedente)
      throw new Error(`migration TS mal numérotée : ${n}`);
    precedente = n;
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

/** `f` avec `secure_delete` sur la connexion SQLite (anciennes valeurs effacées des pages, pas seulement libérées), réglage d'avant remis ensuite ; PostgreSQL : tel quel. */
export async function avecEffacementSur<T>(x: Executeur, f: () => Promise<T>): Promise<T> {
  if (x.dialecte !== "sqlite") return f();
  const avant = Number(
    Object.values((await x.get<Record<string, unknown>>("PRAGMA secure_delete")) ?? {})[0],
  );
  await x.run("PRAGMA secure_delete = ON");
  try {
    return await f();
  } finally {
    await x.run(`PRAGMA secure_delete = ${avant === 2 ? "FAST" : avant === 1 ? "ON" : "OFF"}`);
  }
}

export interface OptionsInit {
  /** Implémentations des migrations du registre apportées par ce process (main) ; une migration en attente sans implémentation ici est différée. */
  readonly migrations?: readonly Migration[];
  /** Ports des migrations (coffre, Fernet sans création de clé) ; absents : `null`. */
  readonly ports?: Partial<PortsMigration>;
  /** Réservé à l'annonce d'un travail réel (ligne d'essai) ; sans effet sur cette base. */
  readonly annoncerTravail?: () => void;
}

/** `init_db` sous verrou d'écriture : base neuve créée d'un coup et tamponnée (registre entier) ; base existante exigée à jour côté Python, sans quoi rien n'est modifié ; migrations TS en attente jouées dans l'ordre du registre avec `secure_delete`, jusqu'à la première différée (implémentation absente de ce process, `MigrationDifferee`) ou en échec ; leur journal de sécurité part après la validation (`apresValidation`). */
export async function initialiserBase(base: Base, o: OptionsInit = {}): Promise<RapportInit> {
  const ctx: ContexteMigration = { coffre: o.ports?.coffre ?? null, fernet: o.ports?.fernet ?? null };
  const implementations = new Map((o.migrations ?? []).map((m) => [m.name, m]));
  for (const nom of implementations.keys())
    if (!MIGRATIONS_TS.includes(nom)) throw new Error(`migration hors du registre : ${nom}`);
  registreMigrations();
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
    const couvertes = [...BASELINE_COVERS, ...MIGRATIONS_TS];
    if (neuve) for (const n of couvertes) await tamponner(x, n);
    const rapport: RapportInit = {
      neuve,
      tamponnees: neuve ? couvertes.filter((n) => !avant.has(n)).length : 0,
      appliquees: [],
      echec: null,
      differees: [],
      infos: [],
      aCompacter: [],
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
    for (const nom of MIGRATIONS_TS) {
      if (faites.has(nom)) continue;
      const m = implementations.get(nom);
      if (m === undefined) {
        rapport.differees.push({
          name: nom,
          message: "laissée à main (implémentation absente de ce process)",
        });
        break;
      }
      let notes: void | NotesMigration;
      try {
        notes = await base.transaction(async (y) => {
          const n = await avecEffacementSur(y, () => m.migrer(y, base, ctx));
          await tamponner(y, nom);
          return n;
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof MigrationDifferee) rapport.differees.push({ name: nom, message });
        else rapport.echec = { name: nom, message };
        break;
      }
      rapport.appliquees.push(nom);
      for (const t of m.tables) if (!rapport.aCompacter.includes(t)) rapport.aCompacter.push(t);
      rapport.infos.push(...(notes?.infos ?? []).map((n) => `migration ${nom} : ${n}`));
      rapport.avertissements.push(...(notes?.avertissements ?? []).map((n) => `migration ${nom} : ${n}`));
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

/** Suppressions dont le contenu ne reste pas dans le fichier : `secure_delete` le temps de `supprimer` (SQLite, réglage rendu ensuite) puis WAL tronqué ; en PostgreSQL, `VACUUM FULL` de la seule `table` ; vrai si le fichier est propre (WAL tronqué ou table réécrite). */
export async function supprimerSansTrace(
  base: Base,
  table: string,
  supprimer: (x: Executeur) => Promise<number>,
): Promise<{ supprimees: number; propre: boolean }> {
  const supprimees = await base.ecriture((x) => avecEffacementSur(x, () => supprimer(x)));
  if (supprimees === 0) return { supprimees, propre: true };
  if (base.dialecte !== "sqlite") {
    await base.exec(`VACUUM FULL ${table}`);
    return { supprimees, propre: true };
  }
  const r = await base.get<Record<string, unknown>>("PRAGMA wal_checkpoint(TRUNCATE)");
  return { supprimees, propre: Number(r?.["busy"] ?? 0) === 0 };
}

/** Compactage unique après les migrations appliquées par main : SQLite `VACUUM` puis WAL tronqué, PostgreSQL `VACUUM FULL` des `tables` touchées ; chaque attente de verrou est bornée par le délai de la base ; faux si le WAL n'a pas pu être tronqué. */
export async function compacterApresMigrations(base: Base, tables: readonly string[]): Promise<boolean> {
  if (base.dialecte !== "sqlite") {
    for (const t of tables) {
      if (!/^[a-z_][a-z0-9_]*$/u.test(t)) throw new Error(`nom de table invalide : ${t}`);
      await base.exec(`VACUUM FULL ${t}`);
    }
    return true;
  }
  await base.exec("VACUUM");
  const r = await base.get<Record<string, unknown>>("PRAGMA wal_checkpoint(TRUNCATE)");
  return Number(r?.["busy"] ?? 0) === 0;
}

/** `wal_checkpoint` : compacte le journal WAL (SQLite seulement), une fois au démarrage parmi les processus. */
export async function walCheckpoint(base: Base): Promise<void> {
  if (base.dialecte === "sqlite") await base.exec("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
}
