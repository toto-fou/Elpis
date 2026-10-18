// SPDX-License-Identifier: MIT
/** packages/commun/src/chemins.ts — chemins à la Python : `posixpath.normpath`, `PurePosixPath`, `os.path.realpath` non strict et `fnmatch.fnmatch` POSIX. */
import { lstatSync, readlinkSync } from "node:fs";

import { ErreurPython } from "./python";

/** `posixpath.normpath`. */
export function normpathPy(p: string): string {
  if (!p) return ".";
  const initiales = p.startsWith("/") ? (p.startsWith("//") && !p.startsWith("///") ? 2 : 1) : 0;
  const sortie: string[] = [];
  for (const c of p.split("/")) {
    if (c === "" || c === ".") continue;
    if (c !== ".." || (!initiales && !sortie.length) || (sortie.length && sortie[sortie.length - 1] === ".."))
      sortie.push(c);
    else if (sortie.length) sortie.pop();
  }
  return "/".repeat(initiales) + sortie.join("/") || ".";
}

type Jeton = "etoile" | ((point: number) => boolean);

const TOUT = (): boolean => true;

const JAMAIS = (): boolean => false;

function pointDe(c: string | undefined): number {
  return c?.codePointAt(0) ?? -1;
}

/** Classe `[…]` produite par `fnmatch.translate`, lue comme `re` la lit : `^` en tête, échappements, plages `a-b` (jamais vides ni ouvertes après translate). */
function classe(corps: string): (point: number) => boolean {
  const src = Array.from(corps);
  let p = 0;
  const negation = src[0] === "^";
  if (negation) p++;
  const lireUn = (): number => {
    const c = src[p++];
    return c === "\\" ? pointDe(src[p++]) : pointDe(c);
  };
  const plages: [number, number][] = [];
  while (p < src.length) {
    const lo = lireUn();
    if (src[p] !== "-") {
      plages.push([lo, lo]);
      continue;
    }
    p++;
    const hi = lireUn();
    if (hi < lo) throw new Error("bad character range");
    plages.push([lo, hi]);
  }
  return (point) => plages.some(([a, b]) => point >= a && point <= b) !== negation;
}

function indexDe(pat: readonly string[], cherche: string, debut: number, fin: number): number {
  for (let k = Math.max(0, debut); k < fin; k++) if (pat[k] === cherche) return k;
  return -1;
}

/** `fnmatch._translate` : `*` (compressés), `?`, classes (plages vides retirées, `[z-a!]` = tout caractère), littéraux. */
function traduireGlob(motif: string): Jeton[] {
  const pat = Array.from(motif);
  const n = pat.length;
  const res: Jeton[] = [];
  let i = 0;
  while (i < n) {
    const c = pat[i] ?? "";
    i++;
    if (c === "*") {
      if (res.at(-1) !== "etoile") res.push("etoile");
    } else if (c === "?") res.push(TOUT);
    else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j++;
      if (j < n && pat[j] === "]") j++;
      while (j < n && pat[j] !== "]") j++;
      if (j >= n) {
        res.push((point) => point === 0x5b);
        continue;
      }
      let stuff: string;
      if (!pat.slice(i, j).includes("-")) stuff = pat.slice(i, j).join("").replaceAll("\\", "\\\\");
      else {
        const chunks: string[][] = [];
        let k = pat[i] === "!" ? i + 2 : i + 1;
        for (;;) {
          k = indexDe(pat, "-", k, j);
          if (k < 0) break;
          chunks.push(pat.slice(i, k));
          i = k + 1;
          k = k + 3;
        }
        const chunk = pat.slice(i, j);
        if (chunk.length) chunks.push(chunk);
        else chunks.at(-1)?.push("-");
        for (let m = chunks.length - 1; m > 0; m--) {
          const gauche = chunks[m - 1] ?? [];
          const droite = chunks[m] ?? [];
          if (pointDe(gauche.at(-1)) > pointDe(droite[0])) {
            chunks[m - 1] = [...gauche.slice(0, -1), ...droite.slice(1)];
            chunks.splice(m, 1);
          }
        }
        stuff = chunks.map((s) => s.join("").replaceAll("\\", "\\\\").replaceAll("-", "\\-")).join("-");
      }
      stuff = stuff.replace(/([&~|])/g, "\\$1");
      i = j + 1;
      if (!stuff) res.push(JAMAIS);
      else if (stuff === "!") res.push(TOUT);
      else {
        if (stuff.startsWith("!")) stuff = `^${stuff.slice(1)}`;
        else if (stuff.startsWith("^") || stuff.startsWith("[")) stuff = `\\${stuff}`;
        res.push(classe(stuff));
      }
    } else {
      const attendu = pointDe(c);
      res.push((point) => point === attendu);
    }
  }
  return res;
}

