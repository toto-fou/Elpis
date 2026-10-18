// SPDX-License-Identifier: MIT
/** packages/db/src/sqlite.ts — SQLite (better-sqlite3) : lectures libres, écritures et transactions sérialisées, verrou des autres processus attendu sans bloquer. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";

import Database from "better-sqlite3";

import { adapterParametres, BaseCommune, objetLigne } from "./base";
import type { Mode, Parametres, Resultat, Session, StatsPool } from "./base";
import { classerSqlite, ErreurBase, ErreurProgrammation } from "./erreurs";
import { firstWord, splitStatements } from "./sql";
import { Verrou } from "./verrou";

export interface ReglagesSqlite {
  backend: "sqlite";
  path: string;
  /** Attente maximale d'un verrou (busy_timeout de Python : 10 s), sans jamais bloquer la boucle d'événements. */
  lockTimeoutMs?: number;
}

const CACHE_MAX = 256;
const HORS_TRANSACTION = new Set(["VACUUM", "PRAGMA", "ATTACH", "DETACH"]);

function convertir(e: unknown): unknown {
  if (e instanceof ErreurBase || !(e instanceof Error)) return e;
  if (e instanceof RangeError || e instanceof TypeError)
    return new ErreurProgrammation(e.message, undefined, { cause: e });
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !code.startsWith("SQLITE_")) return e;
  const Classe = classerSqlite(code);
  return new Classe(e.message, undefined, { cause: e });
}

