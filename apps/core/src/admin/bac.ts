// SPDX-License-Identifier: MIT
/** apps/core/src/admin/bac.ts — bac à sable vu de la console : dossier d'un compte, occupation (`sandbox_usage_bytes`), suppression et port du pilote du bac. */
import { mkdirSync } from "node:fs";

import {
  messageSuppression,
  mettreBacDeCote,
  remettreBacMisDeCote,
  supprimerBacMisDeCote,
  WORK_SUBDIR,
} from "@elpis/bac";
import { config, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";

import type { SandboxHost } from "../relais/hotes";

/** Pilote du bac (Docker local ou hôte d'outils distant du compte, `piloteBac`) : absent, la branche `except` du Python. */
export interface PortBac {
  /** Hôte d'outils distant du compte (hors loopback), résolu avant la suppression de sa ligne ; `null` : bac local. */
  hoteDistantDuCompte?(uid: number): Promise<SandboxHost | null>;
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
  /** Conteneur local du compte retiré (processus arrêtés) avant la suppression de P ; rien sans Docker. */
  retirerConteneur(uid: number, username: string, travail: string): Promise<void>;
  /** `get_user_sandbox(…).purge()` : vide /work par le root du conteneur (fichiers à l'UID du conteneur). */
  purgerTravail(uid: number, username: string, travail: string): Promise<void>;
  /** `get_user_sandbox(…, network_profile_id=avant).destroy()` puis `reset_user_sandbox_cache()`. */
  detruireConteneur(uid: number, username: string, travail: string, profilAvant: string): Promise<void>;
}

/** `_get_sandbox_path` : `<SANDBOX_DIR>/<nom sûr>` résolu, créé au besoin. */
export function racineBac(username: string | null, uid: number): string {
  const racine = realpathPy(pyJoin(config.SANDBOX_DIR, safeSandboxName(username || `user_${uid}`)));
  mkdirSync(racine, { recursive: true });
  return racine;
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

/** Bac gardé d'un compte supprimé : mis de côté (`.supprime-<uid>-<horodatage>`), puis remis en place ou supprimé. */
export interface BacMisDeCote {
  /** Local puis hôte distant remis sous le nom du compte (la suppression a échoué) ; la première erreur est levée. */
  remettre(): Promise<void>;
  /** Dossiers mis de côté supprimés, localement et sur l'hôte ; `[supprimé, erreur]`, les deux côtés tentés. */
  supprimer(): Promise<[boolean, string | null]>;
}

/** Conteneur retiré, puis `P` et instantanés du nom (locaux puis ceux de l'hôte distant) renommés hors de portée des noms de comptes ; un échec remet le local en place et lève. */
export async function mettreBacDeCoteDuCompte(
  uid: number,
  username: string,
  port?: PortBac,
): Promise<BacMisDeCote> {
  const racine = realpathPy(config.SANDBOX_DIR);
  const nomSur = safeSandboxName(username);
  const horodatage = Date.now();
  await port?.retirerConteneur(uid, username, pyJoin(pyJoin(racine, nomSur), WORK_SUBDIR));
  const hote = (await port?.hoteDistantDuCompte?.(uid)) ?? null;
  await mettreBacDeCote(racine, nomSur, uid, horodatage);
  try {
    if (hote !== null) await port?.mettreDeCoteSurHote?.(hote, uid, username, horodatage);
  } catch (e) {
    await remettreBacMisDeCote(racine, nomSur, uid, horodatage).catch(() => undefined);
    throw e;
  }
  return {
    async remettre() {
      const erreurs: unknown[] = [];
      for (const remise of [
        () => remettreBacMisDeCote(racine, nomSur, uid, horodatage),
        async () => {
          if (hote !== null) await port?.remettreSurHote?.(hote, uid, username, horodatage);
        },
      ])
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
      const [local, erreurLocale] = await supprimerBacMisDeCote(
        racine,
        uid,
        horodatage,
        port ? (travail) => port.purgerTravail(uid, username, travail) : undefined,
      );
      const echec = erreur ?? erreurLocale;
      return [echec === null && (distant === true || local), echec];
    },
  };
}