/** `fnmatch.fnmatch` POSIX (sans normcase) : même verdict que la regex atomique de Python, sans retour arrière exponentiel. */
export function fnmatchPy(nom: string, motif: string): boolean {
  const jetons = traduireGlob(motif);
  const s = Array.from(nom, (c) => pointDe(c));
  let i = 0;
  let p = 0;
  let etoileP = -1;
  let etoileS = 0;
  while (i < s.length) {
    const j = jetons[p];
    if (j !== undefined && j !== "etoile" && j(s[i] ?? -1)) {
      i++;
      p++;
    } else if (j === "etoile") {
      etoileP = p;
      etoileS = i;
      p++;
    } else if (etoileP >= 0) {
      p = etoileP + 1;
      etoileS++;
      i = etoileS;
    } else return false;
  }
  while (jetons[p] === "etoile") p++;
  return p === jetons.length;
}

function racinePosix(p: string): string {
  if (p.startsWith("//") && !p.startsWith("///")) return "//";
  return p.startsWith("/") ? "/" : "";
}

/** `str(PurePosixPath(p))` : barres doublées et `.` retirés, `..` gardé, `//` initial conservé. */
export function pyPath(p: string): string {
  const corps = p
    .split("/")
    .filter((partie) => partie !== "" && partie !== ".")
    .join("/");
  return racinePosix(p) + corps || ".";
}

/** `PurePosixPath(p).parent`, lexical (un `..` final est retiré comme un nom). */
export function pyParent(p: string): string {
  const chemin = pyPath(p);
  const racine = racinePosix(chemin);
  const corps = chemin.slice(racine.length);
  if (corps === "" || corps === ".") return chemin;
  const i = corps.lastIndexOf("/");
  return i < 0 ? racine || "." : racine + corps.slice(0, i);
}

/** `PurePosixPath(base) / suite`. */
export function pyJoin(base: string, suite: string): string {
  if (suite.startsWith("/")) return pyPath(suite);
  return pyPath(base.endsWith("/") ? base + suite : `${base}/${suite}`);
}

/** `UnicodeEncodeError` de l'`lstat` Python sur un chemin à demi-paire isolée (position en points de code). */
function messageSurrogate(p: string): string {
  let position = 0;
  for (const c of p) {
    const code = c.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff)
      return `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${position}: surrogates not allowed`;
    position++;
  }
  return "surrogates not allowed";
}

/** `os.path.realpath(p)` non strict (Python 3.13) : liens suivis tant qu'ils existent, `..` physique. */
export function realpathPy(p: string): string {
  if (p.includes("\0")) throw new ErreurPython("ValueError", "lstat: embedded null character in path");
  if (!p.isWellFormed()) throw new ErreurPython("ValueError", messageSurrogate(p));
  const reste: (string | null)[] = p.split("/").reverse();
  let aTraiter = reste.length;
  let chemin = p.startsWith("/") ? "/" : process.cwd();
  const vus = new Map<string, string | null>();
  while (aTraiter > 0) {
    const nom = reste.pop();
    if (nom === null) {
      vus.set(String(reste.pop()), chemin);
      continue;
    }
    aTraiter--;
    if (nom === undefined || nom === "" || nom === ".") continue;
    if (nom === "..") {
      chemin = chemin.slice(0, chemin.lastIndexOf("/")) || "/";
      continue;
    }
    const nouveau = chemin === "/" ? `/${nom}` : `${chemin}/${nom}`;
    let cible: string;
    try {
      if (!lstatSync(nouveau).isSymbolicLink()) {
        chemin = nouveau;
        continue;
      }
      if (vus.has(nouveau)) {
        chemin = vus.get(nouveau) ?? nouveau;
        continue;
      }
      cible = readlinkSync(nouveau);
    } catch {
      chemin = nouveau;
      continue;
    }
    if (cible.startsWith("/")) chemin = "/";
    vus.set(nouveau, null);
    reste.push(nouveau, null);
    const parties = cible.split("/").reverse();
    reste.push(...parties);
    aTraiter += parties.length;
  }
  return chemin;
}
