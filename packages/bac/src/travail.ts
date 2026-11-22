// SPDX-License-Identifier: MIT
/** packages/bac/src/travail.ts — racine de travail `P/work` montée sur `/work` et migration une fois de l'ancienne disposition à plat (paths.ensure_work_subdir). */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";

import { journalDe } from "@elpis/commun";
import { pyJoin } from "@elpis/config";
import { VerrouFichier } from "@elpis/verrous";

export const WORK_SUBDIR = "work";
export const WORK_MARKER = ".work-migrated";
export const WORK_LOCK = ".work-migrating.lock";
/** Droits de /work rendus à l'UID du conteneur (L4.6) ; contenu = propriétaire appliqué. */
export const MODES_MARKER = ".work-modes-v1";
export const PERMS_MARKER_LEGACY: readonly string[] = [
  ".perms-reconciled",
  ".perms-reconciled-v2",
  ".perms-reconciled-v3",
];
/** `_WORK_RESERVED` : entrées gardées à `P`, jamais déplacées dans `P/work` ni visibles du conteneur. */
export const WORK_RESERVED: ReadonlySet<string> = new Set([
  WORK_SUBDIR,
  "skills",
  ".skills-mirror.tmp",
  "memory",
  ".memory",
  ".sandboxd",
  ".elpis-agent",
  ".write_locks",
  MODES_MARKER,
  WORK_MARKER,
  WORK_LOCK,
  ...PERMS_MARKER_LEGACY,
]);

/** Marqueur de `P` lu sans suivre de lien ni attendre (fichier ordinaire, 4 Kio au plus) ; `null` s'il manque ou n'en est pas un. */
export function lireMarqueur(chemin: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(chemin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const tampon = Buffer.alloc(4096);
    return tampon.subarray(0, readSync(fd, tampon, 0, tampon.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** Marqueur de `P` écrit sans suivre de lien : un lien ou un fichier spécial à sa place fait échouer l'écriture. */
export function ecrireMarqueur(chemin: string, texte: string): void {
  const fd = openSync(
    chemin,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o666,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${chemin} : pas un fichier ordinaire`);
    writeSync(fd, texte);
  } finally {
    closeSync(fd);
  }
}

function estDossier(chemin: string): boolean {
  try {
    return statSync(chemin).isDirectory();
  } catch {
    return false;
  }
}

/** `ensure_work_subdir` : rend `P/work` ; migre une fois, sous `P/.work-migrating.lock` (elpis.verrou.v1.1, partagé avec les services Python), le marqueur écrit en dernier. */
export async function ensureWorkSubdir(perUserDir: string): Promise<string> {
  const work = pyJoin(perUserDir, WORK_SUBDIR);
  const marqueur = pyJoin(perUserDir, WORK_MARKER);
  if (lireMarqueur(marqueur) !== null) {
    mkdirSync(work, { recursive: true });
    return work;
  }
  mkdirSync(perUserDir, { recursive: true });
  const verrou = new VerrouFichier(pyJoin(perUserDir, WORK_LOCK), { battement: true });
  await verrou.acquerir();
  const log = journalDe("sandbox");
  try {
    if (lireMarqueur(marqueur) !== null) {
      mkdirSync(work, { recursive: true });
      return work;
    }
    if (existsSync(work) && !estDossier(work)) {
      log.error(`[sandbox] ${work} exists and is not a directory — skipping work-subdir migration`);
      return work;
    }
    mkdirSync(work, { recursive: true });
    for (const nom of readdirSync(perUserDir)) {
      if (WORK_RESERVED.has(nom) || nom.startsWith(WORK_LOCK + ".")) continue;
      const source = pyJoin(perUserDir, nom);
      const dest = pyJoin(work, nom);
      if (existsSync(dest)) {
        log.warn(`[sandbox] work-subdir: destination exists, leaving ${source} in place`);
        continue;
      }
      try {
        renameSync(source, dest);
      } catch (e) {
        log.warn(`[sandbox] work-subdir: could not move ${source} → ${dest}: ${(e as Error).message}`);
      }
    }
    try {
      ecrireMarqueur(marqueur, "1");
    } catch (e) {
      log.warn(`[sandbox] work-subdir: marker write failed (${marqueur}): ${(e as Error).message}`);
    }
    return work;
  } finally {
    await verrou.rendre();
  }
}
