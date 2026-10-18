// SPDX-License-Identifier: MIT
/** apps/core/src/ops/transfert.ts — transfert des données d'une base Elpis vers une base vierge, entre SQLite et PostgreSQL (shared_infra/db/transfer.py). */
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import Database from "better-sqlite3";

import {
  comparePointsDeCode,
  floatPy,
  FlottantPy,
  formatValeur,
  hostname,
  intPy,
  port,
  reprPy,
  stripPy,
  strPy,
  urlsplit,
} from "@elpis/commun";
import { dbPassword } from "@elpis/config";
import {
  BASELINE_COVERS,
  bytesOrder,
  createAll,
  decrireEmplacement,
  ouvrirBase,
  q,
  registreMigrations,
  TABLES,
  tableColumns,
  tableNames,
} from "@elpis/db";
import type { Base, Dialecte, Executeur, Table, Valeur } from "@elpis/db";

import type { Journal } from "../journal";

type Dict = Record<string, unknown>;

export const BATCH_ROWS = 2000;
export const MAX_PARAMS = 30000;
export const SAMPLE = 200;
const SKIP = new Set(["schema_migrations", "elpis_locks"]);
/** Table témoin d'une copie en cours : une cible qui la porte a été laissée par une copie interrompue. */
export const PARTIAL_MARK = "elpis_transfer_partiel";

/** `TransferError` : contrôle préalable refusé, rien n'a été écrit sur la cible. */
export class ErreurTransfert extends Error {
  override name = "TransferError";
}

export interface CibleSqlite {
  backend: "sqlite";
  path: string;
}

export interface CibleServeur {
  backend: string;
  host: string;
  port: number;
  name: string;
  user: string;
  password?: string;
  tls?: string;
  timeout?: number;
  schema?: string | null;
}

export type Cible = CibleSqlite | CibleServeur;

const SCHEMAS: Readonly<Record<string, string>> = {
  postgres: "postgres",
  postgresql: "postgres",
  pg: "postgres",
};

/** `urllib.parse.unquote` : `%XX` relus en UTF-8, séquences invalides remplacées. */
export function unquotePy(s: string): string {
  if (!s.includes("%")) return s;
  const octets: number[] = [];
  const morceaux: string[] = [];
  const vider = (): void => {
    if (octets.length) morceaux.push(Buffer.from(octets).toString("utf8"));
    octets.length = 0;
  };
  for (let i = 0; i < s.length;) {
    const m = /^%([0-9A-Fa-f]{2})/u.exec(s.slice(i, i + 3));
    if (m) {
      octets.push(parseInt(m[1] as string, 16));
      i += 3;
      continue;
    }
    vider();
    const c = String.fromCodePoint(s.codePointAt(i) ?? 0);
    morceaux.push(c);
    i += c.length;
  }
  vider();
  return morceaux.join("");
}

function infoUtilisateur(netloc: string): [string | null, string | null] {
  const at = netloc.lastIndexOf("@");
  if (at < 0) return [null, null];
  const info = netloc.slice(0, at);
  const deux = info.indexOf(":");
  return deux < 0 ? [info, null] : [info.slice(0, deux), info.slice(deux + 1)];
}

/** `parse_qs(query).get(cle)` (valeurs vides ignorées, `+` = espace). */
function valeursRequete(query: string, cle: string): string[] {
  const out: string[] = [];
  for (const paire of query.split("&")) {
    const egal = paire.indexOf("=");
    if (egal < 0) continue;
    const valeur = paire.slice(egal + 1);
    if (!valeur) continue;
    if (unquotePy(paire.slice(0, egal).replaceAll("+", " ")) === cle)
      out.push(unquotePy(valeur.replaceAll("+", " ")));
  }
  return out;
}

