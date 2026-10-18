// SPDX-License-Identifier: MIT
/** packages/db/src/postgres.ts — PostgreSQL (pg) : pool borné, `?` → `$n`, valeurs et erreurs relues comme en SQLite. */
import { basename, dirname } from "node:path";
import { getCACertificates } from "node:tls";

import pg from "pg";

import { adapterParametres, BaseCommune, objetLigne } from "./base";
import type { Mode, Parametres, Resultat, Session, StatsPool } from "./base";
import { classerSqlstate, ErreurBase, ErreurOperation, ErreurProgrammation } from "./erreurs";
import { qmarkVersDollar, splitStatements } from "./sql";

export interface ReglagesPostgres {
  backend: "postgres";
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  tls?: string;
  /** Délai en secondes (DB_TIMEOUT) : connexion et chaque requête ; l'attente d'une connexion du pool vaut max(10 s, délai / 2). */
  timeout?: number;
  poolMax?: number;
  schema?: string | null;
  application?: string;
}

const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_BOOL = 16;
const NOM_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
/** Verrou consultatif des créations d'amorçage (schéma de test, table du verrou d'écriture), distinct de celui des migrations Python. */
const VERROU_AMORCAGE = 727733002;

/** int8 / numeric : nombre comme `to_python`, BigInt pour un entier hors de la plage sûre (aucune perte silencieuse). */
function nombre(v: string): number | bigint {
  const n = Number(v);
  return Number.isInteger(n) && !Number.isSafeInteger(n) && /^-?\d+$/u.test(v) ? BigInt(v) : n;
}

const TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === OID_INT8 || oid === OID_NUMERIC) return nombre;
    if (oid === OID_BOOL) return (v: string) => (v === "t" ? 1 : 0);
    return pg.types.getTypeParser(oid, format as "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

/** off/disable/no/false → sans TLS ; verify → certificat vérifié (magasin système compris) ; autre → chiffré sans vérification. */
export function optionsTls(tls: string | undefined): false | { rejectUnauthorized: boolean; ca?: string[] } {
  const t = (tls ?? "off").toLowerCase();
  if (["off", "disable", "no", "false", ""].includes(t)) return false;
  if (t !== "verify") return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system")])],
  };
}

function convertir(e: unknown): { erreur: unknown; rompue: boolean } {
  if (e instanceof ErreurBase || !(e instanceof Error)) return { erreur: e, rompue: false };
  if (e instanceof pg.DatabaseError && typeof e.code === "string") {
    if (e.code.startsWith("28") || e.code.startsWith("3D")) {
      return {
        erreur: new ErreurOperation(`connexion PostgreSQL impossible : ${e.message}`, e.code, { cause: e }),
        rompue: true,
      };
    }
    const c = classerSqlstate(e.code, e.message);
    return { erreur: new c.classe(c.message, e.code, { cause: e }), rompue: c.rompue };
  }
  if (e instanceof TypeError || e instanceof RangeError) {
    return { erreur: new ErreurProgrammation(e.message, undefined, { cause: e }), rompue: false };
  }
  return {
    erreur: new ErreurOperation(`connexion PostgreSQL perdue : ${e.message}`, undefined, { cause: e }),
    rompue: true,
  };
}

class SessionPg implements Session {
  rompue = false;
  private readonly client: pg.PoolClient | pg.Pool;
  private readonly surErreur = (): void => {
    this.rompue = true;
  };

  constructor(client: pg.PoolClient | pg.Pool, empruntee: boolean) {
    this.client = client;
    if (empruntee) (client as pg.PoolClient).on("error", this.surErreur); // sans écouteur, une coupure serveur arrêterait le processus
  }

  private async requete(sql: string, vals: unknown[]): Promise<pg.QueryResult<unknown[]>> {
    try {
      return await this.client.query<unknown[]>({
        text: vals.length ? qmarkVersDollar(sql) : sql,
        values: vals,
        rowMode: "array",
      });
    } catch (e) {
      const c = convertir(e);
      if (c.rompue) this.rompue = true;
      throw c.erreur;
    }
  }

