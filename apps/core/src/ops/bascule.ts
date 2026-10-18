// SPDX-License-Identifier: MIT
/** apps/core/src/ops/bascule.ts — bascule de la base d'un moteur à l'autre (page admin « Base de données ») : drapeau de maintenance, tâche de fond, config.json (shared_infra/ops/db_switch.py). */
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { intPy, pyJsonDumps, pyJsonLoads, stripPy, strPy, veritePy } from "@elpis/commun";
import {
  config,
  CONFIG_ILLISIBLE,
  configView,
  DB_BACKENDS_RETIRED,
  lireConfigDisque,
  readConfigJson,
  sousVerrouConfigJson,
  writeConfigJson,
  writeTextAtomic,
} from "@elpis/config";
import type { FastifyInstance } from "fastify";

import { lireConfigPy } from "./config-py";
import type { Journal } from "../journal";
import { activeGenerations } from "./redemarrage";
import type { SourceGenerations } from "./redemarrage";
import { describe, ErreurTransfert, supprimerSqlite, transferer } from "./transfert";
import type { Cible, CibleServeur } from "./transfert";

type Dict = Record<string, unknown>;

export const WAIT_GENERATIONS_S = 120;
export const JOB_STALE_S = 600;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_PREFIXES = ["/api/admin/database", "/api/auth/", "/api/admin/internal/"];
const CONN_KEYS = ["host", "port", "name", "user", "tls"] as const;

function dataDir(): string {
  return dirname(config.DB_PATH);
}

export function cheminJob(): string {
  return join(dataDir(), ".db_job.json");
}

export function cheminDrapeau(): string {
  return join(dataDir(), ".db_maintenance");
}

function estDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function get(d: unknown, cle: string): unknown {
  return estDict(d) && Object.hasOwn(d, cle) ? d[cle] : undefined;
}

/** `int(x or 0)` ; une valeur illisible vaut 0 comme les `except (TypeError, ValueError)` du Python. */
function entier(v: unknown): number {
  try {
    return intPy(veritePy(v) ? v : 0);
  } catch {
    return 0;
  }
}

