// SPDX-License-Identifier: MIT
/** packages/fichiers/src/historique.ts — historique des fichiers modifiés pendant une session (shared_infra/sandbox/file_history.py) : mêmes fichiers, même verrou et mêmes entrées que les services Python. */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import {
  clesOrdonnees,
  comparePointsDeCode,
  ErreurPython,
  estDict,
  estErreurValeur,
  FlottantPy,
  getPy,
  itemPy,
  journalDe,
  lireTextePy,
  nomTypePy,
  poserCle,
  pyJsonDumps,
  pyJsonLoads,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { VerrouFichier, VerrouOccupe } from "@elpis/verrous";

/** Au-delà : version notée, contenu non gardé. */
export const MAX_FILE = 5 * 1024 * 1024;
/** Par fichier et par session (l'original reste). */
export const MAX_VERSIONS = 100;
export const KEEP_SESSIONS = 3;
export const USER_CAP = 300 * 1024 * 1024;
const DELAI_VERROU_MS = 5_000;

/** `APP_FILE_HISTORY_DIR` (relu à chaque appel), sinon `<racine>/user_db/file_history`. */
export function racineHistorique(): string {
  return process.env["APP_FILE_HISTORY_DIR"] || path.join(config.PROJECT_ROOT, "user_db", "file_history");
}

export function dossierCompte(uid: number): string {
  return path.join(racineHistorique(), String(Math.trunc(uid)));
}

function estErreurOs(e: unknown): boolean {
  return typeof (e as { code?: unknown } | null)?.code === "string";
}

/** `_read_json` : défaut si le fichier manque, ne se lit pas ou n'est pas du JSON. */
function lireJson(p: string, defaut: unknown): unknown {
  try {
    return pyJsonLoads(lireTextePy(p));
  } catch (e) {
    if (estErreurOs(e) || estErreurValeur(e)) return defaut;
    throw e;
  }
}

/** `_write_json` : temporaire `<nom>.<pid>.tmp` puis remplacement ; une demi-paire lève comme l'encodage UTF-8 de Python. */
function ecrireJson(p: string, donnees: unknown): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const texte = pyJsonDumps(donnees, { ensureAscii: false });
  if (!texte.isWellFormed())
    throw Object.assign(new Error("'utf-8' codec can't encode: surrogates not allowed"), {
      name: "UnicodeEncodeError",
    });
  const tmp = path.join(path.dirname(p), `${path.basename(p)}.${process.pid}.tmp`);
  writeFileSync(tmp, texte, "utf-8");
  renameSync(tmp, p);
}

const deux = (n: number): string => String(n).padStart(2, "0");

/** `time.strftime("%Y%m%d-%H%M%S")` (heure locale) + 3 octets aléatoires en hexadécimal. */
export function nouvelIdSession(maintenant: Date = new Date()): string {
  const d = maintenant;
  const date = `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}`;
  const heure = `${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`;
  return `${date}-${heure}-${randomBytes(3).toString("hex")}`;
}

/** `_user_lock` : verrou elpis.verrou.v1.1 `<uid>/.lock` ; au-delà de 5 s, on continue sans. */
async function sousVerrou<T>(uid: number, f: () => Promise<T>): Promise<T> {
  const d = dossierCompte(uid);
  await mkdir(d, { recursive: true });
  const verrou = new VerrouFichier(path.join(d, ".lock"), { delaiMs: DELAI_VERROU_MS });
  try {
    await verrou.acquerir();
  } catch (e) {
    if (!(e instanceof VerrouOccupe)) throw e;
  }
  try {
    return await f();
  } finally {
    await verrou.rendre();
  }
}

/** `_sessions` : dossiers de sessions du compte (liens suivis), triés ; `[]` si le dossier ne se lit pas. */
export async function sessions(uid: number): Promise<string[]> {
  const d = dossierCompte(uid);
  let noms: string[];
  try {
    noms = await readdir(d);
  } catch {
    return [];
  }
  const dossiers: string[] = [];
  for (const n of noms) {
    try {
      if ((await stat(path.join(d, n))).isDirectory()) dossiers.push(n);
    } catch {
      continue;
    }
  }
  return dossiers.sort(comparePointsDeCode);
}

/** `_dir_size` : `os.walk` sans suivre les liens de dossiers, tailles des fichiers (liens suivis), erreurs ignorées. */
export async function tailleDossier(p: string): Promise<number> {
  let total = 0;
  let entrees: Dirent[];
  try {
    entrees = await readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entrees) {
    const chemin = path.join(p, e.name);
    if (e.isDirectory()) {
      total += await tailleDossier(chemin);
      continue;
    }
    try {
      const st = await stat(chemin);
      if (!(e.isSymbolicLink() && st.isDirectory())) total += st.size;
    } catch {
      continue;
    }
  }
  return total;
}

