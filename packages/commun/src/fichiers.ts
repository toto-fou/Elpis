// SPDX-License-Identifier: MIT
/** packages/commun/src/fichiers.ts — fichiers et erreurs d'E/S à la Python 3.13 : existence, texte UTF-8 strict, messages d'OSError et de shutil.rmtree, st_mtime. */
import { readFileSync, statSync } from "node:fs";

import { ErreurJsonPy, ErreurLecturePy } from "./json-lecture";
import { ErreurPython } from "./python";

const code = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? "");

const RAISONS_OS: Readonly<Record<string, [number, string]>> = {
  EACCES: [13, "Permission denied"],
  EISDIR: [21, "Is a directory"],
  ELOOP: [40, "Too many levels of symbolic links"],
  EIO: [5, "Input/output error"],
  ENAMETOOLONG: [36, "File name too long"],
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  ENOTDIR: [20, "Not a directory"],
  EEXIST: [17, "File exists"],
  ENOTEMPTY: [39, "Directory not empty"],
  EBUSY: [16, "Device or resource busy"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
};

/** `str(OSError)` de Python pour un fichier : « [Errno 13] Permission denied: '/chemin' ». */
export function messageErreurOs(e: unknown, chemin: string): string {
  const code = String((e as { code?: unknown }).code ?? "");
  const [numero, texte] = RAISONS_OS[code] ?? [Math.abs(Number((e as { errno?: unknown }).errno) || 0), code];
  return `[Errno ${numero}] ${texte}: '${chemin}'`;
}

/** Longueur attendue d'une séquence UTF-8 et bornes de son deuxième octet, comme le décodeur strict de CPython. */
function sequenceUtf8(premier: number): [number, number, number] | null {
  if (premier >= 0xc2 && premier <= 0xdf) return [2, 0x80, 0xbf];
  if (premier === 0xe0) return [3, 0xa0, 0xbf];
  if (premier === 0xed) return [3, 0x80, 0x9f];
  if (premier >= 0xe1 && premier <= 0xef) return [3, 0x80, 0xbf];
  if (premier === 0xf0) return [4, 0x90, 0xbf];
  if (premier >= 0xf1 && premier <= 0xf3) return [4, 0x80, 0xbf];
  if (premier === 0xf4) return [4, 0x80, 0x8f];
  return null;
}

/** `octets.decode("utf-8", errors="ignore")` : chaque sous-partie maximale invalide est retirée, comme le décodeur de CPython. */
export function decoderUtf8IgnorePy(octets: Buffer): string {
  const morceaux: string[] = [];
  let debut = 0;
  let i = 0;
  while (i < octets.length) {
    const b = octets[i] ?? 0;
    if (b < 0x80) {
      i++;
      continue;
    }
    const seq = sequenceUtf8(b);
    let k = 1;
    while (seq && k < seq[0] && i + k < octets.length) {
      const c = octets[i + k] ?? 0;
      if (k === 1 ? c < seq[1] || c > seq[2] : c < 0x80 || c > 0xbf) break;
      k++;
    }
    if (seq && k === seq[0]) {
      i += k;
      continue;
    }
    morceaux.push(octets.subarray(debut, i).toString("utf8"));
    i += k;
    debut = i;
  }
  morceaux.push(octets.subarray(debut).toString("utf8"));
  return morceaux.join("");
}

/** `octets.decode("utf-8")` strict ; l'erreur porte le message de `UnicodeDecodeError`. */
export function decoderUtf8Py(octets: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(octets);
  } catch {
    for (let i = 0; i < octets.length; i++) {
      const b = octets[i] ?? 0;
      if (b < 0x80) continue;
      const seq = sequenceUtf8(b);
      const debut = `'utf-8' codec can't decode`;
      if (!seq)
        throw new Error(
          `${debut} byte 0x${b.toString(16).padStart(2, "0")} in position ${i}: invalid start byte`,
        );
      let k = 1;
      while (k < seq[0] && i + k < octets.length) {
        const c = octets[i + k] ?? 0;
        if (k === 1 ? c < seq[1] || c > seq[2] : c < 0x80 || c > 0xbf) break;
        k++;
      }
      if (k === seq[0]) {
        i += k - 1;
        continue;
      }
      const fin = i + k >= octets.length ? "unexpected end of data" : "invalid continuation byte";
      throw new Error(
        k === 1
          ? `${debut} byte 0x${b.toString(16).padStart(2, "0")} in position ${i}: ${fin}`
          : `${debut} bytes in position ${i}-${i + k - 1}: ${fin}`,
      );
    }
    throw new Error("'utf-8' codec can't decode");
  }
}

