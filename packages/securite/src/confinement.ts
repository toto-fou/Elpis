// SPDX-License-Identifier: MIT
/** packages/securite/src/confinement.ts — chemins d'un bac à sable (sandbox/paths.py) : forme conteneur et chemins relatifs sur le texte seul ; parcours et écriture sous une racine sans jamais suivre de lien, par descripteurs et /proc/self/fd. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import { pyPath, realpathPy, reprPy, stripPy } from "@elpis/commun";

/** `O_PATH` de Linux : saisit une entrée sans l'ouvrir (droit de traverser suffisant). */
export const O_PATH = 0o10000000;
/** `O_CLOEXEC` de Linux (absent de `fs.constants`, libuv le pose déjà). */
const O_CLOEXEC = 0o2000000;
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_EXCL } = constants;

/** `SandboxPathError` : chemin impossible à résoudre sûrement sous la racine. */
export class ErreurCheminBac extends Error {
  override name = "SandboxPathError";
}

function viaFd(fd: number, nom = ""): string {
  return nom ? `/proc/self/fd/${fd}/${nom}` : `/proc/self/fd/${fd}`;
}

/** `_rel_parts` : composants d'un chemin relatif, sans absolu ni `..` ni NUL. */
export function relParts(rel: string): string[] {
  if (rel.includes("\0")) throw new ErreurCheminBac("null byte in path");
  if (rel.startsWith("/")) throw new ErreurCheminBac(`absolute path refused: ${reprPy(rel)}`);
  const parts = rel.split("/").filter((x) => x !== "" && x !== ".");
  if (parts.includes("..")) throw new ErreurCheminBac(`'..' component refused: ${reprPy(rel)}`);
  return parts;
}

export interface EntreeBrute {
  readonly name: string;
  readonly dossier: boolean;
  readonly lien: boolean;
}

/** Entrées dans l'ordre du système de fichiers comme `os.scandir` (`readdirSync` les trie) ; type inconnu relu par `lstat`. */
export function lireDossierBrut(chemin: string): EntreeBrute[] {
  const d = opendirSync(chemin);
  const out: EntreeBrute[] = [];
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      const connu =
        e.isFile() ||
        e.isDirectory() ||
        e.isSymbolicLink() ||
        e.isFIFO() ||
        e.isSocket() ||
        e.isBlockDevice() ||
        e.isCharacterDevice();
      let st: { isDirectory(): boolean; isSymbolicLink(): boolean } = e;
      if (!connu) {
        try {
          st = lstatSync(`${chemin}/${e.name}`);
        } catch {
          st = e;
        }
      }
      out.push({ name: e.name, dossier: st.isDirectory(), lien: st.isSymbolicLink() });
    }
  } finally {
    d.closeSync();
  }
  return out;
}

function tenter(f: () => void): void {
  try {
    f();
  } catch {
    return;
  }
}

function code(e: unknown): string {
  return String((e as { code?: unknown }).code ?? "");
}

/** `open_dir_beneath` : dossier `base/rel` ouvert composant par composant sans suivre de lien (`O_PATH`) ; `creer` fait les dossiers manquants ; `lisible` ouvre le dernier en lecture (listage). */
export function ouvrirDossierSous(
  base: string,
  rel = "",
  options: { creer?: boolean; modeDossier?: number; lisible?: boolean } = {},
): number {
  const parts = relParts(rel);
  const traverser = O_PATH | O_DIRECTORY | O_CLOEXEC;
  const dernier = (options.lisible ? O_RDONLY : O_PATH) | O_DIRECTORY | O_CLOEXEC;
  let fd = openSync(realpathSync(base), parts.length ? traverser : dernier);
  try {
    for (const [i, nom] of parts.entries()) {
      const drapeaux = (i === parts.length - 1 ? dernier : traverser) | O_NOFOLLOW;
      let suivant: number;
      try {
        suivant = openSync(viaFd(fd, nom), drapeaux);
      } catch (e) {
        if (code(e) !== "ENOENT" || !options.creer) throw e;
        let cree = false;
        try {
          mkdirSync(viaFd(fd, nom), 0o777);
          cree = true;
        } catch (x) {
          if (code(x) !== "EEXIST") throw x;
        }
        suivant = openSync(viaFd(fd, nom), drapeaux);
        const mode = options.modeDossier;
        const cible = viaFd(suivant);
        if (cree && mode !== undefined) tenter(() => chmodSync(cible, mode));
      }
      closeSync(fd);
      fd = suivant;
    }
  } catch (e) {
    closeSync(fd);
    if (["ELOOP", "ENOTDIR", "EMLINK"].includes(code(e)))
      throw new ErreurCheminBac(`symlink or non-directory on the path: ${reprPy(parts.join("/"))}`);
    throw e;
  }
  return fd;
}