function occupe(e: unknown): boolean {
  const code = (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

interface Prepare {
  st: Database.Statement;
  noms: string[] | null;
}

class SessionSqlite implements Session {
  private readonly cache = new Map<string, Prepare>();
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  preparer(sql: string): Prepare {
    let p = this.cache.get(sql);
    if (p) {
      this.cache.delete(sql);
    } else {
      try {
        const st = this.db.prepare(sql);
        const noms = st.reader ? st.columns().map((c) => c.name) : null;
        p = { st, noms: noms && new Set(noms).size !== noms.length ? noms : null };
      } catch (e) {
        throw convertir(e);
      }
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
    this.cache.set(sql, p);
    return p;
  }

  executerSync(sql: string, params: Parametres, mode: Mode): unknown {
    const { st, noms } = this.preparer(sql);
    const vals = adapterParametres(params, false);
    try {
      if (!st.reader) {
        const r = st.run(...vals);
        if (mode === "all" || mode === "valeurs") return [];
        if (mode === "get") return undefined;
        if (mode === "id") return Number(r.lastInsertRowid);
        const insertion = ["INSERT", "REPLACE", "WITH"].includes(firstWord(sql));
        return {
          changes: r.changes,
          lastInsertRowid: insertion ? Number(r.lastInsertRowid) : null,
        } satisfies Resultat;
      }
      if (mode === "run" || mode === "id") {
        const lignes = st.all(...vals);
        if (mode === "id")
          return Number(
            (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id?: number } | undefined)?.id ??
              0,
          );
        return { changes: lignes.length, lastInsertRowid: null } satisfies Resultat;
      }
      if (mode === "valeurs" || noms) {
        const brutes = st.raw(true).all(...vals) as unknown[][];
        st.raw(false);
        if (mode === "valeurs") return brutes;
        const objets = brutes.map((l) => objetLigne(noms as string[], l));
        return mode === "all" ? objets : objets[0];
      }
      return mode === "all" ? st.all(...vals) : st.get(...vals);
    } catch (e) {
      throw convertir(e);
    }
  }

  executer(sql: string, params: Parametres, mode: Mode): Promise<unknown> {
    return Promise.resolve().then(() => this.executerSync(sql, params, mode));
  }

  executerScriptSync(script: string): void {
    try {
      this.db.exec(script);
    } catch (e) {
      throw convertir(e);
    }
  }

  executerScript(script: string): Promise<void> {
    return Promise.resolve().then(() => this.executerScriptSync(script));
  }
}

function ouvrirConnexion(chemin: string, delaiMs: number): Database.Database {
  if (chemin !== ":memory:") mkdirSync(dirname(chemin), { recursive: true });
  const db = new Database(chemin, { timeout: delaiMs });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
  } catch (e) {
    db.close();
    throw convertir(e);
  }
  db.pragma("busy_timeout = 0"); // ouverture seule bloquante ; ensuite, l'attente d'un verrou est asynchrone
  return db;
}

export class BaseSqlite extends BaseCommune {
  readonly dialecte = "sqlite" as const;
  private readonly libre: SessionSqlite;
  private readonly tx: SessionSqlite;
  private readonly memoire: boolean;
  private readonly ecrivain = new Verrou();
  private liberer: (() => void) | undefined;

  constructor(reglages: ReglagesSqlite, garde?: () => void) {
    super(reglages.lockTimeoutMs ?? 10_000, garde);
    this.memoire = reglages.path === ":memory:";
    this.tx = new SessionSqlite(ouvrirConnexion(reglages.path, this.delaiMs));
    this.libre = this.memoire ? this.tx : new SessionSqlite(ouvrirConnexion(reglages.path, this.delaiMs));
  }

  /** Réessaie un SQLITE_BUSY d'un autre processus en rendant la main à la boucle, jusqu'au délai. */
  private async avecReprise<T>(fn: () => T, fin = Date.now() + this.delaiMs): Promise<T> {
    for (let pause = 2; ; pause = Math.min(pause * 2, 50)) {
      try {
        return fn();
      } catch (e) {
        if (!occupe(e) || Date.now() >= fin) throw e;
        await attendre(pause);
      }
    }
  }

  private async sousVerrou<T>(fn: (fin: number) => Promise<T>): Promise<T> {
    const fin = Date.now() + this.delaiMs;
    const liberer = await this.ecrivain.prendre(
      this.delaiMs,
      "database is locked: écriture du processus en attente",
    );
    try {
      return await fn(fin);
    } finally {
      liberer();
    }
  }

  protected horsTransaction(sql: string, params: Parametres, mode: Mode): Promise<unknown> {
    if (!this.memoire && this.libre.preparer(sql).st.readonly) {
      return this.avecReprise(() => this.libre.executerSync(sql, params, mode));
    }
    return this.sousVerrou((fin) => this.avecReprise(() => this.tx.executerSync(sql, params, mode), fin));
  }

  protected scriptHorsTransaction(script: string): Promise<void> {
    const autonome = splitStatements(script).some((s) => HORS_TRANSACTION.has(firstWord(s)));
    return this.sousVerrou(async (fin) => {
      if (autonome) return this.avecReprise(() => this.tx.executerScriptSync(script), fin);
      await this.avecReprise(() => this.tx.executerSync("BEGIN IMMEDIATE", [], "run"), fin);
      try {
        this.tx.executerScriptSync(script);
        this.tx.executerSync("COMMIT", [], "run");
      } catch (e) {
        if (this.tx.db.inTransaction) this.tx.executerSync("ROLLBACK", [], "run");
        throw e;
      }
    });
  }

  protected async debuter(_ecriture: boolean): Promise<Session> {
    const fin = Date.now() + this.delaiMs;
    const liberer = await this.ecrivain.prendre(
      this.delaiMs,
      "database is locked: transaction du processus en attente",
    );
    try {
      await this.avecReprise(() => this.tx.executerSync("BEGIN IMMEDIATE", [], "run"), fin);
    } catch (e) {
      liberer();
      throw e;
    }
    this.liberer = liberer;
    return this.tx;
  }

  protected verrouillerEcriture(_s: Session): Promise<void> {
    return Promise.resolve();
  }

  protected async terminer(s: Session, valider: boolean): Promise<void> {
    const liberer = this.liberer;
    this.liberer = undefined;
    const session = s as SessionSqlite;
    try {
      if (valider) {
        try {
          await this.avecReprise(() => session.executerSync("COMMIT", [], "run"));
        } catch (e) {
          if (session.db.inTransaction) session.executerSync("ROLLBACK", [], "run");
          throw e;
        }
      } else if (session.db.inTransaction) {
        session.executerSync("ROLLBACK", [], "run");
      }
    } finally {
      liberer?.();
    }
  }

  stats(): StatsPool | null {
    return null;
  }

  fermer(): Promise<void> {
    this.libre.db.close();
    if (this.tx !== this.libre) this.tx.db.close();
    return Promise.resolve();
  }
}
