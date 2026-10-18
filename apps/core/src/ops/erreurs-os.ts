// SPDX-License-Identifier: MIT
/** apps/core/src/ops/erreurs-os.ts — `type(e).__name__` et `str(e)` de Python pour une erreur système de Node, dans les messages des sauvegardes. */
import { ErreurPython, ErreurZip, reprPy } from "@elpis/commun";

import { ErreurCheminBac } from "@elpis/securite";

const ERRNO: Readonly<Record<string, readonly [number, string]>> = {
  EPERM: [1, "Operation not permitted"],
  ENOENT: [2, "No such file or directory"],
  EIO: [5, "Input/output error"],
  ENXIO: [6, "No such device or address"],
  EBADF: [9, "Bad file descriptor"],
  EAGAIN: [11, "Resource temporarily unavailable"],
  ENOMEM: [12, "Cannot allocate memory"],
  EACCES: [13, "Permission denied"],
  EBUSY: [16, "Device or resource busy"],
  EEXIST: [17, "File exists"],
  EXDEV: [18, "Invalid cross-device link"],
  ENODEV: [19, "No such device"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  EINVAL: [22, "Invalid argument"],
  EMFILE: [24, "Too many open files"],
  ETXTBSY: [26, "Text file busy"],
  EFBIG: [27, "File too large"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
  EMLINK: [31, "Too many links"],
  ENAMETOOLONG: [36, "File name too long"],
  ENOTEMPTY: [39, "Directory not empty"],
  ELOOP: [40, "Too many levels of symbolic links"],
  EILSEQ: [84, "Invalid or incomplete multibyte or wide character"],
  ETIMEDOUT: [110, "Connection timed out"],
  ECONNREFUSED: [111, "Connection refused"],
  EDQUOT: [122, "Disk quota exceeded"],
};

const CLASSES: Readonly<Record<string, string>> = {
  EACCES: "PermissionError",
  EPERM: "PermissionError",
  ENOENT: "FileNotFoundError",
  EEXIST: "FileExistsError",
  EISDIR: "IsADirectoryError",
  ENOTDIR: "NotADirectoryError",
  EAGAIN: "BlockingIOError",
  EINTR: "InterruptedError",
  ETIMEDOUT: "TimeoutError",
  ECONNREFUSED: "ConnectionRefusedError",
};

interface ErreurSysteme {
  code: string;
  errno?: number;
  path?: string;
  dest?: string;
}

/** Erreur d'E/S de Node (l'`OSError` de Python). */
export function estErreurOs(e: unknown): e is Error & ErreurSysteme {
  return (
    e instanceof Error &&
    typeof (e as { code?: unknown }).code === "string" &&
    /^E[A-Z0-9]+$/u.test((e as unknown as { code: string }).code)
  );
}

/** `type(e).__name__`. */
export function classeErreurPy(e: unknown): string {
  if (e instanceof ErreurCheminBac) return "SandboxPathError";
  if (e instanceof ErreurPython || e instanceof ErreurZip) return e.type;
  if (estErreurOs(e)) return CLASSES[e.code] ?? "OSError";
  return e instanceof Error ? e.name : "Exception";
}

/** `str(e)` : « [Errno 13] Permission denied: '/chemin' » pour une erreur système, le message sinon. */
export function texteErreurPy(e: unknown): string {
  if (e instanceof ErreurCheminBac || e instanceof ErreurPython || e instanceof ErreurZip) return e.message;
  if (estErreurOs(e)) {
    const [numero, texte] = ERRNO[e.code] ?? [Math.abs(Number(e.errno) || 0), e.code];
    let s = `[Errno ${numero}] ${texte}`;
    if (e.path !== undefined) s += `: ${reprPy(e.path)}`;
    if (e.path !== undefined && e.dest !== undefined) s += ` -> ${reprPy(e.dest)}`;
    return s;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Erreur système de Node rattachée au chemin que Python aurait cité. */
export function avecChemin<E>(e: E, chemin: string): E {
  if (estErreurOs(e)) {
    e.path = chemin;
    delete e.dest;
  }
  return e;
}