/** `open_path_at` : descripteur `O_PATH` de l'entrée elle-même (un lien est saisi, jamais suivi). */
export function saisirEntree(dossierFd: number, nom: string): number {
  return openSync(viaFd(dossierFd, nom), O_PATH | O_NOFOLLOW | O_CLOEXEC);
}

/** `reopen` : rouvre l'inode d'un descripteur `O_PATH` par /proc/self/fd. */
export function rouvrir(pfd: number, drapeaux: number = O_RDONLY): number {
  return openSync(viaFd(pfd), drapeaux | O_CLOEXEC);
}

/** `leaf_mode` : `st_mode` de l'entrée, lien non suivi ; 0 si elle a disparu ou est inaccessible. */
export function modeEntree(dossierFd: number, nom: string): number {
  try {
    return lstatSync(viaFd(dossierFd, nom)).mode;
  } catch {
    return 0;
  }
}

/** `open_leaf` : descripteur en lecture d'un fichier régulier (ou d'un dossier si `dossierPermis`) ; lien, FIFO, socket ou périphérique refusés sans être ouverts. */
export function ouvrirFeuille(
  dossierFd: number,
  nom: string,
  options: { dossierPermis?: boolean } = {},
): number {
  const p = saisirEntree(dossierFd, nom);
  try {
    const st = fstatSync(p);
    if (st.isFile()) return rouvrir(p);
    if (st.isDirectory() && options.dossierPermis) return rouvrir(p, O_RDONLY | O_DIRECTORY);
    if (st.isDirectory())
      throw Object.assign(new Error(`[Errno 21] Is a directory: ${reprPy(nom)}`), {
        code: "EISDIR",
        errno: -21,
        path: nom,
      });
    throw new ErreurCheminBac(`symlink or special file refused: ${reprPy(nom)}`);
  } finally {
    closeSync(p);
  }
}

export interface DossierParcouru {
  readonly relDir: string;
  /** Sous-dossiers réels (jamais un lien), à élaguer sur place avant la descente. */
  dossiers: string[];
  /** Fichiers, liens et fichiers spéciaux : à ouvrir par `ouvrirFeuille`. */
  readonly fichiers: string[];
  readonly fd: number;
}

/** `walk_beneath` (os.fwalk sans suivre de lien) : de haut en bas ; lien vers un dossier écarté, sous-dossier illisible ou remplacé par un lien ignoré. */
export function* parcourirSous(base: string, rel = ""): Generator<DossierParcouru> {
  const racine = relParts(rel).join("/");
  const fd = ouvrirDossierSous(base, racine);
  try {
    yield* parcourirFd(fd, racine, true);
  } finally {
    closeSync(fd);
  }
}

function* parcourirFd(fd: number, relDir: string, racine = false): Generator<DossierParcouru> {
  let entrees;
  try {
    entrees = lireDossierBrut(viaFd(fd));
  } catch (e) {
    if (racine) throw e;
    return;
  }
  const dossiers: string[] = [];
  const fichiers: string[] = [];
  for (const e of entrees) {
    if (e.dossier) dossiers.push(e.name);
    else if (!e.lien) fichiers.push(e.name);
    else {
      let versDossier: boolean;
      try {
        versDossier = statSync(viaFd(fd, e.name)).isDirectory();
      } catch {
        versDossier = false;
      }
      if (!versDossier) fichiers.push(e.name);
    }
  }
  const d: DossierParcouru = { relDir, dossiers, fichiers, fd };
  yield d;
  for (const nom of d.dossiers) {
    let sous: number;
    try {
      sous = openSync(viaFd(fd, nom), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    } catch {
      continue;
    }
    try {
      yield* parcourirFd(sous, relDir ? `${relDir}/${nom}` : nom);
    } finally {
      closeSync(sous);
    }
  }
}

/** L'erreur d'une opération faite par /proc/self/fd porte le chemin réel, comme dans le message de Python. */
function avecChemin(e: unknown, chemin: string): unknown {
  if (e !== null && typeof e === "object" && typeof (e as { path?: unknown }).path === "string")
    (e as { path: string }).path = chemin;
  return e;
}

/** Entrée de `dossier` par /proc/self/fd, nom en octets (un nom hors UTF-8 se supprime tel quel). */
function entreeFd(fd: number, nom: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), nom]);
}

