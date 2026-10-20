// SPDX-License-Identifier: MIT
/** apps/core/src/ops/sauvegarde.ts — archive de sauvegarde de la console (base, user_db, images, sandboxes, MCP, skins, skills) au format de Python (routes/_helpers.py : _make_backup_zip). */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  read,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ErreurPython, estDossierPy, estFichierPy, existePy, veritePy } from "@elpis/commun";
import { config, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";
import type { Base } from "@elpis/db";
import Database from "better-sqlite3";

import { logMetric } from "../boucle/ports";
import { root as racineImages } from "../images/magasin";
import type { Journal } from "../journal";
import { cibleActive } from "./bascule";
import { avecChemin, classeErreurPy, estErreurOs, texteErreurPy } from "./erreurs-os";
import { ErreurCheminBac, lireDossierBrut, ouvrirFeuille, parcourirSous } from "@elpis/securite";
import { transferer } from "./transfert";
import { EcrivainZip, ZIP64_LIMIT } from "./zip-disque";
import type { DateHeureZip } from "@elpis/commun";

export const SCOPES = ["full", "db", "sandboxes", "mcp"] as const;
export type Portee = (typeof SCOPES)[number];
export const DB_ANNEXES = ["-wal", "-shm", "-journal"] as const;
/** Fichiers de `user_db/` propres à l'hôte : ni sauvegardés ni restaurés. */
export const HOST_ONLY = [
  ".db_password",
  ".db_password.pending",
  ".db_maintenance",
  ".db_job.json",
  ".config_boot.json",
  ".backup_send.lock",
  ".backup_send.lock.reprise",
] as const;
/** Sous-dossiers de `user_db/` ni sauvegardés ni restaurés : exécution en cours (journaux, PID), cache de l'extracteur du RAG (reconstruit à la demande). */
export const RUNTIME_DIRS = ["logs", "run", "rag-cache"] as const;
export const WORK_SUBDIR = "work";
export const AGENT_RUN_DIR = ".elpis-agent";
export const RELAY_DIR = ".elpis-relay";
export const DL_SPOOL = ".dl_spool";
export const BACKUP_INCOMPLETE_SUFFIX = "_incomplet";
const LIBELLES: Readonly<Record<string, string>> = {
  full: "complet",
  db: "db",
  sandboxes: "sandboxes",
  mcp: "mcp",
};
const DATE_MIN: DateHeureZip = [1980, 1, 1, 0, 0, 0];
const DATE_MAX: DateHeureZip = [2107, 12, 31, 23, 59, 58];

export function estPortee(scope: unknown): scope is Portee {
  return typeof scope === "string" && (SCOPES as readonly string[]).includes(scope);
}

/** `backup_incomplete` : le /work d'au moins un compte manque à cette archive. */
export function backupIncomplete(nom: string): boolean {
  return nom.endsWith(`${BACKUP_INCOMPLETE_SUFFIX}.zip`);
}

/** /work des comptes, lu et écrit par l'agent de chaque sandbox (B2) ; absent, le /work est signalé non sauvegardé. */
export interface PortTravail {
  /** `_zip_work` : membres écrits sous `arcroot`, omissions dans `skipped` ; faux si le /work n'a pas pu être lu. */
  sauvegarder(userId: number, arcroot: string, zip: EcrivainZip, skipped: string[]): Promise<boolean>;
  /** `_restaurer_work` : couples (entrée, chemin sous /work) écrits par l'agent. */
  restaurer(
    userId: number,
    lot: readonly (readonly [string, string])[],
    lire: (entree: string) => Promise<Buffer>,
    restored: string[],
    errors: string[],
  ): Promise<void>;
}

const AGENT_ABSENT = "agent_unavailable";

const travailAbsent: PortTravail = {
  sauvegarder(_uid, arcroot, _zip, skipped) {
    skipped.push(`${arcroot} — ${AGENT_ABSENT}: agent de sandbox indisponible : /work non sauvegardé`);
    return Promise.resolve(false);
  },
  restaurer(_uid, lot, _lire, _restored, errors) {
    for (const [entree] of lot) errors.push(`${entree}: ${AGENT_ABSENT}`);
    return Promise.resolve();
  },
};

let travail: PortTravail = travailAbsent;

/** Branche (ou retire avec `null`) l'accès au /work des comptes. */
export function brancherTravail(port: PortTravail | null): void {
  travail = port ?? travailAbsent;
}

export function portTravail(): PortTravail {
  return travail;
}

function comparerDates(a: DateHeureZip, b: DateHeureZip): number {
  for (let i = 0; i < 6; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

function dateLocale(secondes: number): DateHeureZip | null {
  const d = new Date(Math.floor(secondes) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
}

/** `_date_zip` : `time.localtime(t)[:6]` bornée à la plage du format (1980-2107). */
export function dateZip(secondes: number): DateHeureZip {
  const brut = dateLocale(secondes) ?? (secondes > 0 ? DATE_MAX : DATE_MIN);
  if (comparerDates(brut, DATE_MIN) < 0) return DATE_MIN;
  return comparerDates(brut, DATE_MAX) > 0 ? DATE_MAX : brut;
}

/** `st_mtime` de Python : secondes + nanosecondes × 1e-9 en double. */
export function mtimePy(st: BigIntStats): number {
  const s = st.mtimeNs / 1_000_000_000n - (st.mtimeNs < 0n && st.mtimeNs % 1_000_000_000n !== 0n ? 1n : 0n);
  return Number(s) + Number(st.mtimeNs - s * 1_000_000_000n) * 1e-9;
}

/** `ZipInfo.from_file` strict : date avant 1980 (ValueError) ou hors de portée refusée, comme `zf.write`. */
function dateStricte(st: BigIntStats): DateHeureZip {
  const d = dateLocale(mtimePy(st));
  if (d === null) throw new ErreurPython("OverflowError", "timestamp out of range for platform time_t");
  return d;
}

/** Fichier `<préfixe>XXXXXXXX<suffixe>` créé 0600 en exclusif (`tempfile.mkstemp`). */
export function creerTemporaire(dossier: string, suffixe: string, prefixe = "tmp"): string {
  for (;;) {
    const chemin = path.join(
      dossier,
      `${prefixe}${randomBytes(6).toString("base64url").toLowerCase().replace(/-/g, "_")}${suffixe}`,
    );
    try {
      closeSync(openSync(chemin, "wx", 0o600));
      return chemin;
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") throw e;
    }
  }
}

async function* morceaux(fd: number): AsyncGenerator<Buffer> {
  for (;;) {
    const b = Buffer.allocUnsafe(1 << 20);
    const n = await new Promise<number>((ok, ko) =>
      read(fd, b, 0, b.length, null, (e, lu) => (e ? ko(e) : ok(lu))),
    );
    if (n === 0) return;
    yield b.subarray(0, n);
  }
}

/** `entry.is_dir()` d'`os.walk` : toute erreur vaut faux. */
function versDossier(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function estLien(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `str(Path(p).relative_to(racine))` pour un chemin construit sous `racine`. */
function relatif(racine: string, p: string): string {
  return p.slice(racine.length + 1);
}

/** `_snapshot_sqlite` : API de sauvegarde de SQLite d'un seul pas vers `dst` (déjà créé 0600), puis `journal_mode=DELETE`. */
export async function instantaneSqlite(src: string, dst: string): Promise<void> {
  const source = new Database(src, { timeout: 30_000 });
  try {
    await source.backup(dst, { progress: () => 0x7fffffff });
    const cible = new Database(dst);
    try {
      cible.pragma("journal_mode = DELETE");
    } finally {
      cible.close();
    }
  } finally {
    source.close();
  }
}

/** `_comptes_des_sandboxes` : dossier de sandbox → compte ; vide si la base des comptes est illisible. */
export async function comptesDesSandboxes(base: Base, journal?: Journal): Promise<Map<string, number>> {
  try {
    const lignes = await base.valeurs<[unknown, unknown]>(
      "SELECT id, username FROM users ORDER BY username ASC",
    );
    return new Map(
      lignes.map(([id, nom]) => [safeSandboxName(nom === null ? null : String(nom)), Number(id)]),
    );
  } catch (e) {
    journal?.warn({ err: e }, "[backup] comptes illisibles : aucun /work par l'agent");
    return new Map();
  }
}

/** Fichiers et dossiers temporaires des sauvegardes en cours (archive, instantané de la base), pour un arrêt par signal. */
const temporaires = new Set<string>();

/** Supprime les temporaires des sauvegardes en cours (Ctrl+C de `./elpis backup`, comme `except BaseException` en Python). */
export function nettoyerTemporaires(): void {
  for (const t of temporaires) rmSync(t, { recursive: true, force: true });
  temporaires.clear();
}

export interface OptionsSauvegarde {
  /** Dossier de construction (défaut : le dossier temporaire du système) ; l'archive y est supprimée en cas d'échec. */
  readonly dossier?: string;
  readonly journal?: Journal;
  /** Horloge en secondes (tests). */
  readonly maintenant?: () => number;
}

/** `_make_backup_zip` : construit l'archive de `scope` ; rend son chemin (0600) et son nom de téléchargement. */
export async function makeBackupZip(
  base: Base,
  scope: Portee,
  options: OptionsSauvegarde = {},
): Promise<{ chemin: string; nom: string }> {
  const chemin = creerTemporaire(options.dossier ?? tmpdir(), ".zip");
  temporaires.add(chemin);
  try {
    return await construire(base, scope, chemin, options);
  } catch (e) {
    rmSync(chemin, { force: true });
    throw e;
  } finally {
    temporaires.delete(chemin);
  }
}

async function construire(
  base: Base,
  scope: Portee,
  chemin: string,
  options: OptionsSauvegarde,
): Promise<{ chemin: string; nom: string }> {
  const maintenant = options.maintenant ?? (() => Date.now() / 1000);
  const journal = options.journal;
  const ts = Math.trunc(maintenant());
  const skipped: string[] = [];
  const travauxManques: string[] = [];
  let dbOk = false;
  const zip = await EcrivainZip.ouvrir(chemin);

  const signaler = (lieu: string, e: unknown): void => {
    skipped.push(`${lieu} — ${classeErreurPy(e)}: ${texteErreurPy(e)}`);
  };

  /** `_safe_write` : `zf.write` du fichier (lien suivi) ; fichier spécial, lien mort ou illisible consigné. */
  const ecrireFichier = async (abs: string, arcname: string): Promise<void> => {
    let st: BigIntStats | null;
    try {
      st = estFichierPy(abs) ? statSync(abs, { bigint: true }) : null;
    } catch (e) {
      if (!estErreurOs(e)) throw e;
      signaler(abs, e);
      return;
    }
    if (st === null) {
      skipped.push(`${abs} — OSError: fichier spécial ou lien mort`);
      return;
    }
    const dateHeure = dateStricte(st);
    let fd: number;
    try {
      fd = openSync(abs, "r");
    } catch (e) {
      if (!estErreurOs(e)) throw e;
      signaler(abs, avecChemin(e, abs));
      return;
    }
    try {
      await zip.ajouterFlux(
        {
          nom: arcname,
          dateHeure,
          attributsExternes: Number(st.mode & 0xffffn) * 0x10000,
          tailleAnnoncee: Number(st.size),
        },
        morceaux(fd),
      );
    } catch (e) {
      if (!estErreurOs(e)) throw e;
      signaler(abs, e);
    } finally {
      closeSync(fd);
    }
  };

  /** `_add_path` : fichier seul, ou arbre parcouru comme `os.walk` (liens vers des dossiers non descendus). */
  const ajouterChemin = async (
    p: string,
    arcroot: string,
    exclus: ReadonlySet<string> | null = null,
    sauter: readonly string[] = [],
  ): Promise<void> => {
    if (!existePy(p)) return;
    if (estFichierPy(p)) {
      await ecrireFichier(p, `${arcroot}/${path.basename(p)}`);
      return;
    }
    const pile = [p];
    while (pile.length) {
      const top = pile.pop() as string;
      let entrees;
      try {
        entrees = lireDossierBrut(top);
      } catch {
        continue;
      }
      let dossiers: string[] = [];
      const fichiers: string[] = [];
      for (const e of entrees) {
        const dossier = e.lien ? versDossier(`${top}/${e.name}`) : e.dossier;
        (dossier ? dossiers : fichiers).push(e.name);
      }
      if (sauter.length && top === p) dossiers = dossiers.filter((d) => !sauter.includes(d));
      for (const f of fichiers) {
        const abs = `${top}/${f}`;
        if (exclus && exclus.has(realpathPy(abs))) continue;
        await ecrireFichier(abs, `${arcroot}/${relatif(p, abs)}`);
      }
      for (const d of dossiers.toReversed()) if (!estLien(`${top}/${d}`)) pile.push(`${top}/${d}`);
    }
  };

  /** `_zip_copy` : fichier ouvert copié en flux, date bornée, mode conservé. */
  const copierOuvert = async (arcname: string, fd: number): Promise<void> => {
    const st = fstatSync(fd, { bigint: true });
    await zip.ajouterFlux(
      {
        nom: arcname,
        dateHeure: dateZip(mtimePy(st)),
        attributsExternes: Number(st.mode & 0xffffn) * 0x10000,
        forceZip64: Number(st.size) >= ZIP64_LIMIT,
      },
      morceaux(fd),
    );
  };

  /** `_add_sandboxes` : partie de l'hôte lue par descripteurs sans suivre de lien, /work de chaque compte par son agent. */
  const ajouterSandboxes = async (p: string, arcroot: string): Promise<void> => {
    if (!estDossierPy(p)) return;
    const travaux: string[] = [];
    try {
      for (const d of parcourirSous(p)) {
        if (!d.relDir) d.dossiers = d.dossiers.filter((x) => x !== RELAY_DIR && x !== DL_SPOOL);
        if (d.relDir && !d.relDir.includes("/")) {
          for (const x of [WORK_SUBDIR, AGENT_RUN_DIR]) {
            const i = d.dossiers.indexOf(x);
            if (i < 0) continue;
            d.dossiers.splice(i, 1);
            if (x === WORK_SUBDIR) travaux.push(d.relDir);
          }
        }
        for (const nom of d.fichiers) {
          const rel = d.relDir ? `${d.relDir}/${nom}` : nom;
          try {
            const fd = ouvrirFeuille(d.fd, nom);
            try {
              await copierOuvert(`${arcroot}/${rel}`, fd);
            } finally {
              closeSync(fd);
            }
          } catch (e) {
            if (!estErreurOs(e) && !(e instanceof ErreurCheminBac)) throw e;
            signaler(pyJoin(p, rel), e);
          }
        }
      }
    } catch (e) {
      if (!estErreurOs(e) && !(e instanceof ErreurCheminBac)) throw e;
      signaler(p, e);
    }
    const comptes = travaux.length ? await comptesDesSandboxes(base, journal) : new Map<string, number>();
    if (travaux.length && comptes.size === 0) travauxManques.push(...travaux);
    for (const nom of travaux) {
      const uid = comptes.get(nom);
      if (uid === undefined) {
        skipped.push(`${pyJoin(pyJoin(p, nom), WORK_SUBDIR)} — compte inconnu : /work non sauvegardé`);
      } else if (!(await travail.sauvegarder(uid, `${arcroot}/${nom}/${WORK_SUBDIR}`, zip, skipped))) {
        travauxManques.push(nom);
      }
    }
  };

  try {
    if (scope === "full" || scope === "db") {
      const dbFile = config.DB_PATH;
      const nomBase = path.basename(dbFile);
      if (config.DB_BACKEND !== "sqlite") {
        const snapdir = mkdtempSync(path.join(tmpdir(), "tmp"));
        temporaires.add(snapdir);
        const snap = path.join(snapdir, nomBase);
        try {
          const rep = await transferer(
            cibleActive(),
            { backend: "sqlite", path: snap },
            journal ? { journal } : {},
          );
          if (!veritePy(rep["ok"])) {
            const ecarts = Array.isArray(rep["mismatches"]) ? rep["mismatches"].map(String) : [];
            throw new Error(ecarts.join("; ") || "vérification");
          }
          await ecrireFichier(snap, `db/${nomBase}`);
          dbOk = zip.noms.includes(`db/${nomBase}`);
        } catch (e) {
          skipped.push(`base ${config.DB_BACKEND} — instantané impossible : ${texteErreurPy(e)}`);
        } finally {
          rmSync(snapdir, { recursive: true, force: true });
          temporaires.delete(snapdir);
        }
      } else if (existePy(dbFile)) {
        const snap = creerTemporaire(tmpdir(), ".db");
        for (const s of ["", ...DB_ANNEXES]) temporaires.add(snap + s);
        try {
          await instantaneSqlite(dbFile, snap);
          await ecrireFichier(snap, `db/${nomBase}`);
          dbOk = zip.noms.includes(`db/${nomBase}`);
        } catch (e) {
          if (!(e instanceof Database.SqliteError)) throw e;
          skipped.push(`${dbFile} — instantané impossible : ${e.message}`);
        } finally {
          for (const s of ["", ...DB_ANNEXES]) {
            rmSync(snap + s, { force: true });
            temporaires.delete(snap + s);
          }
        }
      }
      const userDb = pyJoin(config.PROJECT_ROOT, "user_db");
      if (existePy(userDb)) {
        const reel = realpathPy(dbFile);
        const parent = path.dirname(reel);
        const exclus = new Set<string>(["", ...DB_ANNEXES].map((s) => reel + s));
        const userDbReel = realpathPy(userDb);
        for (const n of HOST_ONLY) exclus.add(pyJoin(userDbReel, n));
        if (existePy(parent)) {
          let voisins: string[] = [];
          try {
            voisins = readdirSync(parent);
          } catch {
            voisins = [];
          }
          const nom = path.basename(reel);
          for (const v of voisins)
            if (v.startsWith(`${nom}.bak-`) || v.startsWith(`${nom}.new-`))
              exclus.add(realpathPy(pyJoin(parent, v)));
        }
        await ajouterChemin(userDb, "user_db", exclus, RUNTIME_DIRS);
      }
      const images = racineImages();
      let dansUserDb = false;
      try {
        const r = realpathPy(images);
        const u = realpathPy(userDb);
        dansUserDb = r === u || r.startsWith(`${u}/`);
      } catch {
        dansUserDb = false;
      }
      if (estDossierPy(images) && !dansUserDb) await ajouterChemin(images, "generated_images");
    }
    if (scope === "full" || scope === "sandboxes") await ajouterSandboxes(config.SANDBOX_DIR, "sandboxes");
    if (scope === "full" || scope === "mcp")
      await ajouterChemin(config.MCP_SERVERS_DIR, "mcp_custom_servers");
    if (scope === "full") {
      await ajouterChemin(config.SKINS_DIR, "user_skins");
      await ajouterChemin(config.USER_SKILLS_DIR, "user_skills");
    }
    if (skipped.length)
      await zip.ecrireTexte(
        "backup-warnings.txt",
        `Fichiers ignorés (illisibles depuis l'hôte) :\n${skipped.join("\n")}\n`,
        dateZip(maintenant()),
      );
  } catch (e) {
    await zip.fermer().catch(() => undefined);
    throw e;
  }
  await zip.fermer();

  const libelle = LIBELLES[scope] ?? scope;
  if ((scope === "full" || scope === "db") && !dbOk) return { chemin, nom: `backup_${libelle}_${ts}.zip` };
  if (travauxManques.length) {
    journal?.warn(
      `[backup] /work non sauvegardé pour ${travauxManques.length} compte(s) : ${travauxManques.slice(0, 20).join(", ")}`,
    );
    logMetric("backup_incomplete", 1, { scope, accounts: travauxManques.length });
    return { chemin, nom: `backup_${libelle}_${ts}${BACKUP_INCOMPLETE_SUFFIX}.zip` };
  }
  logMetric("backup_created", 1, { scope, skipped: skipped.length, bytes: statSync(chemin).size });
  return { chemin, nom: `backup_${libelle}_${ts}.zip` };
}
