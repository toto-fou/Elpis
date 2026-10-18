// SPDX-License-Identifier: MIT
/** packages/skills/src/chemins.ts — fichiers à la pathlib et shutil de Python 3.13 (rglob, tri des chemins, resolve, relative_to, rmtree, copytree, move) pour la bibliothèque de skills. */
import { cp, lstat, readdir, rename, rm, stat } from "node:fs/promises";

import { comparePointsDeCode } from "@elpis/commun";
import { pyJoin, pyParent, pyPath, realpathPy } from "@elpis/config";

export { pyJoin, pyParent, pyPath };

/** `PurePosixPath(p)` découpé : racine (`""`, `/` ou `//`) et noms. */
function decomposer(p: string): [string, string[]] {
  const n = pyPath(p);
  const racine = n.startsWith("//") && !n.startsWith("///") ? "//" : n.startsWith("/") ? "/" : "";
  const corps = n.slice(racine.length);
  return [racine, corps === "" || corps === "." ? [] : corps.split("/")];
}

/** `PurePath.name`. */
export function nomDe(p: string): string {
  return decomposer(p)[1].at(-1) ?? "";
}

/** `PurePath.suffix` (3.13 : un point final ou initial n'ouvre pas de suffixe). */
export function suffixeDe(p: string): string {
  const nom = nomDe(p);
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(i) : "";
}

/** `PurePath.stem`. */
export function stemDe(p: string): string {
  const nom = nomDe(p);
  const i = nom.lastIndexOf(".");
  return i > 0 && i < nom.length - 1 ? nom.slice(0, i) : nom;
}

/** `p.relative_to(base).parts` lexical ; `null` (ValueError) si `base` n'est ni `p` ni un de ses parents. */
export function partiesRelatives(p: string, base: string): string[] | null {
  const [ra, pa] = decomposer(p);
  const [rb, pb] = decomposer(base);
  if (ra !== rb || pb.length > pa.length || pb.some((x, i) => x !== pa[i])) return null;
  return pa.slice(pb.length);
}

/** `PurePath.parents` : du parent direct à la racine. */
export function ancetres(p: string): string[] {
  const [racine, noms] = decomposer(p);
  const sortie: string[] = [];
  for (let i = noms.length - 1; i >= 0; i--) sortie.push(racine + noms.slice(0, i).join("/") || ".");
  return sortie;
}

/** `Path.resolve()` non strict. */
export function resoudre(p: string): string {
  return realpathPy(p);
}

/** `_is_under` : `p.resolve()` sous `base.resolve()` (ou égal) ; faux sur toute erreur. */
export function estSous(p: string, base: string): boolean {
  try {
    return partiesRelatives(realpathPy(p), realpathPy(base)) !== null;
  } catch {
    return false;
  }
}

/** `sorted()` de chemins : comparaison partie par partie, au point de code (`a/b` avant `a-b/c`). */
export function comparerChemins(a: string, b: string): number {
  const pa = pyPath(a).split("/");
  const pb = pyPath(b).split("/");
  for (let i = 0; i < pa.length && i < pb.length; i++) {
    const c = comparePointsDeCode(pa[i] ?? "", pb[i] ?? "");
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

/** `Path.rglob(motif)` de 3.13 : toute entrée de l'arbre (racine exclue) dont le nom convient, sans descendre dans un lien. */
export async function rglob(racine: string, convient: (nom: string) => boolean): Promise<string[]> {
  const sortie: string[] = [];
  const pile = [pyPath(racine)];
  for (let dossier = pile.pop(); dossier !== undefined; dossier = pile.pop()) {
    let entrees;
    try {
      entrees = await readdir(dossier, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entrees) {
      const chemin = pyJoin(dossier, e.name);
      if (convient(e.name)) sortie.push(chemin);
      if (e.isDirectory()) pile.push(chemin);
    }
  }
  return sortie;
}

/** `sorted(Path(racine).rglob(motif))`. */
export async function rglobTrie(racine: string, convient: (nom: string) => boolean): Promise<string[]> {
  return (await rglob(racine, convient)).sort(comparerChemins);
}

/** `Path.is_dir()` (lien suivi, faux sur erreur). */
export async function estDossier(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** `Path.is_file()`. */
export async function estFichier(p: string): Promise<boolean> {
  return stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** `Path.exists()`. */
export async function existe(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** `OSError` de Python : erreur système de Node (`ENOENT`, `EACCES`…), pas une erreur interne `ERR_*`. */
export function estErreurOs(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && !code.startsWith("ERR_");
}

/** Erreur d'OS avec son code, comme une `OSError` de Python. */
function erreurOs(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** `shutil.rmtree` : refuse un lien ou un non-dossier ; `ignorer` = `ignore_errors=True`. */
export async function rmtree(p: string, ignorer = false): Promise<void> {
  try {
    const s = await lstat(p);
    if (s.isSymbolicLink()) throw erreurOs("ELOOP", "Cannot call rmtree on a symbolic link");
    if (!s.isDirectory()) throw erreurOs("ENOTDIR", `Not a directory: '${p}'`);
    await rm(p, { recursive: true });
  } catch (e) {
    if (!ignorer) throw e;
  }
}

/** `shutil.copytree(src, dst)` : destination absente exigée, liens suivis, dates et modes gardés. */
export async function copytree(src: string, dst: string): Promise<void> {
  if (
    await lstat(dst).then(
      () => true,
      () => false,
    )
  )
    throw erreurOs("EEXIST", `File exists: '${dst}'`);
  await cp(src, dst, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
}

/** `shutil.move(src, dst)` vers une destination absente : renommage, copie puis suppression entre volumes. */
export async function deplacer(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "EXDEV") throw e;
    await cp(src, dst, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    await rm(src, { recursive: true });
  }
}

/** `PurePath.parent`. */
export function parentDe(p: string): string {
  return pyParent(p);
}