  async executer(sql: string, params: Parametres, mode: Mode): Promise<unknown> {
    const vals = adapterParametres(params, true);
    if (!vals.length && splitStatements(sql).length > 1) {
      throw new ErreurProgrammation("une seule instruction à la fois (utiliser exec pour un script)");
    }
    const ajoutId = mode === "id" && !/\breturning\b/iu.test(sql);
    const r = await this.requete(ajoutId ? `${sql.trimEnd().replace(/;$/u, "")} RETURNING id` : sql, vals);
    const noms = (r.fields ?? []).map((f) => f.name);
    if (mode === "valeurs") return r.rows;
    if (mode === "all") return r.rows.map((l) => objetLigne(noms, l));
    if (mode === "get") return r.rows[0] && objetLigne(noms, r.rows[0]);
    if (mode === "id") return r.rows[0] ? Number(r.rows[0][Math.max(0, noms.indexOf("id"))]) : 0;
    return { changes: r.rowCount ?? 0, lastInsertRowid: null } satisfies Resultat;
  }

  async executerScript(script: string): Promise<void> {
    for (const instr of splitStatements(script)) await this.executer(instr, [], "run");
  }

  /** COMMIT d'une transaction avortée : le serveur répond ROLLBACK sans erreur, ce qui perdrait le travail en silence. */
  async valider(): Promise<void> {
    const r = await this.requete("COMMIT", []);
    if (r.command === "ROLLBACK") {
      throw new ErreurOperation("transaction avortée par une erreur antérieure : annulée par le serveur");
    }
  }

  rendre(detruire: boolean): void {
    const client = this.client as pg.PoolClient;
    client.removeListener("error", this.surErreur);
    client.release(detruire || this.rompue ? true : undefined);
  }
}

export class BasePostgres extends BaseCommune {
  readonly dialecte = "postgres" as const;
  private readonly pool: pg.Pool;
  private readonly libre: SessionPg;
  private readonly max: number;
  private readonly attentePoolS: number;
  private verrouPret = false;
  private schemaPret: Promise<void> | undefined;
  private readonly reglages: ReglagesPostgres;

  constructor(reglages: ReglagesPostgres, garde?: () => void) {
    const delai = reglages.timeout ?? 60;
    super(delai * 1000, garde);
    if (reglages.schema && !NOM_SCHEMA.test(reglages.schema)) {
      throw new ErreurProgrammation(`nom de schéma invalide : ${reglages.schema}`);
    }
    this.reglages = reglages;
    this.max = Math.max(1, reglages.poolMax ?? 8);
    this.attentePoolS = Math.max(10, delai / 2);
    this.pool = new pg.Pool({
      ...this.connexion(),
      max: this.max,
      connectionTimeoutMillis: this.attentePoolS * 1000,
      query_timeout: delai * 1000,
      keepAlive: true,
      application_name: `${reglages.application ?? "elpis"}-${process.pid}`.slice(0, 63),
      types: TYPES,
      ...(reglages.schema ? { options: `-c search_path=${reglages.schema}` } : {}),
    });
    this.pool.on("error", () => undefined); // connexion inactive coupée par le serveur : pg la retire du pool
    this.libre = new SessionPg(this.pool, false);
  }

  private connexion(): pg.ClientConfig {
    const r = this.reglages;
    const socket = r.host.startsWith("/") && basename(r.host) === `.s.PGSQL.${r.port}`;
    return {
      host: socket ? dirname(r.host) : r.host,
      port: r.port,
      database: r.name,
      user: r.user,
      password: r.password,
      ssl: optionsTls(r.tls),
      connectionTimeoutMillis: (r.timeout ?? 60) * 1000,
    };
  }

