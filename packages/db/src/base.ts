// SPDX-License-Identifier: MIT
/** packages/db/src/base.ts — contrat commun des bases : exécution, transactions réentrantes par contexte async, points de sauvegarde. */
import { AsyncLocalStorage } from "node:async_hooks";

import { ErreurPython, FlottantPy } from "@elpis/commun";

import type { Dialecte } from "./dialecte";
import { ErreurProgrammation } from "./erreurs";
import { firstWord, splitStatements } from "./sql";
import { Verrou } from "./verrou";

export type Valeur = string | number | bigint | boolean | null | Uint8Array;
export type Parametres = readonly Valeur[];
export type Ligne = Record<string, unknown>;

export interface Resultat {
  changes: number;
  lastInsertRowid: number | null;
}

export interface Executeur {
  readonly dialecte: Dialecte;
  /** Lignes en objets ; une colonne en double garde sa première valeur, comme `sqlite3.Row`. */
  all<T extends Ligne = Ligne>(sql: string, params?: Parametres): Promise<T[]>;
  get<T extends Ligne = Ligne>(sql: string, params?: Parametres): Promise<T | undefined>;
  /** Lignes en tableaux, pour le code qui lit `row[0]`. */
  valeurs<T extends unknown[] = unknown[]>(sql: string, params?: Parametres): Promise<T[]>;
  run(sql: string, params?: Parametres): Promise<Resultat>;
  exec(script: string): Promise<void>;
  /** INSERT qui rend l'id créé (`RETURNING id` ajouté en PostgreSQL, comme `_dialect.insert_id`). */
  insertId(sql: string, params?: Parametres): Promise<number>;
  /** `executemany` : atomique (transaction ouverte si aucune n'est en cours). */
  runMany(sql: string, lignes: readonly Parametres[]): Promise<Resultat>;
}

export interface StatsPool {
  max: number;
  open: number;
  idle: number;
  in_use: number;
}

export interface Base extends Executeur {
  /** Transaction validée à la sortie, annulée sur exception ; imbriquée dans le même contexte async, elle devient un point de sauvegarde. */
  transaction<T>(fn: (tx: Executeur) => Promise<T>): Promise<T>;
  /** Transaction d'écriture exclusive entre processus (`begin_write`) : BEGIN IMMEDIATE, ou verrou FOR UPDATE sur `elpis_locks`. */
  ecriture<T>(fn: (tx: Executeur) => Promise<T>): Promise<T>;
  stats(): StatsPool | null;
  fermer(): Promise<void>;
}

export type Mode = "all" | "get" | "valeurs" | "run" | "id";

export interface Session {
  executer(sql: string, params: Parametres, mode: Mode): Promise<unknown>;
  executerScript(script: string): Promise<void>;
}

interface Contexte {
  base: BaseCommune;
  session: Session;
  parent: Contexte | null;
  ecriture: boolean;
  actif: boolean;
  profondeur: number;
  verrou: Verrou;
}

