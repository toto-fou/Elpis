// SPDX-License-Identifier: MIT
/** packages/db/src/erreurs.ts — erreurs de base classées comme les exceptions de sqlite3 (intégrité, opération, données…). */

export class ErreurBase extends Error {
  override name = "ErreurBase";
  sqlstate: string | undefined;

  constructor(message: string, sqlstate?: string, options?: ErrorOptions) {
    super(message, options);
    this.sqlstate = sqlstate;
  }
}

export class ErreurIntegrite extends ErreurBase {
  override name = "ErreurIntegrite";
}

export class ErreurOperation extends ErreurBase {
  override name = "ErreurOperation";
}

export class ErreurDonnees extends ErreurBase {
  override name = "ErreurDonnees";
}

export class ErreurProgrammation extends ErreurBase {
  override name = "ErreurProgrammation";
}

export class ErreurInterne extends ErreurBase {
  override name = "ErreurInterne";
}

export class ErreurInterface extends ErreurBase {
  override name = "ErreurInterface";
}

type Classe = new (message: string, sqlstate?: string, options?: ErrorOptions) => ErreurBase;

export interface Classement {
  classe: Classe;
  message: string;
  rompue: boolean;
}

const OPERATION_PG = ["40", "42", "55", "57", "25", "0A", "26"];
const CONNEXION_PG = new Set(["57P01", "57P02", "57P03"]);

/** SQLSTATE PostgreSQL → classe, message et connexion à jeter (port de `_pg._map_error`). */
export function classerSqlstate(code: string, message: string): Classement {
  const complet = code ? `${message} [SQLSTATE ${code}]` : message;
  if (code.startsWith("23")) return { classe: ErreurIntegrite, message: complet, rompue: false };
  if (code === "42P01")
    return { classe: ErreurOperation, message: `no such table: ${message}`, rompue: false };
  if (code === "42703")
    return { classe: ErreurOperation, message: `no such column: ${message}`, rompue: false };
  if (code.startsWith("22")) return { classe: ErreurDonnees, message: complet, rompue: false };
  if (code.startsWith("08") || CONNEXION_PG.has(code))
    return { classe: ErreurOperation, message: complet, rompue: true };
  if (OPERATION_PG.some((p) => code.startsWith(p)))
    return { classe: ErreurOperation, message: complet, rompue: false };
  return { classe: ErreurBase, message: complet, rompue: false };
}

const PRIMAIRES_SQLITE: Readonly<Record<string, Classe>> = {
  SQLITE_INTERNAL: ErreurInterne,
  SQLITE_NOTFOUND: ErreurInterne,
  SQLITE_ERROR: ErreurOperation,
  SQLITE_PERM: ErreurOperation,
  SQLITE_ABORT: ErreurOperation,
  SQLITE_BUSY: ErreurOperation,
  SQLITE_LOCKED: ErreurOperation,
  SQLITE_READONLY: ErreurOperation,
  SQLITE_INTERRUPT: ErreurOperation,
  SQLITE_IOERR: ErreurOperation,
  SQLITE_FULL: ErreurOperation,
  SQLITE_CANTOPEN: ErreurOperation,
  SQLITE_PROTOCOL: ErreurOperation,
  SQLITE_EMPTY: ErreurOperation,
  SQLITE_SCHEMA: ErreurOperation,
  SQLITE_TOOBIG: ErreurDonnees,
  SQLITE_CONSTRAINT: ErreurIntegrite,
  SQLITE_MISMATCH: ErreurIntegrite,
  SQLITE_MISUSE: ErreurInterface,
  SQLITE_RANGE: ErreurInterface,
};

/** Code SQLite (ex. SQLITE_CONSTRAINT_UNIQUE) → classe, comme `_pysqlite_seterror` de CPython. */
export function classerSqlite(code: string): Classe {
  const primaire = /^SQLITE_[A-Z]+/u.exec(code)?.[0] ?? "";
  return PRIMAIRES_SQLITE[primaire] ?? ErreurBase;
}

export function estTableAbsente(e: unknown): boolean {
  return e instanceof ErreurBase && e.message.toLowerCase().includes("no such table");
}