/** `UnicodeDecodeError` : une `ValueError` que certains `except` de Python distinguent. */
export class ErreurDecodage extends ErreurPython {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** `octets.decode("utf-8")` strict, avec le message de CPython. */
export function decoderUtf8(octets: Buffer): string {
  try {
    return decoderUtf8Py(octets);
  } catch (e) {
    throw new ErreurDecodage((e as Error).message);
  }
}

/** `Path.read_text(encoding="utf-8")` : UTF-8 strict, fins de ligne `\r\n` et `\r` ramenées à `\n`. */
export function lireTextePy(chemin: string): string {
  return decoderUtf8(readFileSync(chemin)).replace(/\r\n?/gu, "\n");
}

/** `ValueError` de Python (JSON invalide, UTF-8 invalide, entier trop long) ; `RecursionError` n'en est pas une. */
export function estErreurValeur(e: unknown): boolean {
  return (
    e instanceof ErreurJsonPy ||
    (e instanceof ErreurLecturePy && e.nature !== "RecursionError") ||
    (e instanceof ErreurPython && e.type === "ValueError")
  );
}

const ERRNO_IGNORES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EBADF", "ELOOP"]);

/** `Path.stat()` de Python 3.13 vu par `is_file`/`is_dir` : `null` si absent, lien mort ou non encodable ; EACCES, EIO… lèvent. */
function statPy(p: string): ReturnType<typeof statSync> | null {
  if (!p.isWellFormed() || p.includes("\0")) return null;
  try {
    return statSync(p);
  } catch (e) {
    if (ERRNO_IGNORES.has(String((e as { code?: unknown }).code))) return null;
    throw e;
  }
}

/** `Path.exists()` de Python 3.13. */
export function existePy(p: string): boolean {
  return statPy(p) !== null;
}

export function estFichierPy(p: string): boolean {
  return statPy(p)?.isFile() ?? false;
}

export function estDossierPy(p: string): boolean {
  return statPy(p)?.isDirectory() ?? false;
}

/** `st_mtime` de CPython (`sec + nsec * 1e-9` en double) depuis `mtimeNs`. */
export function stMtimePy(ns: bigint): number {
  let sec = ns / 1_000_000_000n;
  let nsec = ns % 1_000_000_000n;
  if (nsec < 0n) [sec, nsec] = [sec - 1n, nsec + 1_000_000_000n];
  return Number(sec) + Number(nsec) * 1e-9;
}

/** `str(OSError)` de Python, chemin en cause compris. */
export function messageErreurPy(e: unknown, chemin: string): string {
  const c = code(e);
  const enCause = (e as { path?: unknown } | null)?.path;
  if (c && !c.startsWith("ERR_")) return messageErreurOs(e, typeof enCause === "string" ? enCause : chemin);
  return e instanceof Error ? e.message : String(e);
}

/** Erreur de `shutil.rmtree(Path)` : la racine refusée porte son `PosixPath`, un lien n'a ni errno ni message. */
export function messageRmtree(e: unknown, racine: string): string {
  const enCause = (e as { path?: unknown } | null)?.path;
  if (typeof enCause === "string" && enCause !== racine) return messageErreurPy(e, enCause);
  const repr = `PosixPath('${racine}')`;
  if (code(e) === "ELOOP" && e instanceof Error && e.message === "Cannot call rmtree on a symbolic link")
    return `[Errno None] None: ${repr}`;
  const texte = messageErreurPy(e, racine);
  return texte.endsWith(`'${racine}'`) ? `${texte.slice(0, -(racine.length + 2))}${repr}` : texte;
}