  private preparerSchema(): Promise<void> {
    const schema = this.reglages.schema;
    if (!schema) return Promise.resolve();
    this.schemaPret ??= (async () => {
      const admin = new pg.Client(this.connexion());
      admin.on("error", () => undefined);
      try {
        await admin.connect();
        await admin.query(`SELECT pg_advisory_lock(${VERROU_AMORCAGE})`); // deux processus créant le même schéma se heurtent sinon (23505)
        await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      } catch (e) {
        this.schemaPret = undefined;
        throw convertir(e).erreur;
      } finally {
        await admin.end().catch(() => undefined);
      }
    })();
    return this.schemaPret;
  }

  private async emprunter(): Promise<SessionPg> {
    await this.preparerSchema();
    try {
      return new SessionPg(await this.pool.connect(), true);
    } catch (e) {
      if (
        e instanceof Error &&
        /timeout exceeded when trying to connect/iu.test(e.message) &&
        this.pool.totalCount >= this.max
      ) {
        throw new ErreurOperation(
          `database is locked: pool de connexions épuisé (${this.max} en usage depuis ${this.attentePoolS.toFixed(0)} s)`,
          undefined,
          { cause: e },
        );
      }
      throw convertir(e).erreur;
    }
  }

  protected async horsTransaction(sql: string, params: Parametres, mode: Mode): Promise<unknown> {
    await this.preparerSchema();
    return this.libre.executer(sql, params, mode);
  }

  protected async scriptHorsTransaction(script: string): Promise<void> {
    const s = await this.emprunter();
    try {
      await s.executerScript(script);
    } finally {
      s.rendre(false);
    }
  }

  protected async debuter(ecriture: boolean): Promise<Session> {
    const s = await this.emprunter();
    try {
      if (ecriture) await this.preparerVerrou(s, true);
      await s.executer("BEGIN", [], "run");
      if (ecriture) await this.verrouillerEcriture(s);
      return s;
    } catch (e) {
      s.rendre(true);
      throw e;
    }
  }

  /** Table du verrou créée hors transaction une fois pour toutes ; dans une transaction, elle n'est pas tenue pour acquise. */
  private async preparerVerrou(s: SessionPg, horsTransaction: boolean): Promise<void> {
    if (this.verrouPret) return;
    await s.executer(
      `SELECT ${horsTransaction ? "pg_advisory_lock" : "pg_advisory_xact_lock"}(${VERROU_AMORCAGE})`,
      [],
      "get",
    );
    try {
      await s.executer('CREATE TABLE IF NOT EXISTS "elpis_locks" (\n  "name" TEXT PRIMARY KEY\n)', [], "run");
      await s.executer("INSERT INTO elpis_locks(name) VALUES ('write') ON CONFLICT DO NOTHING", [], "run");
    } finally {
      if (horsTransaction) await s.executer(`SELECT pg_advisory_unlock(${VERROU_AMORCAGE})`, [], "get");
    }
    if (horsTransaction) this.verrouPret = true;
  }

  protected async verrouillerEcriture(s: Session): Promise<void> {
    await this.preparerVerrou(s as SessionPg, false);
    await s.executer("SELECT name FROM elpis_locks WHERE name = 'write' FOR UPDATE", [], "get");
  }

  protected async terminer(s: Session, valider: boolean): Promise<void> {
    const session = s as SessionPg;
    let detruire = false;
    try {
      if (valider) await session.valider();
      else await session.executer("ROLLBACK", [], "run");
    } catch (e) {
      detruire = true;
      if (valider) throw e;
    } finally {
      if (!detruire) {
        await session.executer("SELECT pg_advisory_unlock_all()", [], "run").catch(() => {
          detruire = true; // déjà validé : l'échec du déverrouillage ne doit pas faire rejouer l'écriture
        });
      }
      session.rendre(detruire);
    }
  }

  stats(): StatsPool {
    const open = this.pool.totalCount;
    const idle = this.pool.idleCount;
    return { max: this.max, open, idle, in_use: open - idle };
  }

  async fermer(): Promise<void> {
    await this.pool.end();
  }
}