async function viderDossierFd(fd: number, chemin: string): Promise<void> {
  let entrees;
  try {
    entrees = await readdir(viaFd(fd), { withFileTypes: true, encoding: "buffer" });
  } catch (e) {
    throw avecChemin(e, chemin);
  }
  for (const e of entrees) {
    const nom = `${chemin}/${e.name.toString()}`;
    let sous: FileHandle | null = null;
    if (e.isDirectory()) {
      try {
        sous = await open(entreeFd(fd, e.name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      } catch (err) {
        if (code(err) === "ENOENT") continue;
        if (code(err) !== "ELOOP" && code(err) !== "ENOTDIR") throw avecChemin(err, nom);
      }
    }
    if (sous !== null) {
      try {
        await viderDossierFd(sous.fd, nom);
      } finally {
        await sous.close();
      }
    }
    try {
      await (sous === null ? unlink : rmdir)(entreeFd(fd, e.name));
    } catch (err) {
      if (code(err) !== "ENOENT") throw avecChemin(err, nom);
    }
  }
}

/** `shutil.rmtree` par descripteurs (`_rmtree_safe_fd`) : chaque dossier est ouvert sans suivre de lien et vidé par /proc/self/fd, une entrée échangée contre un lien en cours de route n'est jamais suivie. */
export async function supprimerArbreSous(chemin: string): Promise<void> {
  let h: FileHandle;
  try {
    h = await open(chemin, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  } catch (e) {
    throw avecChemin(e, chemin);
  }
  try {
    await viderDossierFd(h.fd, chemin);
  } finally {
    await h.close();
  }
  await rmdir(chemin);
}

/** Entrée retirée sans suivre de lien : dossier vidé par descripteurs, lien ou fichier à sa place supprimé lui-même ; faux si elle n'existe pas. */
export async function supprimerEntreeSous(chemin: string): Promise<boolean> {
  try {
    await supprimerArbreSous(chemin);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if ((code !== "ELOOP" && code !== "ENOTDIR") || (await lstat(chemin)).isDirectory()) throw e;
    await unlink(chemin);
    return true;
  }
}

/** `_short_leaf` : préfixe d'au plus `max` octets UTF-8 sans couper un caractère. */
export function feuilleCourte(nom: string, max = 120): string {
  let out = "";
  let n = 0;
  for (const c of nom) {
    const l = Buffer.byteLength(c, "utf8");
    if (n + l > max) break;
    out += c;
    n += l;
  }
  return out;
}

export interface OptionsEcritureSous {
  modeFichier?: number;
  modeDefaut?: number;
  modeDossier?: number;
  creerParents?: boolean;
  mtimeNs?: bigint;
}

/** `write_beneath` : temporaire exclusif dans le dossier final puis renommage, dossiers intermédiaires compris, aucun lien suivi ; rend les octets écrits. */
export function ecrireSous(
  base: string,
  rel: string,
  donnees: Uint8Array,
  options: OptionsEcritureSous = {},
): number {
  const parts = relParts(rel);
  if (!parts.length) throw new ErreurCheminBac("a file path is required, not the root");
  const feuille = parts.at(-1) as string;
  const dfd = ouvrirDossierSous(base, parts.slice(0, -1).join("/"), {
    creer: options.creerParents ?? true,
    ...(options.modeDossier === undefined ? {} : { modeDossier: options.modeDossier }),
  });
  try {
    let mode = options.modeFichier;
    if (mode === undefined) {
      try {
        const p = openSync(viaFd(dfd, feuille), O_PATH | O_NOFOLLOW | O_CLOEXEC);
        try {
          const st = fstatSync(p);
          if (st.isFile()) mode = st.mode & 0o777;
        } finally {
          closeSync(p);
        }
      } catch (e) {
        if (code(e) !== "ENOENT") throw e;
      }
    }
    mode ??= options.modeDefaut ?? 0o644;
    const tmp = `.${feuilleCourte(feuille)}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(viaFd(dfd, tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600);
    try {
      try {
        let fait = 0;
        while (fait < donnees.length) fait += writeSync(fd, donnees, fait, donnees.length - fait);
        fchmodSync(fd, mode & 0o777);
        if (options.mtimeNs !== undefined) {
          const s = Number(options.mtimeNs) / 1e9;
          futimesSync(fd, s, s);
        }
        tenter(() => fsyncSync(fd));
      } finally {
        closeSync(fd);
      }
      renameSync(viaFd(dfd, tmp), viaFd(dfd, feuille));
    } catch (e) {
      tenter(() => unlinkSync(viaFd(dfd, tmp)));
      throw e;
    }
    return donnees.length;
  } finally {
    closeSync(dfd);
  }
}

export const CONTAINER_ROOT = "/work";

const WORK_PREFIXES = ["/work/", "./work/", "work/"] as const;
const WORK_ROOTS: ReadonlySet<string> = new Set(["/work", "./work", "work"]);

/** `strip_work_prefix` : vue conteneur (`/work`, `work`, `./work`, suivis ou non d'un chemin) ramenée à un chemin relatif ; le reste, blancs retirés. */
export function stripWorkPrefix(chemin: string | null | undefined): string {
  if (!chemin) return "";
  const p = stripPy(chemin);
  if (WORK_ROOTS.has(p)) return "";
  for (const prefixe of WORK_PREFIXES) if (p.startsWith(prefixe)) return p.slice(prefixe.length);
  return p;
}

/** `to_container` : `""`/`"."` → `/work`, `src/x` → `/work/src/x`. */
export function toContainer(rel: string | null | undefined): string {
  const r = stripPy(rel || "").replace(/^\/+|\/+$/gu, "");
  return r === "" || r === "." ? CONTAINER_ROOT : `${CONTAINER_ROOT}/${r}`;
}

/** `PurePath.relative_to` lexical de deux chemins absolus normalisés ; `null` hors de la base. */
function relatifA(cible: string, base: string): string | null {
  if (cible === base) return ".";
  if (base === "/") return cible.startsWith("/") && !cible.startsWith("//") ? cible.slice(1) : null;
  return cible.startsWith(base + "/") ? cible.slice(base.length + 1) : null;
}

/** `rel_under` : cible relative gardée (normalisée) ; absolue, rendue relative à `base` puis à `base` résolue, sans lire la cible. */
export function relUnder(base: string, cible: string): string {
  const t = pyPath(cible);
  if (!t.startsWith("/")) return t;
  const direct = relatifA(t, pyPath(base));
  if (direct !== null) return direct;
  const viaResolu = relatifA(t, realpathPy(base));
  if (viaResolu !== null) return viaResolu;
  throw new ErreurCheminBac(`path outside the sandbox root: ${reprPy(cible)}`);
}

export interface OptionsLexical {
  readonly allowRoot?: boolean;
  /** Faux pour l'éditeur : `~` y est un nom. */
  readonly tilde?: boolean;
}

/** `lexical_rel` : préfixe /work retiré, `.` et `..` résolus sur le texte, `~` = la racine ; sortie, NUL ou racine refusée : `SandboxPathError`. */
export function lexicalRel(
  base: string,
  cheminDonne: string | null | undefined,
  o: OptionsLexical = {},
): string {
  const brut = cheminDonne ?? "";
  if (brut.includes("\0")) throw new ErreurCheminBac("null byte in path");
  let s = stripWorkPrefix(brut);
  if ((o.tilde ?? true) && (s === "~" || s.startsWith("~/"))) s = s.slice(1).replace(/^\/+/u, "");
  if (s.startsWith("/")) {
    const b = [pyPath(base), realpathPy(base)].find((x) => s === x || s.startsWith(x + "/"));
    if (b === undefined) throw new ErreurCheminBac(`path outside the sandbox root: ${reprPy(brut)}`);
    s = s.slice(b.length);
  }
  const parties: string[] = [];
  for (const c of s.split("/")) {
    if (c === "" || c === ".") continue;
    if (c !== "..") parties.push(c);
    else if (parties.length) parties.pop();
    else throw new ErreurCheminBac(`path outside the sandbox root: ${reprPy(brut)}`);
  }
  if (!parties.length && !(o.allowRoot ?? true))
    throw new ErreurCheminBac("operation requires a path inside the sandbox, not its root");
  return parties.join("/");
}