/** `shutil.rmtree(ignore_errors=True)` : un lien symbolique n'est jamais supprimé. */
async function supprimerSession(uid: number, sid: string): Promise<void> {
  const p = path.join(dossierCompte(uid), sid);
  try {
    if ((await lstat(p)).isSymbolicLink()) return;
    await rm(p, { recursive: true, force: true });
  } catch {
    return;
  }
}

/** `_prune` : garde les `KEEP_SESSIONS` dernières (la courante comprise), puis retire les plus anciennes au-delà du plafond. */
export async function elaguer(uid: number, garder: string): Promise<void> {
  let anciennes = (await sessions(uid)).filter((s) => s !== garder);
  for (const s of anciennes.slice(0, Math.max(0, anciennes.length - (KEEP_SESSIONS - 1))))
    await supprimerSession(uid, s);
  anciennes = (await sessions(uid)).filter((s) => s !== garder);
  while (anciennes.length > 0 && (await tailleDossier(dossierCompte(uid))) > USER_CAP)
    await supprimerSession(uid, anciennes.shift() as string);
}

async function demarrerSansVerrou(uid: number): Promise<string> {
  const sid = nouvelIdSession();
  ecrireJson(path.join(dossierCompte(uid), "session.json"), {
    id: sid,
    started: new FlottantPy(Date.now() / 1000),
  });
  await elaguer(uid, sid);
  return sid;
}

/** Id de `session.json` s'il est un texte non vide. */
function idEnregistre(uid: number): string | null {
  const cur = lireJson(path.join(dossierCompte(uid), "session.json"), {});
  const sid = estDict(cur) ? getPy(cur, "id") : null;
  return typeof sid === "string" && sid ? sid : null;
}

/** `start_session` (au login) : nouvelle session, anciennes élaguées ; un échec est journalisé et rend un id jamais écrit. */
export async function startSession(uid: number): Promise<string> {
  try {
    return await sousVerrou(uid, () => demarrerSansVerrou(uid));
  } catch (e) {
    journalDe("file_history").error({ err: e }, `[file_history] start_session uid=${uid}`);
    return nouvelIdSession();
  }
}

/** `_current_unlocked` : à appeler verrou tenu (il n'est pas réentrant). */
async function courantSansVerrou(uid: number): Promise<string> {
  return idEnregistre(uid) ?? demarrerSansVerrou(uid);
}

/** `current_session` : session enregistrée, sinon créée sous le verrou. */
export async function currentSession(uid: number): Promise<string> {
  const sid = idEnregistre(uid);
  if (sid !== null) return sid;
  return sousVerrou(uid, () => courantSansVerrou(uid));
}

/** Sources reconnues d'une écriture ; toute autre devient `other`. */
export const SOURCES: readonly string[] = [
  "editor",
  "assistant",
  "replace",
  "upload",
  "restore",
  "git",
  "shell",
  "other",
];

/** Fichier existant trop gros pour être gardé (`TOO_BIG`). */
export const TOO_BIG: unique symbol = Symbol("TOO_BIG");
/** Fichier existant dont le contenu d'avant n'a pas pu être lu (`UNKNOWN`). */
export const UNKNOWN: unique symbol = Symbol("UNKNOWN");
/** Contenu d'une version : octets, `null` (absent ou supprimé), ou l'un des marqueurs. */
export type ContenuHistorique = Uint8Array | null | typeof TOO_BIG | typeof UNKNOWN;

/** `norm_rel` : clé POSIX sans `/` initial, `./` ni `work/` ; `..` refusé (`""`) ; `\\` reste un caractère de nom. */
export function normRel(rel: string | null | undefined): string {
  let s = stripPy(rel || "");
  while (s.startsWith("/")) s = s.slice(1);
  const parts = s.split("/").filter((p) => p !== "" && p !== ".");
  if (parts[0] === "work") parts.shift();
  if (!parts.length || parts.includes("..")) return "";
  return parts.join("/");
}

/** `sha_of` : clé de blob d'un contenu ; `null` s'il est absent, trop gros ou inconnu. */
export function shaOf(donnees: ContenuHistorique): string | null {
  if (donnees === null || typeof donnees === "symbol" || donnees.length > MAX_FILE) return null;
  return createHash("sha256").update(donnees).digest("hex");
}

const maintenant = (): FlottantPy => new FlottantPy(Date.now() / 1000);

function dossierSession(uid: number, sid: string): string {
  return path.join(dossierCompte(uid), sid);
}

