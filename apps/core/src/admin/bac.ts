// SPDX-License-Identifier: MIT
/** apps/core/src/admin/bac.ts — bac à sable vu de la console : dossier d'un compte, occupation (`sandbox_usage_bytes`), suppression et port du pilote du bac. */
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";

import { messageSuppression, supprimerDossierBac, WORK_SUBDIR } from "@elpis/bac";
import { config, pyJoin, realpathPy, safeSandboxName } from "@elpis/config";

/** Pilote du bac (Docker local ou hôte d'outils distant du compte, `piloteBac`) : absent, la branche `except` du Python. */
export interface PortBac {
  /** Bac du compte sur un hôte d'outils distant : supprimé par cet hôte, qui dit s'il l'a trouvé ; `null` si le bac est local. */
  supprimerSurHote(uid: number, username: string): Promise<boolean | null>;
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

/** `_supprimer_sandbox` : bac d'un hôte distant supprimé par cet hôte d'abord, puis conteneur local retiré et `P` local supprimé (/work vidé par le conteneur si l'hôte n'en a pas le droit) ; rien n'est touché ici tant que l'hôte résiste ; `[supprimé, erreur]`. */
export async function supprimerBac(
  uid: number,
  username: string,
  dossier: string,
  port?: PortBac,
): Promise<[boolean, string | null]> {
  let distant: boolean;
  try {
    distant = (await port?.supprimerSurHote(uid, username)) === true;
  } catch (e) {
    return [false, messageSuppression(e)];
  }
  try {
    await stat(dossier);
  } catch {
    return [distant, null];
  }
  try {
    await port?.retirerConteneur(uid, username, pyJoin(dossier, WORK_SUBDIR));
  } catch (e) {
    return [distant, messageSuppression(e)];
  }
  const [local, erreur] = await supprimerDossierBac(
    dossier,
    port ? (travail) => port.purgerTravail(uid, username, travail) : undefined,
  );
  return [distant || local, erreur];
}