/** `int(x or 0)` sans repli : une génération illisible lève (500) comme en Python. */
function entierStrict(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

export function processGeneration(): number {
  return entier(config.DB_GENERATION);
}

/** Génération publiée dans config.json. */
export function currentGeneration(): number {
  return entier(get(get(configView(), "database") ?? {}, "generation"));
}

/** Drapeau de maintenance : `null` absent, `{}` présent mais illisible. */
export function lireDrapeau(): Dict | null {
  let brut: string;
  try {
    brut = readFileSync(cheminDrapeau(), "utf-8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return null;
    return {};
  }
  try {
    const d = pyJsonLoads(brut, { mode: "natif" });
    return estDict(d) ? d : {};
  } catch {
    return {};
  }
}

export function publishedGeneration(): number {
  const d = lireDrapeau() ?? {};
  return veritePy(get(d, "published")) ? entier(get(d, "generation")) : 0;
}

/** Vrai pour un process d'une génération antérieure à une bascule en cours (tâche vivante) ou publiée ; un drapeau orphelin n'est plus écouté. */
export function maintenanceActive(): boolean {
  const d = lireDrapeau();
  if (d === null) return false;
  const cible = entier(get(d, "generation"));
  if (!cible) return enCours();
  if (processGeneration() >= cible) return false;
  return veritePy(get(d, "published")) || currentGeneration() >= cible || enCours();
}

/** `MaintenanceASGI` : 503 sur les requêtes qui écrivent pendant une bascule (hors base, authentification et canal interne), état relu au plus une fois par seconde. */
export function installerMaintenance(
  app: FastifyInstance,
  maintenant: () => number = () => performance.now(),
): void {
  let verifie = Number.NEGATIVE_INFINITY;
  let actif = false;
  app.addHook("onRequest", async (requete, reponse) => {
    if (!MUTATING.has(requete.method)) return;
    const t = maintenant();
    if (t - verifie > 1_000) {
      verifie = t;
      actif = maintenanceActive();
    }
    if (!actif) return;
    let chemin = (requete.raw.url ?? requete.url).split("?")[0] ?? "";
    try {
      chemin = decodeURIComponent(chemin);
    } catch {
      // chemin mal encodé : comparé tel quel
    }
    if (ALLOWED_PREFIXES.some((p) => chemin.startsWith(p))) return;
    return reponse
      .code(503)
      .headers({ "content-type": "application/json", "retry-after": "30" })
      .send(pyJsonDumps({ detail: "Base de données en cours de bascule — réessayer dans un instant." }));
  });
}

function lireJob(): Dict {
  try {
    const st = pyJsonLoads(readFileSync(cheminJob(), "utf-8"), { mode: "natif" });
    return estDict(st) ? st : { state: "idle" };
  } catch {
    return { state: "idle" };
  }
}

function pidVivant(pid: unknown): boolean {
  try {
    process.kill(intPy(pid), 0);
    return true;
  } catch (e) {
    return (e as { code?: unknown }).code === "EPERM";
  }
}

/** La tâche « running » a-t-elle encore un process derrière elle (mis à jour il y a moins de 10 min, PID vivant) ? */
function vivante(st: Dict): boolean {
  if (st["state"] !== "running") return false;
  const maj = typeof st["updated_at"] === "number" ? st["updated_at"] : Number(st["updated_at"] ?? 0) || 0;
  if (Date.now() / 1000 - maj >= JOB_STALE_S) return false;
  return !Object.hasOwn(st, "pid") || pidVivant(st["pid"]);
}

export function jobStatus(): Dict {
  const st = lireJob();
  if (st["state"] === "running" && !vivante(st)) {
    return {
      ...st,
      state: "error",
      error: "bascule interrompue : le process qui la menait s'est arrêté ; la base active n'a pas changé",
    };
  }
  return st;
}

function ecrireJob(champs: Dict): void {
  const cur = lireJob();
  for (const [k, v] of Object.entries(champs)) cur[k] = v;
  cur["updated_at"] = Date.now() / 1000;
  writeTextAtomic(cheminJob(), pyJsonDumps(cur, { ensureAscii: false }));
}

function enCours(): boolean {
  return vivante(lireJob());
}

function cheminMotDePasse(pending = false): string {
  return join(dataDir(), pending ? ".db_password.pending" : ".db_password");
}

/** Mot de passe dans un fichier 0600 hors de config.json. */
export function savePassword(motDePasse: string, pending = false): void {
  const chemin = cheminMotDePasse(pending);
  const fd = openSync(chemin, "w", 0o600);
  try {
    writeSync(fd, motDePasse);
  } finally {
    closeSync(fd);
  }
  chmodSync(chemin, 0o600);
}

/** Mot de passe de la cible enregistrée sans bascule (aucun pour un moteur retiré), ou "". */
export function pendingPassword(): string {
  const pending = get(get(readConfigJson(), "database") ?? {}, "pending") ?? {};
  if (DB_BACKENDS_RETIRED.includes(stripPy(strPy(get(pending, "backend") || "")).toLowerCase())) return "";
  try {
    return stripPy(readFileSync(cheminMotDePasse(true), "utf-8"));
  } catch {
    return "";
  }
}

function section(cfg: Dict): Dict {
  if (!Object.hasOwn(cfg, "database")) cfg["database"] = {};
  const db = cfg["database"];
  if (!estDict(db)) throw new TypeError(`'${typeof db}' object does not support item assignment`);
  return db;
}

/** Section `database` de config.json ; rend la génération publiée. Sans bascule, la cible est rangée à part (`pending`). */
export async function writeDatabaseConfig(cible: Dict, bascule: boolean): Promise<number> {
  return sousVerrouConfigJson(() => {
    const cfg = lireConfigPy();
    const db = section(cfg);
    const vide = (v: unknown): boolean => v === undefined || v === null || v === "";
    if (!bascule) {
      const pending: Dict = { backend: cible["backend"] };
      for (const k of CONN_KEYS) if (!vide(cible[k])) pending[k] = cible[k];
      db["pending"] = pending;
      if (veritePy(cible["password"])) savePassword(String(cible["password"]), true);
      writeConfigJson(cfg);
      return entierStrict(db["generation"]);
    }
    if (cible["backend"] !== "sqlite") {
      for (const k of CONN_KEYS) if (!vide(cible[k])) db[k] = cible[k];
      const motDePasse = (veritePy(cible["password"]) ? String(cible["password"]) : "") || pendingPassword();
      if (motDePasse) savePassword(motDePasse);
      delete db["pending"];
      rmSync(cheminMotDePasse(true), { force: true });
    }
    db["backend"] = cible["backend"];
    const generation = entierStrict(db["generation"]) + 1;
    db["generation"] = generation;
    writeConfigJson(cfg);
    return generation;
  });
}

/** La base qu'utilise ce process (config + environnement), sans mot de passe. */
export function cibleActive(): Cible {
  if (config.DB_BACKEND === "sqlite") return { backend: "sqlite", path: config.DB_PATH };
  return {
    backend: config.DB_BACKEND,
    host: config.DB_HOST,
    port: config.DB_PORT,
    name: config.DB_NAME,
    user: config.DB_USER,
    tls: config.DB_TLS,
    timeout: config.DB_TIMEOUT,
    schema: null,
  };
}

export interface DependancesBascule {
  readonly journal: Journal;
  /** Rechargement de main puis de ce process (`_reloader`). */
  recharger(): unknown;
  /** Générations en cours de main (lues par le canal interne depuis l'admin) ; défaut : celles de ce process. */
  readonly generations?: SourceGenerations;
  /** Pour les tests : attente entre deux relectures des générations en cours. */
  readonly pauseGenerationsMs?: number;
}

let verrouJob = false;

/** `start_job` : lance `migrate` (vers `cible`) ou `sqlite` (retour à un fichier SQLite neuf) en tâche de fond ; refuse si une tâche tourne déjà. */
export function startJob(kind: "migrate" | "sqlite", cible: Cible & Dict, dep: DependancesBascule): Dict {
  if (verrouJob || enCours()) return { ok: false, error: "une bascule est déjà en cours" };
  if (lireConfigDisque() === null) return { ok: false, error: CONFIG_ILLISIBLE };
  ecrireJob({
    state: "running",
    kind,
    step: "préparation",
    progress: null,
    report: null,
    error: null,
    started_at: Date.now() / 1000,
    pid: process.pid,
  });
  verrouJob = true;
  void executer(kind, cible, dep)
    .catch((e: unknown) => dep.journal.error({ err: e }, "[db-switch] état de la tâche non écrit"))
    .finally(() => {
      verrouJob = false;
    });
  return { ok: true };
}

/** Générations finies avant le transfert ; un compte inconnu (main injoignable) se réessaie jusqu'au plafond, jamais pris pour zéro. */
async function attendreGenerations(pauseMs: number, source: SourceGenerations): Promise<void> {
  const limite = performance.now() + WAIT_GENERATIONS_S * 1000;
  for (;;) {
    const n = await source();
    if (n === 0) return;
    const quoi = n === null ? "génération(s) en nombre inconnu (main injoignable)" : `${n} génération(s)`;
    if (performance.now() > limite)
      throw new Error(`${quoi} toujours en cours après ${WAIT_GENERATIONS_S} s — réessayer plus tard`);
    ecrireJob({ step: n === null ? "attente des générations de main" : `attente de ${n} génération(s)` });
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}

function horodatage(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Fichier neuf à la place de l'ancien (annexes WAL comprises, mises de côté en `.bak-`) ; un échec remet l'ancien en place (Python le laissait de côté). */
export function echangerFichiers(e: { live: string; fresh: string; bak: string }): void {
  const faits: [string, string][] = [];
  try {
    for (const s of ["", "-wal", "-shm"]) {
      if (existsSync(e.live + s)) {
        renameSync(e.live + s, e.bak + s);
        faits.push([e.live + s, e.bak + s]);
      }
    }
    renameSync(e.fresh, e.live);
  } catch (x) {
    for (const [de, vers] of faits.reverse()) {
      try {
        renameSync(vers, de);
      } catch {
        // l'ancienne base reste sous son nom .bak-
      }
    }
    throw x;
  }
}

/** `_run` : drapeau, attente des générations, transfert gelé et vérifié, échange de fichiers (retour à SQLite), config publiée, rechargement ; un échec efface le drapeau et la copie neuve. */
async function executer(kind: string, cible: Cible & Dict, dep: DependancesBascule): Promise<void> {
  const nouvelle = currentGeneration() + 1;
  let echange: { live: string; fresh: string; bak: string } | null = null;
  let cibleEffective: Cible & Dict = cible;
  try {
    writeTextAtomic(cheminDrapeau(), pyJsonDumps({ generation: nouvelle, since: Date.now() / 1000 }));
    await attendreGenerations(dep.pauseGenerationsMs ?? 2_000, dep.generations ?? activeGenerations);
    const source = cibleActive();
    if (kind === "sqlite") {
      const live = config.DB_PATH;
      const stamp = horodatage();
      echange = { live, fresh: `${live}.new-${stamp}`, bak: `${live}.bak-${stamp}` };
      cibleEffective = { backend: "sqlite", path: echange.fresh };
    }
    ecrireJob({ step: "transfert" });
    const rapport = await transferer(source, cibleEffective, {
      freeze: true,
      journal: dep.journal,
      progress: (table, faits, total) => ecrireJob({ step: `copie ${table}`, progress: [faits, total] }),
    });
    ecrireJob({ report: rapport });
    if (!rapport["ok"]) {
      const ecarts = (rapport["mismatches"] as string[] | undefined) ?? [];
      throw new Error(`vérification en échec : ${ecarts.join("; ")}`);
    }
    if (echange) {
      echangerFichiers(echange);
      cibleEffective = { backend: "sqlite" } as Cible & Dict;
    }
    await writeDatabaseConfig(cibleEffective, true);
    writeTextAtomic(
      cheminDrapeau(),
      pyJsonDumps({ generation: nouvelle, since: Date.now() / 1000, published: true }),
    );
    ecrireJob({ state: "done", step: "rechargement", finished_at: Date.now() / 1000 });
    const decrit =
      "path" in cibleEffective || "host" in cibleEffective ? describe(cibleEffective as Cible) : "sqlite";
    dep.journal.warn(`[db-switch] base basculée vers ${decrit} (génération ${nouvelle})`);
    await dep.recharger();
  } catch (e) {
    const message = e instanceof ErreurTransfert || e instanceof Error ? e.message : String(e);
    dep.journal.error(`[db-switch] bascule abandonnée : ${message}`);
    for (const nettoyer of [
      () => rmSync(cheminDrapeau(), { force: true }),
      () => (echange && existsSync(echange.fresh) ? supprimerSqlite(echange.fresh) : undefined),
    ]) {
      try {
        nettoyer();
      } catch (x) {
        dep.journal.warn({ err: x }, "[db-switch] nettoyage après échec incomplet");
      }
    }
    ecrireJob({ state: "error", error: message, finished_at: Date.now() / 1000 });
  }
}

/** Pour les tests : oublie une tâche en cours dans ce process. */
export function reinitialiserBascule(): void {
  verrouJob = false;
}

export type { CibleServeur };