/** `_store_blob` : contenu zlib (niveau 6) sous son sha256, écrit une fois (temporaire puis remplacement). */
function stockerBlob(sdir: string, donnees: Uint8Array): string {
  const sha = createHash("sha256").update(donnees).digest("hex");
  const p = path.join(sdir, "blobs", sha);
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = path.join(path.dirname(p), `${sha}.${process.pid}.tmp`);
    writeFileSync(tmp, deflateSync(donnees, { level: 6 }));
    renameSync(tmp, p);
  }
  return sha;
}

/** `_snap` : `{exists, sha, size}` (+ `unknown` ou `too_big`), blob gardé au passage. */
function cliche(sdir: string, donnees: ContenuHistorique): Dict {
  if (donnees === null) return { exists: false, sha: null, size: 0 };
  if (donnees === UNKNOWN) return { exists: true, sha: null, size: -1, unknown: true };
  if (donnees === TOO_BIG || donnees.length > MAX_FILE)
    return { exists: true, sha: null, size: -1, too_big: true };
  return { exists: true, sha: stockerBlob(sdir, donnees), size: donnees.length };
}

/** `get_blob` : contenu d'une version (sessions de la plus récente à la plus ancienne) ; `null` si le nom est forgé ou le blob illisible. */
export async function getBlob(uid: number, sha: unknown): Promise<Buffer | null> {
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/u.test(sha)) return null;
  for (const s of (await sessions(uid)).reverse()) {
    const p = path.join(dossierSession(uid, s), "blobs", sha);
    try {
      if (!(await stat(p)).isFile()) continue;
    } catch {
      continue;
    }
    try {
      return inflateSync(await readFile(p));
    } catch {
      return null;
    }
  }
  return null;
}

/** `l[-1]` d'une liste Python ; IndexError si vide, TypeError hors liste. */
function dernier(l: unknown): unknown {
  if (!Array.isArray(l)) throw new ErreurPython("TypeError", `'${nomTypePy(l)}' object is not subscriptable`);
  if (!l.length) throw new ErreurPython("IndexError", "list index out of range");
  return l[l.length - 1];
}

/** `ent["versions"]` exigé liste (append, len). */
function versionsDe(ent: unknown): unknown[] {
  const vs = itemPy(ent, "versions");
  if (!Array.isArray(vs))
    throw new ErreurPython("AttributeError", `'${nomTypePy(vs)}' object has no attribute 'append'`);
  return vs;
}

function majCliche(c: Dict, source: string): void {
  poserCle(c, "ts", maintenant());
  poserCle(c, "source", source);
}

/** `record_write` sous le verrou du compte (session courante tenue). */
function noterEcriture(
  uid: number,
  cle: string,
  avant: ContenuHistorique,
  apres: ContenuHistorique,
  src: string,
  sid: string,
): void {
  const sdir = dossierSession(uid, sid);
  const idxP = path.join(sdir, "index.json");
  const idx = lireJson(idxP, {});
  let ent = getPy(idx, cle);
  if (ent === null) {
    ent = { original: cliche(sdir, avant), versions: [], created: maintenant() };
  } else {
    const vs = versionsDe(ent);
    const orig = vs.length ? null : getPy(ent, "original");
    const prec = vs.length ? dernier(vs) : veritePy(orig) ? orig : {};
    const bsnap = cliche(sdir, avant);
    const shaAvant = getPy(bsnap, "sha");
    if (
      (shaAvant !== null && shaAvant !== getPy(prec, "sha")) ||
      (avant === null && veritePy(getPy(prec, "exists")))
    ) {
      majCliche(bsnap, "other");
      vs.push(bsnap);
    }
  }
  const ver = cliche(sdir, apres);
  const vs = versionsDe(ent);
  const der = vs.length ? dernier(vs) : null;
  const memeQueDernier = der !== null && getPy(der, "sha") === ver["sha"] && ver["sha"] !== null;
  if (!memeQueDernier) {
    majCliche(ver, src);
    vs.push(ver);
    if (vs.length > MAX_VERSIONS) {
      const garde = [vs[0], ...vs.slice(-(MAX_VERSIONS - 1))];
      poserCle(ent as Dict, "versions", garde);
    }
  }
  poserCle(idx as Dict, cle, ent);
  ecrireJson(idxP, idx);
}

/** `record_write` : `avant` sert d'original à la première écriture de la session, `apres` est le contenu écrit (`null` = suppression) ; ne lève jamais. */
export async function recordWrite(
  uid: number | null,
  rel: string,
  avant: ContenuHistorique,
  apres: ContenuHistorique,
  source = "other",
): Promise<void> {
  try {
    const cle = normRel(rel);
    if (!cle || uid === null) return;
    const src = SOURCES.includes(source) ? source : "other";
    await sousVerrou(uid, async () => {
      const sid = await courantSansVerrou(uid);
      noterEcriture(uid, cle, avant, apres, src, sid);
    });
  } catch (e) {
    journalDe("file_history").error({ err: e }, `[file_history] record_write uid=${uid} path=${rel}`);
  }
}

