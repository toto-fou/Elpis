// SPDX-License-Identifier: MIT
/** packages/bac/src/suppression.ts — suppression du dossier `P` d'un compte (`_supprimer_sandbox`) : /work par descripteurs, vidé par le root du conteneur si l'hôte n'en a pas le droit, puis le reste. */
import { lstat, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

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

/** Dossier des instantanés de l'hôte, sous la racine des bacs. */
const INSTANTANES_SUBDIR = "_snapshots";

async function existe(chemin: string): Promise<boolean> {
  try {
    await lstat(chemin);
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return false;
    throw e;
  }
}

/** Nom, hors de portée des noms de comptes, sous lequel `P` et les instantanés d'un compte supprimé sont gardés. */
export function nomMisDeCote(uid: number, horodatageMs: number): string {
  return `.supprime-${uid}-${horodatageMs}`;
}

/** Vrai si `nom` est celui d'un bac mis de côté du compte `uid` (`nomMisDeCote`). */
export function estNomMisDeCote(nom: string, uid: number): boolean {
  const prefixe = `.supprime-${uid}-`;
  return nom.startsWith(prefixe) && /^[0-9]+$/u.test(nom.slice(prefixe.length));
}

/** Un nom sûr commençant par `_` ou `.` désigne un dossier réservé (instantanés, bacs mis de côté) : jamais mis de côté ni remis. */
function exigerNomSurOrdinaire(nomSur: string): void {
  if (nomSur === "" || nomSur.startsWith("_") || nomSur.startsWith("."))
    throw new Error(`nom de bac réservé : ${reprPy(nomSur)}`);
}

/** `P` et les instantanés du nom sûr renommés en `.supprime-<uid>-<horodatage>` (aucun nom de compte ne commence par un point ni un tiret bas), contenu intact ; un échec remet en place ce qui l'était déjà ; liste des `[origine, destination]` faits (vide sans rien). */
export async function mettreBacDeCote(
  racine: string,
  nomSur: string,
  uid: number,
  horodatageMs: number,
): Promise<[string, string][]> {
  exigerNomSurOrdinaire(nomSur);
  const nom = nomMisDeCote(uid, horodatageMs);
  const faits: [string, string][] = [];
  try {
    for (const dossier of [racine, join(racine, INSTANTANES_SUBDIR)]) {
      const origine = join(dossier, nomSur);
      if (!(await existe(origine))) continue;
      const destination = join(dossier, nom);
      await rename(origine, destination);
      faits.push([origine, destination]);
    }
  } catch (e) {
    for (const [origine, destination] of faits.reverse())
      await rename(destination, origine).catch(() => undefined);
    throw e;
  }
  return faits;
}

/** `P` et les instantanés mis de côté sous cet horodatage remis sous le nom sûr (un des deux échoue : l'autre est tenté quand même, la première erreur est levée). */
export async function remettreBacMisDeCote(
  racine: string,
  nomSur: string,
  uid: number,
  horodatageMs: number,
): Promise<void> {
  exigerNomSurOrdinaire(nomSur);
  const nom = nomMisDeCote(uid, horodatageMs);
  const erreurs: unknown[] = [];
  for (const dossier of [join(racine, INSTANTANES_SUBDIR), racine]) {
    try {
      if (await existe(join(dossier, nom))) await rename(join(dossier, nom), join(dossier, nomSur));
    } catch (e) {
      erreurs.push(e);
    }
  }
  if (erreurs.length > 0) throw erreurs[0];
}

/** Instantanés du nom sûr supprimés (arbre par descripteurs) ; `null` si tout va bien ou s'il n'y en a pas, sinon la raison. */
export async function supprimerInstantanesDuNom(racine: string, nomSur: string): Promise<string | null> {
  const dossier = join(racine, INSTANTANES_SUBDIR, nomSur);
  try {
    if (!(await existe(dossier))) return null;
    await rmtree(dossier);
    return null;
  } catch (e) {
    return messageSuppression(e);
  }
}

/** `P` et instantanés mis de côté sous cet horodatage supprimés (/work vidé par `purger` si l'hôte n'en a pas le droit) ; les deux sont tentés, `[P supprimé, première erreur]`. */
export async function supprimerBacMisDeCote(
  racine: string,
  uid: number,
  horodatageMs: number,
  purger?: (travail: string) => Promise<void>,
): Promise<[boolean, string | null]> {
  const nom = nomMisDeCote(uid, horodatageMs);
  const [supprime, erreur] = await supprimerDossierBac(join(racine, nom), purger);
  const erreurInstantanes = await supprimerInstantanesDuNom(racine, nom);
  return [supprime, erreur ?? erreurInstantanes];
}