/** `parse_target` : `sqlite:/chemin` ou `postgres://user@hôte:port/base?tls=…` ; le mot de passe se passe à part. */
export function parseTarget(texte: string | null, password?: string): Cible {
  const t = stripPy(texte ?? "");
  if (t.startsWith("sqlite:")) {
    let chemin = t.slice("sqlite:".length);
    if (chemin.startsWith("//")) chemin = chemin.slice(2);
    if (!chemin) throw new RangeError("chemin SQLite manquant (sqlite:/chemin/app.db)");
    return { backend: "sqlite", path: chemin };
  }
  const u = urlsplit(t);
  const backend = SCHEMAS[u.scheme.toLowerCase()];
  const hote = hostname(u);
  if (backend === undefined || !hote || !u.path.replace(/^\/+|\/+$/gu, ""))
    throw new RangeError(`cible illisible : ${reprPy(t)} (attendu sqlite:/… ou postgres://…)`);
  const [utilisateur, motDePasse] = infoUtilisateur(u.netloc);
  return {
    backend,
    host: hote,
    port: port(u) || 5432,
    name: unquotePy(u.path.replace(/^\/+|\/+$/gu, "")),
    user: unquotePy(utilisateur || "elpis"),
    password: password !== undefined ? password : unquotePy(motDePasse || ""),
    tls: valeursRequete(u.query, "tls")[0] ?? "off",
    timeout: 60.0,
    schema: null,
  };
}

/** Forme lisible sans mot de passe (journaux, rapport). */
export function describe(cible: Cible): string {
  return decrireEmplacement(cible as Parameters<typeof decrireEmplacement>[0]);
}

/** Connexion neuve hors du pool de l'application ; sans mot de passe, celui de la configuration (`connect_server`). */
export function connecter(cible: Cible): Base {
  if (cible.backend === "sqlite") {
    return ouvrirBase({ backend: "sqlite", path: (cible as CibleSqlite).path, lockTimeoutMs: 30_000 });
  }
  const c = cible as CibleServeur;
  if (c.backend !== "postgres") throw new Error(`moteur serveur inconnu : ${reprPy(c.backend)}`);
  return ouvrirBase({
    backend: "postgres",
    host: c.host,
    port: c.port,
    name: c.name,
    user: c.user,
    password: c.password || dbPassword(),
    tls: c.tls ?? "off",
    timeout: c.timeout ?? 60,
    schema: c.schema ?? null,
    poolMax: 2,
    application: "elpis-transfert",
  });
}

async function fermer(b: Base | null): Promise<void> {
  try {
    await b?.fermer();
  } catch {
    // connexion déjà perdue
  }
}

export async function serverVersion(x: Executeur): Promise<string> {
  try {
    if (x.dialecte === "sqlite")
      return `SQLite ${String((await x.valeurs("SELECT sqlite_version()"))[0]?.[0])}`;
    return String((await x.valeurs("SELECT version()"))[0]?.[0]).split(" on ")[0] ?? "";
  } catch (e) {
    return `? (${e instanceof Error ? e.message : String(e)})`;
  }
}

async function compter(x: Executeur, table: string): Promise<number> {
  return intPy((await x.valeurs(`SELECT COUNT(*) FROM ${q(table)}`))[0]?.[0] ?? 0);
}

export function orderKey(t: Table): string[] {
  if (t.pk?.length) return t.pk;
  for (const c of t.cols) if (c.primary || c.type === "id") return [c.name];
  return t.cols.map((c) => c.name);
}

function colonne(t: Table, nom: string) {
  const c = t.cols.find((x) => x.name === nom);
  if (!c) throw new Error(`colonne inconnue : ${t.name}.${nom}`);
  return c;
}

export function colKind(t: Table, nom: string, d: Dialecte): "int" | "real" | "text" {
  const c = colonne(t, nom);
  const typ = c.types?.[d] ?? c.type;
  return typ === "id" || typ === "int" ? "int" : typ === "real" ? "real" : "text";
}

export class ErreurCoercition extends Error {}

/** Texte `str(v)` d'une valeur relue en base : octets décodés, flottant JS entier écrit comme un entier. */
function textePy(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (typeof v === "string") return v;
  return strPy(v);
}