/** `record_move` : un fichier (ou un dossier et son contenu) renommé garde son historique sous son nouveau nom. */
export async function recordMove(uid: number, ancien: string, nouveau: string): Promise<void> {
  try {
    const a = normRel(ancien);
    const b = normRel(nouveau);
    if (!a || !b || a === b) return;
    await sousVerrou(uid, async () => {
      const sdir = dossierSession(uid, await courantSansVerrou(uid));
      const idxP = path.join(sdir, "index.json");
      const idx = lireJson(idxP, {});
      if (!estDict(idx)) throw new ErreurPython("TypeError", `'${nomTypePy(idx)}' object is not iterable`);
      let deplace = false;
      for (const k of [...clesOrdonnees(idx)]) {
        if (k !== a && !k.startsWith(a + "/")) continue;
        const nk = b + k.slice(a.length);
        if (Object.hasOwn(idx, nk)) continue;
        const v = idx[k];
        delete idx[k];
        poserCle(idx, nk, v);
        if (!estDict(v))
          throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object does not support item assignment`);
        poserCle(v, "moved_from", k);
        deplace = true;
      }
      if (deplace) ecrireJson(idxP, idx);
    });
  } catch (e) {
    journalDe("file_history").error({ err: e }, `[file_history] record_move uid=${uid}`);
  }
}

/** `-(x or 0)` d'un horodatage. */
function cleTri(ts: unknown): number {
  if (!veritePy(ts)) return 0;
  if (ts instanceof FlottantPy) return -ts.valeur;
  if (typeof ts === "number") return -ts;
  if (typeof ts === "bigint") return -Number(ts);
  if (typeof ts === "boolean") return -Number(ts);
  throw new ErreurPython("TypeError", `bad operand type for unary -: '${nomTypePy(ts)}'`);
}

/** `session_info` : session courante, début, fichiers notés (dernier écrit d'abord). */
export async function sessionInfo(uid: number): Promise<Dict> {
  const sid = await currentSession(uid);
  const meta = lireJson(path.join(dossierCompte(uid), "session.json"), {});
  const idx = lireJson(path.join(dossierSession(uid, sid), "index.json"), {});
  if (!estDict(idx))
    throw new ErreurPython("AttributeError", `'${nomTypePy(idx)}' object has no attribute 'items'`);
  const fichiers: Dict[] = [];
  for (const k of clesOrdonnees(idx)) {
    const e = idx[k];
    const vsBrut = getPy(e, "versions");
    const vs = veritePy(vsBrut) ? vsBrut : [];
    const der = veritePy(vs) ? dernier(vs) : {};
    const orig = getPy(e, "original");
    fichiers.push({
      path: k,
      versions: longueur(vs),
      original_exists: veritePy(getPy(veritePy(orig) ? orig : {}, "exists")),
      deleted: veritePy(der) && !veritePy(getPy(der, "exists", true)),
      last_ts: getPy(der, "ts"),
      last_source: getPy(der, "source"),
    });
  }
  const cles = fichiers.map((f) => cleTri(f["last_ts"]));
  const ordre = fichiers.map((_, i) => i).sort((x, y) => (cles[x] as number) - (cles[y] as number));
  return { session: sid, started: getPy(meta, "started"), files: ordre.map((i) => fichiers[i]) };
}

/** `len(x)` d'une liste, d'un texte ou d'un dict. */
function longueur(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return Array.from(v).length;
  if (estDict(v)) return Object.keys(v).length;
  throw new ErreurPython("TypeError", `object of type '${nomTypePy(v)}' has no len()`);
}

/** `file_entry` : entrée du fichier dans la session courante, augmentée de `path` ; `null` si absente. */
export async function fileEntry(uid: number, rel: string): Promise<Dict | null> {
  const cle = normRel(rel);
  if (!cle) return null;
  const idx = lireJson(path.join(dossierSession(uid, await currentSession(uid)), "index.json"), {});
  const e = getPy(idx, cle);
  if (!veritePy(e)) return null;
  if (!estDict(e))
    throw new ErreurPython("ValueError", "dictionary update sequence element #0 has wrong length");
  const copie: Dict = {};
  for (const k of clesOrdonnees(e)) poserCle(copie, k, e[k]);
  poserCle(copie, "path", cle);
  return copie;
}
