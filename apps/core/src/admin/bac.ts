// SPDX-License-Identifier: MIT
/** apps/core/src/admin/bac.ts — bac à sable vu de la console : dossier d'un compte, occupation (`sandbox_usage_bytes`), suppression et port du pilote du bac. */
import { rename } from "node:fs/promises";

import {
  messageSuppression,
  mettreBacDeCote,
  nomMisDeCote,
  remettreBacMisDeCote,
  supprimerBacMisDeCote,
  WORK_SUBDIR,
} from "@elpis/bac";
import { config, pyJoin, pyPath, realpathPy, safeSandboxName } from "@elpis/config";
import { supprimerEntreeSous } from "@elpis/securite";

import { safeUsername } from "../memoire/portee";
import type { SandboxHost } from "../relais/hotes";

/** Pilote du bac (hôtes d'outils, `piloteBac` : jamais Docker dans le core) : absent, la branche `except` du Python. */
export interface PortBac {
  /** Hôte d'outils distant du compte (hors loopback), résolu avant la suppression de sa ligne ; `null` : bac local. */
  hoteDistantDuCompte?(uid: number): Promise<SandboxHost | null>;
  /** Hôte d'outils de cette machine quand il est seul à écrire le dossier des bacs (un compte par service) : le bac local passe par lui ; `null` : la console le traite elle-même. */
  hoteIci?(): Promise<SandboxHost | null>;
  /** Bac du compte sur cet hôte renommé hors de portée des noms de comptes sous cet horodatage ; dit s'il l'a trouvé. */
  mettreDeCoteSurHote?(
    hote: SandboxHost,
    uid: number,
    username: string,
    horodatage: number,
  ): Promise<boolean>;
  /** Bac mis de côté sur cet hôte remis sous le nom du compte. */
  remettreSurHote?(hote: SandboxHost, uid: number, username: string, horodatage: number): Promise<void>;
  /** Bac mis de côté sur cet hôte supprimé par lui ; dit s'il l'a trouvé. */
  supprimerMisDeCoteSurHote?(
    hote: SandboxHost,
    uid: number,
    username: string,
    horodatage: number,
  ): Promise<boolean>;
  /** Conteneur du compte retiré par l'hôte de cette machine (processus arrêtés) avant la mise de côté de P ; rien sans hôte. */
  retirerConteneur(uid: number, username: string, travail: string): Promise<void>;
  /** /work `travail` du bac mis de côté sous `horodatage` vidé par le root du conteneur de l'hôte de cette machine (fichiers à l'UID du conteneur). */
  purgerTravail(uid: number, username: string, travail: string, horodatage: number): Promise<void>;
  /** Conteneur du compte détruit par son hôte (/work gardé), au changement de profil réseau ou à la suspension. */
  detruireConteneur(uid: number, username: string, travail: string, profilAvant: string): Promise<void>;
}

/** `P/work` sans création ni migration de l'ancienne disposition à plat (faites par l'hôte d'outils au premier accès). */
export function travailBac(username: string | null, uid: number): string {
  return pyJoin(
    realpathPy(pyJoin(config.SANDBOX_DIR, safeSandboxName(username || `user_${uid}`))),
    WORK_SUBDIR,
  );
}

/** `_sandbox_size_bytes`, `sandbox_usage_bytes` : partagés avec l'hôte d'outils (@elpis/bac). */
export { oublierOccupations, sandboxUsageBytes, tailleBac } from "@elpis/bac";

/** Bac et mémoire gardés d'un compte supprimé : mis de côté (`.supprime-<uid>-<horodatage>`), puis remis en place ou supprimés ensemble. */
export interface BacMisDeCote {
  /** Local, hôte distant puis mémoire remis sous le nom du compte (la suppression a échoué) ; la première erreur est levée. */
  remettre(): Promise<void>;
  /** Dossiers mis de côté (bac et mémoire) supprimés, localement et sur l'hôte ; `[supprimé, erreur]`, tous tentés. */
  supprimer(): Promise<[boolean, string | null]>;
}

