// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/etat.ts — suspension et réactivation d'un compte : état et coupure des sessions posés en une écriture, puis flux, terminaux, exécutions et bac coupés. */
import { getUsernameById, getUserSettings } from "@elpis/auth";
import type { Base } from "@elpis/db";

import { travailBac } from "../admin/bac";
import type { PortBac } from "../admin/bac";
import { exigerAdminLocal } from "../identite/etat";
import { profilReseauDesReglages } from "../relais/identite";
import type { Journal } from "../journal";

export interface DependancesEtat {
  readonly base: Base;
  readonly maintenant: () => number;
  /** Suspension propagée aux process (flux, terminaux, exécutions, main compris) ; vrai si main l'a reçue. */
  readonly publierSuspension: (uid: number) => Promise<boolean>;
  readonly bac?: PortBac | undefined;
  readonly journal: Journal;
}

export interface BilanSuspension {
  /** L'état a changé (le compte n'était pas déjà suspendu). */
  readonly change: boolean;
  /** Main a reçu l'événement (sinon seule la relecture de l'état par les exécutions en cours coupe). */
  readonly propage: boolean;
  /** Le conteneur du compte est détruit. */
  readonly bacArrete: boolean;
}

/** Remonte `session_min_ts` à `?` sans jamais le baisser (fragment SQL portable). */
const MONTER_MIN_SESSION =
  "session_min_ts=CASE WHEN session_min_ts IS NULL OR session_min_ts<? THEN ? ELSE session_min_ts END";

/** Pose la suspension et la coupure des sessions en UNE écriture (refusée si elle retire le dernier administrateur local actif, sans écraser une suspension déjà posée), puis coupe flux, exécutions et bac. */
export async function suspendre(dep: DependancesEtat, uid: number, par: string): Promise<BilanSuspension> {
  const t = dep.maintenant();
  const change = await dep.base.ecriture(async (x) => {
    await exigerAdminLocal(x, { sauf: uid });
    return (
      (
        await x.run(
          `UPDATE users SET suspended_at=?, suspended_by=?, ${MONTER_MIN_SESSION} WHERE id=? AND (suspended_at IS NULL OR suspended_at=0)`,
          [t, par, t, t, uid],
        )
      ).changes > 0
    );
  });
  let propage = false;
  try {
    propage = (await dep.publierSuspension(uid)) !== false;
  } catch (e) {
    dep.journal.error({ err: e }, "[admin] publication account_suspended échouée");
  }
  const bacArrete = await detruireBac(dep, uid);
  return { change, propage, bacArrete };
}

/** Conteneur du compte détruit (au mieux) : un compte suspendu n'a plus de processus qui tourne. */
async function detruireBac(dep: DependancesEtat, uid: number): Promise<boolean> {
  try {
    if (!dep.bac) throw new Error("pas de pilote de bac à sable dans ce process");
    const username = (await getUsernameById(dep.base, uid)) || `user_${uid}`;
    const profil = profilReseauDesReglages(await getUserSettings(dep.base, uid));
    await dep.bac.detruireConteneur(uid, username, travailBac(username, uid), profil);
    return true;
  } catch (e) {
    dep.journal.warn(
      `[admin] destruction du conteneur user_id=${uid} à la suspension : ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/** Remet l'état à zéro et remonte `session_min_ts` à l'instant de la réactivation (une session datée pendant la suspension ne revit pas) ; vrai si le compte était suspendu. */
export async function reactiver(
  dep: Pick<DependancesEtat, "base"> & { readonly maintenant?: () => number },
  uid: number,
): Promise<boolean> {
  const t = dep.maintenant?.() ?? Date.now() / 1000;
  return (
    (
      await dep.base.run(
        `UPDATE users SET suspended_at=0, suspended_by=NULL, ${MONTER_MIN_SESSION} WHERE id=? AND suspended_at IS NOT NULL AND suspended_at<>0`,
        [t, t, uid],
      )
    ).changes > 0
  );
}
