// SPDX-License-Identifier: MIT
/** packages/bac/src/suppression.ts — suppression du dossier `P` d'un compte (`_supprimer_sandbox`) : /work par descripteurs, vidé par le root du conteneur si l'hôte n'en a pas le droit, puis le reste. */
import { lstat, readdir, stat } from "node:fs/promises";

import { messageErreurOs, reprPy } from "@elpis/commun";
import { pyJoin } from "@elpis/config";
import { supprimerArbreSous } from "@elpis/securite";

import { WORK_SUBDIR } from "./travail";

/** `shutil.rmtree` de Python 3.13 : refusé sur un lien symbolique (`OSError(None, None, chemin)`), puis supprimé par descripteurs (un lien échangé en cours de route n'est jamais suivi). */
async function rmtree(chemin: string): Promise<void> {
  if ((await lstat(chemin)).isSymbolicLink())
    throw new Error(`[Errno None] None: PosixPath(${reprPy(chemin)})`);
  await supprimerArbreSous(chemin);
}

function estRefus(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

/** `str(e)` d'une erreur de suppression, au format de Python pour une erreur système. */
export function messageSuppression(e: unknown): string {
  const chemin = (e as { path?: unknown }).path;
  return typeof chemin === "string" ? messageErreurOs(e, chemin) : e instanceof Error ? e.message : String(e);
}

/** `P` supprimé, /work d'abord (vidé par `purger` si l'hôte n'en a pas le droit) : rien n'est touché tant que /work résiste ; `[supprimé, erreur]`, `[false, null]` sans `P`. */
export async function supprimerDossierBac(
  dossier: string,
  purger?: (travail: string) => Promise<void>,
): Promise<[boolean, string | null]> {
  try {
    try {
      await stat(dossier);
    } catch {
      return [false, null];
    }
    const travail = pyJoin(dossier, WORK_SUBDIR);
    let estDossier: boolean;
    try {
      estDossier = (await stat(travail)).isDirectory();
    } catch {
      estDossier = false;
    }
    if (estDossier && (await readdir(travail)).length > 0) {
      try {
        await rmtree(travail);
      } catch (e) {
        if (!estRefus(e) || !purger) throw e;
        await purger(travail);
      }
    }
    await rmtree(dossier);
    return [true, null];
  } catch (e) {
    return [false, messageSuppression(e)];
  }
}