/** `_coerce` : valeur source vers le type de la colonne cible ; une valeur inconvertible lève (ligne rejetée). */
export function coerce(v: unknown, kind: "int" | "real" | "text"): Valeur {
  if (v === null || v === undefined) return null;
  try {
    if (kind === "int") {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "bigint") return v;
      if (typeof v === "number" && Number.isInteger(v)) return v;
      if (v instanceof Uint8Array) throw new ErreurCoercition(`entier attendu : ${reprPy(textePy(v))}`);
      const s = stripPy(textePy(v));
      try {
        return intPy(s);
      } catch {
        const f = floatPy(s);
        if (!Number.isInteger(f)) throw new ErreurCoercition(`entier attendu : ${reprPy(v)}`);
        return f;
      }
    }
    if (kind === "real") {
      if (typeof v === "number") return new FlottantPy(v) as unknown as Valeur;
      if (typeof v === "bigint") return new FlottantPy(Number(v)) as unknown as Valeur;
      if (v instanceof FlottantPy) return new FlottantPy(v.valeur) as unknown as Valeur;
      if (v instanceof Uint8Array) throw new ErreurCoercition(`réel attendu : ${reprPy(textePy(v))}`);
      return new FlottantPy(floatPy(stripPy(textePy(v)))) as unknown as Valeur;
    }
    return textePy(v);
  } catch (e) {
    if (e instanceof ErreurCoercition) throw e;
    throw new ErreurCoercition(e instanceof Error ? e.message : String(e));
  }
}

