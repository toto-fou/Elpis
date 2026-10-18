// SPDX-License-Identifier: MIT
/** packages/verrous/src/es.ts — opérations de fichier du protocole, écrites une fois en générateurs et exécutées en asynchrone (boucle libre) ou en synchrone (code d'initialisation). */
import {
  close,
  closeSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  link,
  linkSync,
  lstatSync,
  mkdirSync,
  open,
  openSync,
  read,
  readSync,
  renameSync,
  unlinkSync,
  write,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import { setTimeout as dormirAsync } from "node:timers/promises";

export const LECTURE_MAX = 4096;

export type Op =
  | { f: "open"; chemin: string; drapeaux: number; mode?: number | undefined }
  | { f: "fstat"; fd: number }
  | { f: "read"; fd: number }
  | { f: "write"; fd: number; donnees: Uint8Array }
  | { f: "fsync"; fd: number }
  | { f: "close"; fd: number }
  | { f: "lstat"; chemin: string }
  | { f: "mkdir"; chemin: string }
  | { f: "unlink"; chemin: string }
  | { f: "rename"; de: string; vers: string }
  | { f: "link"; de: string; vers: string }
  | { f: "dormir"; ms: number }
  | { f: "bloc"; proc: Proc<unknown> };

/** Procédure du protocole : chaque `yield` est une opération, dont le résultat revient au générateur. */
export type Proc<T> = Generator<Op, T, unknown>;

export function* ouvrir(chemin: string, drapeaux: number, mode?: number): Proc<number> {
  return (yield { f: "open", chemin, drapeaux, mode }) as number;
}
export function* etatFd(fd: number): Proc<BigIntStats> {
  return (yield { f: "fstat", fd }) as BigIntStats;
}
/** Au plus `LECTURE_MAX` octets lus en une fois depuis le début. */
export function* lireFd(fd: number): Proc<Buffer> {
  return (yield { f: "read", fd }) as Buffer;
}
export function* ecrireFd(fd: number, donnees: Uint8Array): Proc<void> {
  yield { f: "write", fd, donnees };
}
export function* synchroniserFd(fd: number): Proc<void> {
  yield { f: "fsync", fd };
}
export function* fermer(fd: number): Proc<void> {
  yield { f: "close", fd };
}
export function* etatLien(chemin: string): Proc<BigIntStats> {
  return (yield { f: "lstat", chemin }) as BigIntStats;
}
export function* creerDossier(chemin: string): Proc<void> {
  yield { f: "mkdir", chemin };
}
export function* effacer(chemin: string): Proc<void> {
  yield { f: "unlink", chemin };
}
export function* renommer(de: string, vers: string): Proc<void> {
  yield { f: "rename", de, vers };
}
export function* lier(de: string, vers: string): Proc<void> {
  yield { f: "link", de, vers };
}
export function* dormir(ms: number): Proc<void> {
  yield { f: "dormir", ms };
}
/** Sous-procédure exécutée d'un trait en synchrone (décision relecture → suppression sans passer par la boucle) ; jamais d'attente dedans. */
export function* bloc<T>(proc: Proc<T>): Proc<T> {
  return (yield { f: "bloc", proc }) as T;
}

function promesse<T>(appel: (rappel: (e: NodeJS.ErrnoException | null, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => appel((e, v) => (e ? reject(e) : resolve(v))));
}

/** Appels système asynchrones, remplaçables par les tests (pannes simulées, comme `monkeypatch` sur `os`). */
export const systeme = {
  open: (chemin: string, drapeaux: number, mode?: number): Promise<number> =>
    promesse<number>((r) => open(chemin, drapeaux, mode ?? 0o666, r)),
  fstat: (fd: number): Promise<BigIntStats> => promesse<BigIntStats>((r) => fstat(fd, { bigint: true }, r)),
  read: async (fd: number): Promise<Buffer> => {
    const tampon = Buffer.alloc(LECTURE_MAX);
    const n = await promesse<number>((r) => read(fd, tampon, 0, LECTURE_MAX, 0, r));
    return tampon.subarray(0, n);
  },
  write: async (fd: number, donnees: Uint8Array): Promise<void> => {
    for (let fait = 0; fait < donnees.length;)
      fait += await promesse<number>((r) => write(fd, donnees, fait, donnees.length - fait, null, r));
  },
  fsync: (fd: number): Promise<void> => promesse<void>((r) => fsync(fd, r)),
  close: (fd: number): Promise<void> => promesse<void>((r) => close(fd, r)),
  lstat: (chemin: string): Promise<BigIntStats> => lstat(chemin, { bigint: true }),
  mkdir: async (chemin: string): Promise<void> => {
    await mkdir(chemin, { recursive: true });
  },
  unlink: (chemin: string): Promise<void> => unlink(chemin),
  rename: (de: string, vers: string): Promise<void> => rename(de, vers),
  link: (de: string, vers: string): Promise<void> => promesse<void>((r) => link(de, vers, r)),
};

const ATTENTE = new Int32Array(new SharedArrayBuffer(4));

/** Pendant synchrone de `systeme` (attente bloquante par `Atomics.wait`). */
export const systemeSync = {
  open: (chemin: string, drapeaux: number, mode?: number): number =>
    openSync(chemin, drapeaux, mode ?? 0o666),
  fstat: (fd: number): BigIntStats => fstatSync(fd, { bigint: true }),
  read: (fd: number): Buffer => {
    const tampon = Buffer.alloc(LECTURE_MAX);
    return tampon.subarray(0, readSync(fd, tampon, 0, LECTURE_MAX, 0));
  },
  write: (fd: number, donnees: Uint8Array): void => {
    for (let fait = 0; fait < donnees.length;) fait += writeSync(fd, donnees, fait, donnees.length - fait);
  },
  fsync: (fd: number): void => fsyncSync(fd),
  close: (fd: number): void => closeSync(fd),
  lstat: (chemin: string): BigIntStats => lstatSync(chemin, { bigint: true }),
  mkdir: (chemin: string): void => {
    mkdirSync(chemin, { recursive: true });
  },
  unlink: (chemin: string): void => unlinkSync(chemin),
  rename: (de: string, vers: string): void => renameSync(de, vers),
  link: (de: string, vers: string): void => linkSync(de, vers),
};

type OpES = Exclude<Op, { f: "dormir" } | { f: "bloc" }>;

function appliquer(op: OpES): Promise<unknown> {
  switch (op.f) {
    case "open":
      return systeme.open(op.chemin, op.drapeaux, op.mode);
    case "fstat":
      return systeme.fstat(op.fd);
    case "read":
      return systeme.read(op.fd);
    case "write":
      return systeme.write(op.fd, op.donnees);
    case "fsync":
      return systeme.fsync(op.fd);
    case "close":
      return systeme.close(op.fd);
    case "lstat":
      return systeme.lstat(op.chemin);
    case "mkdir":
      return systeme.mkdir(op.chemin);
    case "unlink":
      return systeme.unlink(op.chemin);
    case "rename":
      return systeme.rename(op.de, op.vers);
    case "link":
      return systeme.link(op.de, op.vers);
  }
}

function appliquerSync(op: OpES): unknown {
  switch (op.f) {
    case "open":
      return systemeSync.open(op.chemin, op.drapeaux, op.mode);
    case "fstat":
      return systemeSync.fstat(op.fd);
    case "read":
      return systemeSync.read(op.fd);
    case "write":
      return systemeSync.write(op.fd, op.donnees);
    case "fsync":
      return systemeSync.fsync(op.fd);
    case "close":
      return systemeSync.close(op.fd);
    case "lstat":
      return systemeSync.lstat(op.chemin);
    case "mkdir":
      return systemeSync.mkdir(op.chemin);
    case "unlink":
      return systemeSync.unlink(op.chemin);
    case "rename":
      return systemeSync.rename(op.de, op.vers);
    case "link":
      return systemeSync.link(op.de, op.vers);
  }
}

/** Exécute une procédure sur la boucle d'événements : E/S asynchrones, attentes non bloquantes. */
export async function executer<T>(proc: Proc<T>): Promise<T> {
  let suite = proc.next();
  while (!suite.done) {
    const op = suite.value;
    let resultat: unknown;
    try {
      if (op.f === "dormir") resultat = await dormirAsync(op.ms);
      else if (op.f === "bloc") resultat = executerSync(op.proc);
      else resultat = await appliquer(op);
    } catch (e) {
      suite = proc.throw(e);
      continue;
    }
    suite = proc.next(resultat);
  }
  return suite.value;
}

/** Exécute une procédure d'un bloc : E/S synchrones, attentes bloquantes (code synchrone d'initialisation seulement). */
export function executerSync<T>(proc: Proc<T>): T {
  let suite = proc.next();
  while (!suite.done) {
    const op = suite.value;
    let resultat: unknown;
    try {
      if (op.f === "dormir") Atomics.wait(ATTENTE, 0, 0, op.ms);
      else if (op.f === "bloc") resultat = executerSync(op.proc);
      else resultat = appliquerSync(op);
    } catch (e) {
      suite = proc.throw(e);
      continue;
    }
    suite = proc.next(resultat);
  }
  return suite.value;
}