/** `de` renommé en `vers` s'il existe ; vrai s'il a été renommé. */
async function renommerSiPresent(de: string, vers: string): Promise<boolean> {
  try {
    await rename(de, vers);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Mémoire du compte (`<MEMORY_DIR>/<compte>`) et son nom mis de côté sous l'horodatage ; `null` quand elle vit dans le dossier des bacs, où elle suit `P`. */
function memoireMiseDeCote(uid: number, username: string, horodatage: number): [string, string] | null {
  if (pyPath(config.MEMORY_DIR) === pyPath(config.SANDBOX_DIR)) return null;
  return [
    pyJoin(config.MEMORY_DIR, safeUsername(username)),
    pyJoin(config.MEMORY_DIR, nomMisDeCote(uid, horodatage)),
  ];
}

/** Conteneur retiré, puis `P` et instantanés du nom (de cette machine, par son hôte d'outils s'il est seul à écrire le dossier des bacs, puis ceux de l'hôte distant) et mémoire du compte renommés hors de portée des noms de comptes ; un échec remet en place ce qui l'était et lève. */
export async function mettreBacDeCoteDuCompte(
  uid: number,
  username: string,
  port?: PortBac,
): Promise<BacMisDeCote> {
  const racine = realpathPy(config.SANDBOX_DIR);
  const nomSur = safeSandboxName(username);
  const horodatage = Date.now();
  const memoire = memoireMiseDeCote(uid, username, horodatage);
  await port?.retirerConteneur(uid, username, pyJoin(pyJoin(racine, nomSur), WORK_SUBDIR));
  const hote = (await port?.hoteDistantDuCompte?.(uid)) ?? null;
  const ici = (await port?.hoteIci?.()) ?? null;
  const remettreIci = async (): Promise<void> => {
    if (ici === null) await remettreBacMisDeCote(racine, nomSur, uid, horodatage);
    else await port?.remettreSurHote?.(ici, uid, username, horodatage);
  };
  const remettreDistant = async (): Promise<void> => {
    if (hote !== null) await port?.remettreSurHote?.(hote, uid, username, horodatage);
  };
  const remettreMemoire = async (): Promise<void> => {
    if (memoire !== null) await renommerSiPresent(memoire[1], memoire[0]);
  };
  if (ici === null) await mettreBacDeCote(racine, nomSur, uid, horodatage);
  else await port?.mettreDeCoteSurHote?.(ici, uid, username, horodatage);
  try {
    if (hote !== null) await port?.mettreDeCoteSurHote?.(hote, uid, username, horodatage);
  } catch (e) {
    await remettreIci().catch(() => undefined);
    throw e;
  }
  try {
    if (memoire !== null) await renommerSiPresent(memoire[0], memoire[1]);
  } catch (e) {
    for (const remise of [remettreDistant, remettreIci]) await remise().catch(() => undefined);
    throw e;
  }
  return {
    async remettre() {
      const erreurs: unknown[] = [];
      for (const remise of [remettreIci, remettreDistant, remettreMemoire])
        await remise().catch((e: unknown) => erreurs.push(e));
      if (erreurs.length > 0) throw erreurs[0];
    },
    async supprimer() {
      let distant: boolean | null = null;
      let erreur: string | null = null;
      try {
        if (hote !== null)
          distant = (await port?.supprimerMisDeCoteSurHote?.(hote, uid, username, horodatage)) ?? null;
      } catch (e) {
        erreur = messageSuppression(e);
      }
      let local = false;
      let erreurLocale: string | null = null;
      if (ici === null)
        [local, erreurLocale] = await supprimerBacMisDeCote(
          racine,
          uid,
          horodatage,
          port ? (travail) => port.purgerTravail(uid, username, travail, horodatage) : undefined,
        );
      else
        try {
          local = (await port?.supprimerMisDeCoteSurHote?.(ici, uid, username, horodatage)) === true;
        } catch (e) {
          erreurLocale = messageSuppression(e);
        }
      let erreurMemoire: string | null = null;
      try {
        if (memoire !== null) await supprimerEntreeSous(memoire[1]);
      } catch (e) {
        erreurMemoire = messageSuppression(e);
      }
      const echec = erreur ?? erreurLocale ?? erreurMemoire;
      return [echec === null && (distant === true || local), echec];
    },
  };
}