/** `_norm` : forme comparable d'une valeur quel que soit le moteur qui la rend. */
export function norm(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (v instanceof FlottantPy) return norm(v.valeur);
  if (typeof v === "number") {
    if (Number.isInteger(v)) return BigInt(v).toString();
    return formatValeur(new FlottantPy(v), ".9g");
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  if (typeof v === "boolean") return v ? "True" : "False";
  return typeof v === "string" ? v : String(v);
}

export function digest(lignes: readonly (readonly unknown[])[]): string {
  const h = createHash("sha256");
  for (const r of lignes) {
    h.update(Buffer.from(r.map(norm).join("\x1f"), "utf8"));
    h.update(Buffer.from([0x1e]));
  }
  return h.digest("hex");
}

/** Clé d'égalité d'un n-uplet comme en Python (`5 == 5.0`, `"5" != 5`). */
function cleTuple(valeurs: readonly unknown[]): string {
  return JSON.stringify(
    valeurs.map((v) => {
      if (v === null || v === undefined) return ["z"];
      if (v instanceof FlottantPy) return ["n", String(v.valeur)];
      if (typeof v === "number" || typeof v === "bigint") return ["n", String(v)];
      if (typeof v === "boolean") return ["n", v ? "1" : "0"];
      if (v instanceof Uint8Array) return ["b", Buffer.from(v).toString("hex")];
      return ["s", String(v)];
    }),
  );
}

/** Parents avant enfants pour une clé étrangère sur la table elle-même ; un cycle reste en fin, dans l'ordre. */
export function orderSelfRef(
  lignes: unknown[][],
  cols: readonly string[],
  fk: { cols: string[]; refCols: string[] },
): unknown[][] {
  const ic = cols.indexOf(fk.refCols[0] as string);
  const pc = cols.indexOf(fk.cols[0] as string);
  let attente = [...lignes];
  const places = new Set<string>();
  const out: unknown[][] = [];
  while (attente.length) {
    const reste: unknown[][] = [];
    for (const r of attente) {
      if (r[pc] === null || r[pc] === undefined || places.has(cleTuple([r[pc]]))) {
        out.push(r);
        places.add(cleTuple([r[ic]]));
      } else {
        reste.push(r);
      }
    }
    if (reste.length === attente.length) {
      out.push(...reste);
      break;
    }
    attente = reste;
  }
  return out;
}

async function missingMigrations(x: Executeur): Promise<string[]> {
  const connues = registreMigrations();
  if (!(await tableNames(x)).includes("schema_migrations")) return connues;
  const faites = new Set((await x.valeurs("SELECT name FROM schema_migrations")).map((r) => String(r[0])));
  return connues.filter((n) => !faites.has(n));
}

/** « Tester » : joignable ? version, tables présentes, latence ; une cible laissée par une copie interrompue compte comme vide. */
export async function checkTarget(cible: Cible): Promise<Dict> {
  const t0 = performance.now();
  const b = connecter(cible);
  try {
    const noms = await tableNames(b);
    const latence = performance.now() - t0;
    const t1 = performance.now();
    await b.valeurs("SELECT 1");
    const rtt = performance.now() - t1;
    const partielle = noms.includes(PARTIAL_MARK);
    const out: Dict = {
      ok: true,
      target: describe(cible),
      version: await serverVersion(b),
      tables: noms.length,
      empty: noms.length === 0 || partielle,
      partial: partielle,
      connect_ms: Math.round(latence * 10) / 10,
      query_ms: Math.round(rtt * 100) / 100,
    };
    if (b.dialecte === "postgres") {
      out["unaccent"] =
        (await b.valeurs("SELECT 1 FROM pg_available_extensions WHERE name='unaccent'")).length > 0;
    }
    return out;
  } finally {
    await fermer(b);
  }
}

/** `_clear_target` : la cible, vérifiée vierge au départ, est vidée de ce que la copie y a mis (plusieurs passes). */
async function viderCible(dst: Base, rapport: Dict, journal?: Journal): Promise<void> {
  let reste: string[];
  try {
    for (let passe = 0; passe < 3; passe++) {
      const noms = await tableNames(dst);
      if (!noms.length) break;
      for (const nom of noms) {
        try {
          await dst.run(`DROP TABLE IF EXISTS ${q(nom)}${dst.dialecte === "postgres" ? " CASCADE" : ""}`);
        } catch {
          // passe suivante (tables internes du plein texte SQLite)
        }
      }
    }
    reste = await tableNames(dst);
  } catch (e) {
    journal?.error(
      `[transfer] cible non vidée après l'échec : ${e instanceof Error ? e.message : String(e)}`,
    );
    rapport["target_cleared"] = false;
    return;
  }
  rapport["target_cleared"] = reste.length === 0;
  if (reste.length)
    journal?.error(`[transfer] cible non vidée après l'échec : ${reste.length} tables restent`);
  else journal?.warn("[transfer] copie en échec : cible vidée, une nouvelle tentative est possible");
}

async function insererLignes(
  x: Executeur,
  table: string,
  cols: readonly string[],
  lignes: Valeur[][],
): Promise<void> {
  if (!lignes.length) return;
  const par = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / Math.max(1, cols.length))));
  const tete = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES `;
  const une = `(${cols.map(() => "?").join(", ")})`;
  for (let i = 0; i < lignes.length; i += par) {
    const lot = lignes.slice(i, i + par);
    await x.run(tete + lot.map(() => une).join(", "), lot.flat());
  }
}

async function recalerIdentite(dst: Base, t: Table): Promise<void> {
  const id = t.cols.find((c) => c.type === "id");
  if (!id || dst.dialecte !== "postgres") return;
  const haut = (await dst.valeurs(`SELECT MAX(${q(id.name)}) FROM ${q(t.name)}`))[0]?.[0];
  const suivant = intPy(haut ?? 0) + 1;
  await dst.valeurs(`SELECT setval(pg_get_serial_sequence(?, ?), ${suivant}, false)`, [q(t.name), id.name]);
}

async function echantillon(x: Executeur, t: Table, cols: readonly string[]): Promise<unknown[][]> {
  const types = new Map(t.cols.map((c) => [c.name, c.type]));
  const ordre = orderKey(t)
    .map((c) => (types.get(c) === "text" ? bytesOrder(q(c), x.dialecte) : q(c)))
    .join(", ");
  return x.valeurs(`SELECT ${cols.map(q).join(", ")} FROM ${q(t.name)} ORDER BY ${ordre} LIMIT ${SAMPLE}`);
}

async function* pages(x: Executeur, t: Table, cols: readonly string[]): AsyncGenerator<unknown[][]> {
  const base = `SELECT ${cols.map(q).join(", ")} FROM ${q(t.name)} ORDER BY ${orderKey(t).map(q).join(", ")}`;
  for (let decalage = 0; ;) {
    const lignes = await x.valeurs(`${base} LIMIT ${BATCH_ROWS} OFFSET ${decalage}`);
    if (!lignes.length) return;
    yield lignes;
    if (lignes.length < BATCH_ROWS) return;
    decalage += lignes.length;
  }
}

/** Instantané cohérent de la source ; `gel` bloque en plus les écritures des autres process jusqu'à la fin de la lecture. */
async function debuterInstantane(tx: Executeur, gel: boolean): Promise<void> {
  if (tx.dialecte === "sqlite") return;
  if (!gel) {
    await tx.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return;
  }
  await tx.run("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  const connues = new Set(TABLES.map((t) => t.name));
  const noms = (await tableNames(tx)).filter((n) => connues.has(n));
  if (noms.length) await tx.run(`LOCK TABLE ${noms.map(q).join(", ")} IN SHARE MODE`);
}

/** Fichier SQLite autonome comme celui de Python : journal WAL fusionné, mode DELETE. */
function rendreAutonome(chemin: string): void {
  const db = new Database(chemin, { timeout: 30_000 });
  try {
    db.pragma("journal_mode = DELETE");
  } finally {
    db.close();
  }
}

export interface OptionsTransfert {
  dryRun?: boolean;
  freeze?: boolean;
  progress?: (table: string, faits: number, total: number) => void;
  journal?: Journal;
}

/** Copie `source` → `cible` (vierge) et rend le rapport ; lève `ErreurTransfert` si un contrôle préalable échoue (cible intacte). */
export async function transferer(source: Cible, cible: Cible, options: OptionsTransfert = {}): Promise<Dict> {
  const debut = Date.now();
  const dryRun = options.dryRun ?? false;
  const journal = options.journal;
  const rapport: Dict = {
    source: describe(source),
    target: describe(cible),
    dry_run: dryRun,
    tables: {} as Dict,
    ignored: {} as Dict,
    orphans: 0,
    rejected: 0,
    ok: false,
  };
  if (describe(source) === describe(cible)) throw new ErreurTransfert("source et cible identiques");
  const src = connecter(source);
  let dst: Base | null = null;
  let ecrit = false;
  try {
    const manquantes = await missingMigrations(src);
    if (manquantes.length) {
      throw new ErreurTransfert(
        `source pas à jour (migrations non appliquées : ${manquantes.slice(0, 5).join(", ")}) — démarrer l'application une fois`,
      );
    }
    dst = connecter(cible);
    const noms = await tableNames(dst);
    if (noms.length && !noms.includes(PARTIAL_MARK)) {
      throw new ErreurTransfert(
        `cible non vide (${noms.length} tables) : le transfert exige une base vierge`,
      );
    }
    if (noms.length && !dryRun) {
      journal?.warn("[transfer] cible laissée par une copie interrompue : vidée avant de reprendre");
      await viderCible(dst, {}, journal);
      if ((await tableNames(dst)).length) {
        throw new ErreurTransfert(
          "cible laissée par une copie interrompue, impossible à vider : supprimer ses tables à la main",
        );
      }
    }
    const dDst = dst.dialecte;
    rapport["source_version"] = await serverVersion(src);
    rapport["target_version"] = await serverVersion(dst);
    const cibleBase = dst;
    const marquer = (): void => {
      ecrit = true;
    };
    if (dryRun && src.dialecte === "sqlite")
      await copier(src, cibleBase, dDst, rapport, dryRun, options, marquer);
    else
      await src.transaction(async (tx) => {
        await debuterInstantane(tx, Boolean(options.freeze) && !dryRun);
        await copier(tx, cibleBase, dDst, rapport, dryRun, options, marquer);
      });
    return rapport;
  } catch (e) {
    if (ecrit && dst) await viderCible(dst, rapport, journal);
    throw e;
  } finally {
    rapport["seconds"] = Math.round((Date.now() - debut) / 10) / 100;
    await fermer(src);
    await fermer(dst);
    if (ecrit && cible.backend === "sqlite" && rapport["ok"] === true) {
      try {
        rendreAutonome((cible as CibleSqlite).path);
      } catch (e) {
        journal?.warn(
          `[transfer] cible SQLite laissée en WAL : ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

async function copier(
  src: Executeur,
  dst: Base,
  dDst: Dialecte,
  rapport: Dict,
  dryRun: boolean,
  options: OptionsTransfert,
  marquerEcrit: () => void,
): Promise<void> {
  const presentes = new Set(await tableNames(src));
  const connues = new Set(TABLES.map((t) => t.name));
  const ignorees = rapport["ignored"] as Dict;
  for (const nom of [...presentes].filter((n) => !connues.has(n) && !SKIP.has(n)).sort(comparePointsDeCode)) {
    if (nom.startsWith("session_messages_fts") || nom.startsWith("sqlite_")) continue;
    try {
      ignorees[nom] = await compter(src, nom);
    } catch {
      ignorees[nom] = null;
    }
  }
  const plan = TABLES.filter(
    (t) => !SKIP.has(t.name) && presentes.has(t.name) && (t.only === undefined || t.only.includes(dDst)),
  );
  const tables = rapport["tables"] as Dict;
  if (dryRun) {
    for (const t of plan) {
      const colsSrc = new Set(await tableColumns(src, t.name));
      const schema = new Set(t.cols.map((c) => c.name));
      tables[t.name] = {
        source: await compter(src, t.name),
        dropped_columns: [...colsSrc].filter((c) => !schema.has(c)).sort(comparePointsDeCode),
      };
    }
    rapport["ok"] = true;
    return;
  }
  marquerEcrit();
  await dst.run(`CREATE TABLE ${q(PARTIAL_MARK)} (n INTEGER)`);
  await createAll(dst);
  const faites = (await src.valeurs("SELECT name FROM schema_migrations")).map((r) => String(r[0]));
  const tampon = [...new Set([...faites, ...BASELINE_COVERS])].sort();
  await dst.transaction(async (x) => {
    for (const n of tampon) {
      await x.run(
        "INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?) ON CONFLICT(name) DO NOTHING",
        [n, new FlottantPy(Date.now() / 1000) as unknown as Valeur],
      );
    }
  });
  if (dDst === "sqlite") await dst.exec("PRAGMA foreign_keys=OFF");

  const clesCopiees = new Map<string, Set<string>>();
  const referencees: [string, string[]][] = [];
  for (const t of TABLES) {
    for (const fk of t.fks ?? []) {
      if (!referencees.some(([tb, rc]) => tb === fk.table && rc.join(",") === fk.refCols.join(",")))
        referencees.push([fk.table, fk.refCols]);
    }
  }
  for (const t of plan) {
    const colsSrc = await tableColumns(src, t.name);
    const cols = t.cols.map((c) => c.name).filter((c) => colsSrc.includes(c));
    const kinds = cols.map((c) => colKind(t, c, dDst));
    const total = await compter(src, t.name);
    const fks = (t.fks ?? []).filter((fk) => fk.cols.every((c) => cols.includes(c)));
    const autoFks = fks.filter((fk) => fk.table === t.name);
    const info: Dict = {
      source: total,
      copied: 0,
      orphans: 0,
      rejected: 0,
      dropped_columns: colsSrc.filter((c) => !cols.includes(c)).sort(comparePointsDeCode),
    };
    const aGarder = referencees.filter(([tb]) => tb === t.name).map(([, rc]) => rc);
    const accepter = (r: unknown[]): Valeur[] | null => {
      for (const fk of fks) {
        if (fk.table === t.name) continue;
        const val = fk.cols.map((c) => r[cols.indexOf(c)]);
        if (val.some((v) => v === null || v === undefined)) continue;
        const parent = clesCopiees.get(`${fk.table}:${fk.refCols.join(",")}`);
        if (parent !== undefined && !parent.has(cleTuple(val))) {
          info["orphans"] = (info["orphans"] as number) + 1;
          return null;
        }
      }
      try {
        return r.map((v, i) => coerce(v, kinds[i] as "int" | "real" | "text"));
      } catch (e) {
        info["rejected"] = (info["rejected"] as number) + 1;
        if ((info["rejected"] as number) <= 5)
          options.journal?.warn(
            `[transfer] ${t.name} : ligne rejetée (${e instanceof Error ? e.message : String(e)})`,
          );
        return null;
      }
    };
    let lots: AsyncIterable<unknown[][]> | Iterable<unknown[][]> = pages(src, t, cols);
    if (autoFks.length) {
      const tout: unknown[][] = [];
      for await (const p of pages(src, t, cols)) tout.push(...p);
      lots = [orderSelfRef(tout, cols, autoFks[0] as { cols: string[]; refCols: string[] })];
    }
    for await (const page of lots) {
      let lignes = page.map(accepter).filter((x): x is Valeur[] => x !== null);
      if (autoFks.length) {
        const fk = autoFks[0] as { cols: string[]; refCols: string[] };
        const ic = cols.indexOf(fk.refCols[0] as string);
        const pc = cols.indexOf(fk.cols[0] as string);
        const ids = new Set(lignes.map((r) => cleTuple([r[ic]])));
        lignes = lignes.filter((r) => {
          if (r[pc] !== null && !ids.has(cleTuple([r[pc]]))) {
            info["orphans"] = (info["orphans"] as number) + 1;
            return false;
          }
          return true;
        });
      }
      await dst.transaction((x) => insererLignes(x, t.name, cols, lignes));
      info["copied"] = (info["copied"] as number) + lignes.length;
      for (const rc of aGarder) {
        const idx = rc.map((c) => cols.indexOf(c));
        const cle = `${t.name}:${rc.join(",")}`;
        let ens = clesCopiees.get(cle);
        if (!ens) clesCopiees.set(cle, (ens = new Set()));
        for (const r of lignes) ens.add(cleTuple(idx.map((i) => r[i])));
      }
      options.progress?.(t.name, info["copied"] as number, total);
    }
    await recalerIdentite(dst, t);
    tables[t.name] = info;
    rapport["orphans"] = (rapport["orphans"] as number) + (info["orphans"] as number);
    rapport["rejected"] = (rapport["rejected"] as number) + (info["rejected"] as number);
  }

  const ecarts: string[] = [];
  for (const t of plan) {
    const info = tables[t.name] as Dict;
    const n = await compter(dst, t.name);
    info["target"] = n;
    if (n !== info["copied"]) {
      ecarts.push(`${t.name}: ${n} ≠ ${String(info["copied"])}`);
      continue;
    }
    if (info["orphans"] || info["rejected"]) continue;
    const colsSrc = await tableColumns(src, t.name);
    const cols = t.cols.map((c) => c.name).filter((c) => colsSrc.includes(c));
    const kinds = cols.map((c) => colKind(t, c, dDst));
    const a = await echantillon(src, t, cols);
    const b = await echantillon(dst, t, cols);
    const ha = digest(a.map((r) => r.map((v, i) => coerce(v, kinds[i] as "int" | "real" | "text"))));
    const hb = digest(b);
    info["sample_ok"] = ha === hb;
    if (ha !== hb) ecarts.push(`${t.name}: échantillon différent`);
  }
  rapport["mismatches"] = ecarts;
  rapport["ok"] = ecarts.length === 0;
  if (ecarts.length) await viderCible(dst, rapport, options.journal);
  else await dst.run(`DROP TABLE ${q(PARTIAL_MARK)}`);
}

/** Fichier SQLite et ses annexes supprimés (copie neuve abandonnée). */
export function supprimerSqlite(chemin: string): void {
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(chemin + s)) rmSync(chemin + s, { force: true });
  }
}