const CONTROLE = new Set(["BEGIN", "START", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);
const EN_COURS = "transaction imbriquée encore en cours à la fin de sa parente";

/** Les transactions passent par transaction()/ecriture() : un BEGIN brut laisserait une connexion partagée en transaction. */
export function verifierInstruction(sql: string): void {
  const mot = firstWord(sql);
  if (CONTROLE.has(mot)) {
    throw new ErreurProgrammation(
      `instruction de transaction refusée (${mot}) : utiliser transaction() ou ecriture()`,
    );
  }
}

/** Comme verifierInstruction pour chaque instruction d'un script, sans entrer dans le corps d'un CREATE TRIGGER … BEGIN … END. */
export function verifierScript(script: string): void {
  let trigger = false;
  for (const instr of splitStatements(script)) {
    if (trigger) {
      trigger = !/^END$/iu.test(instr.trim());
      continue;
    }
    if (firstWord(instr) === "CREATE" && /\bTRIGGER\b[\s\S]*\bBEGIN\b/iu.test(instr)) {
      trigger = true;
      continue;
    }
    verifierInstruction(instr);
  }
}

/** Texte à demi-paire isolée : sqlite3 lève UnicodeEncodeError (une ValueError), psycopg une ProgrammingError, au lieu d'écrire U+FFFD. */
function exigerUtf8(texte: string, postgres: boolean): void {
  if (texte.isWellFormed()) return;
  let position = 0;
  for (const c of texte) {
    const code = c.charCodeAt(0);
    if (c.length === 1 && code >= 0xd800 && code <= 0xdfff) {
      const message = `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`;
      throw postgres ? new ErreurProgrammation(message) : new ErreurPython("ValueError", message);
    }
    position++;
  }
}

/** Paramètres liés comme sqlite3 / psycopg : entier exact en INTEGER (better-sqlite3 lierait REAL), FlottantPy en REAL, liste ou objet refusés. */
export function adapterParametres(params: Parametres | undefined, postgres: boolean): Valeur[] {
  return (params ?? []).map((v: unknown) => {
    if (v === undefined) throw new ErreurProgrammation("paramètre SQL indéfini");
    if (typeof v === "boolean") return postgres ? Number(v) : BigInt(v);
    if (v instanceof FlottantPy) return v.valeur;
    if (typeof v === "string") {
      exigerUtf8(v, postgres);
      return postgres && v.includes("\0") ? v.replaceAll("\0", "") : v;
    }
    if (typeof v === "number") return !postgres && Number.isSafeInteger(v) ? BigInt(v) : v;
    if (typeof v === "object" && v !== null && !(v instanceof Uint8Array))
      throw new ErreurProgrammation(`type '${Array.isArray(v) ? "list" : "dict"}' is not supported`);
    return v as Valeur;
  });
}

/** Objet d'une ligne en tableau : la première colonne d'un nom l'emporte. */
export function objetLigne(noms: readonly string[], valeurs: readonly unknown[]): Ligne {
  const o: Ligne = {};
  noms.forEach((n, i) => {
    if (!Object.hasOwn(o, n)) o[n] = valeurs[i];
  });
  return o;
}

export abstract class BaseCommune implements Base {
  abstract readonly dialecte: Dialecte;
  protected readonly delaiMs: number;
  private readonly contexte = new AsyncLocalStorage<Contexte>();
  private readonly garde: (() => void) | undefined;

  protected constructor(delaiMs: number, garde?: () => void) {
    this.delaiMs = delaiMs;
    this.garde = garde;
  }

  protected abstract horsTransaction(sql: string, params: Parametres, mode: Mode): Promise<unknown>;
  protected abstract scriptHorsTransaction(script: string): Promise<void>;
  protected abstract debuter(ecriture: boolean): Promise<Session>;
  protected abstract verrouillerEcriture(s: Session): Promise<void>;
  protected abstract terminer(s: Session, valider: boolean): Promise<void>;
  abstract stats(): StatsPool | null;
  abstract fermer(): Promise<void>;

  private actif(): Contexte | undefined {
    for (let c: Contexte | null | undefined = this.contexte.getStore(); c; c = c.parent) {
      if (c.actif && c.base === this) return c;
    }
    return undefined;
  }

  /** Dans une transaction, une requête attend la fin d'un point de sauvegarde ouvert en parallèle dans le même contexte. */
  private async dansContexte<T>(c: Contexte, fn: () => Promise<T>): Promise<T> {
    const liberer = await c.verrou.prendre(
      this.delaiMs,
      "database is locked: transaction imbriquée en cours",
    );
    try {
      return await fn();
    } finally {
      liberer();
    }
  }

  private async executer(sql: string, params: Parametres | undefined, mode: Mode): Promise<unknown> {
    this.garde?.();
    verifierInstruction(sql);
    const c = this.actif();
    if (!c) return this.horsTransaction(sql, params ?? [], mode);
    return this.dansContexte(c, () => c.session.executer(sql, params ?? [], mode));
  }

  async all<T extends Ligne = Ligne>(sql: string, params?: Parametres): Promise<T[]> {
    return (await this.executer(sql, params, "all")) as T[];
  }

  async get<T extends Ligne = Ligne>(sql: string, params?: Parametres): Promise<T | undefined> {
    return (await this.executer(sql, params, "get")) as T | undefined;
  }

  async valeurs<T extends unknown[] = unknown[]>(sql: string, params?: Parametres): Promise<T[]> {
    return (await this.executer(sql, params, "valeurs")) as T[];
  }

  async run(sql: string, params?: Parametres): Promise<Resultat> {
    return (await this.executer(sql, params, "run")) as Resultat;
  }

  async insertId(sql: string, params?: Parametres): Promise<number> {
    return (await this.executer(sql, params, "id")) as number;
  }

  async exec(script: string): Promise<void> {
    this.garde?.();
    verifierScript(script);
    const c = this.actif();
    if (!c) return this.scriptHorsTransaction(script);
    return this.dansContexte(c, () => c.session.executerScript(script));
  }

  async runMany(sql: string, lignes: readonly Parametres[]): Promise<Resultat> {
    if (!lignes.length) return { changes: 0, lastInsertRowid: null };
    return this.transaction(async () => {
      let changes = 0;
      for (const l of lignes) changes += (await this.run(sql, l)).changes;
      return { changes, lastInsertRowid: null };
    });
  }

  transaction<T>(fn: (tx: Executeur) => Promise<T>): Promise<T> {
    return this.ouvrir(false, fn);
  }

  ecriture<T>(fn: (tx: Executeur) => Promise<T>): Promise<T> {
    return this.ouvrir(true, fn);
  }

  private async ouvrir<T>(ecriture: boolean, fn: (tx: Executeur) => Promise<T>): Promise<T> {
    this.garde?.();
    const parent = this.actif();
    if (parent) return this.pointDeSauvegarde(parent, ecriture, fn);
    const session = await this.debuter(ecriture);
    const c: Contexte = {
      base: this,
      session,
      parent: null,
      ecriture: ecriture || this.dialecte === "sqlite",
      actif: true,
      profondeur: 0,
      verrou: new Verrou(),
    };
    let r: T;
    try {
      r = await this.contexte.run(c, () => fn(this));
      (await c.verrou.prendre(this.delaiMs, EN_COURS))();
    } catch (e) {
      c.actif = false;
      await this.terminer(session, false).catch(() => undefined); // l'erreur d'origine prime sur celle du rollback
      throw e;
    }
    c.actif = false;
    await this.terminer(session, true);
    return r;
  }

  private async pointDeSauvegarde<T>(
    parent: Contexte,
    ecriture: boolean,
    fn: (tx: Executeur) => Promise<T>,
  ): Promise<T> {
    const liberer = await parent.verrou.prendre(
      this.delaiMs,
      "database is locked: transaction imbriquée en attente",
    );
    try {
      if (!parent.actif) throw new ErreurProgrammation("transaction parente déjà terminée");
      const enfant: Contexte = { ...parent, parent, profondeur: parent.profondeur + 1, verrou: new Verrou() };
      const nom = `elpis_sp_${enfant.profondeur}`;
      await parent.session.executer(`SAVEPOINT ${nom}`, [], "run");
      const verrouPose = ecriture && !parent.ecriture;
      try {
        if (verrouPose) {
          await this.verrouillerEcriture(parent.session);
          parent.ecriture = true;
          enfant.ecriture = true;
        }
        const r = await this.contexte.run(enfant, () => fn(this));
        (await enfant.verrou.prendre(this.delaiMs, EN_COURS))();
        enfant.actif = false;
        await parent.session.executer(`RELEASE SAVEPOINT ${nom}`, [], "run");
        return r;
      } catch (e) {
        enfant.actif = false;
        if (verrouPose) parent.ecriture = false; // ROLLBACK TO relâche aussi le FOR UPDATE pris après le point
        try {
          await parent.session.executer(`ROLLBACK TO SAVEPOINT ${nom}`, [], "run");
          await parent.session.executer(`RELEASE SAVEPOINT ${nom}`, [], "run");
        } catch {
          // l'erreur d'origine prime ; la transaction parente échouera à sa validation
        }
        throw e;
      }
    } finally {
      liberer();
    }
  }
}
