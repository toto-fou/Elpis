// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/etat.ts — suspension et réactivation d'un compte : état posé en base, puis flux, terminaux, exécutions et bac coupés. */
import { getUsernameById, getUserSettings, leverMinSession } from "@elpis/auth";
import type { Base } from "@elpis/db";

import { travailBac } from "../admin/bac";
import type { PortBac } from "../admin/bac";
import { profilReseauDesReglages } from "../relais/identite";
import type { Journal } from "../journal";

export interface DependancesEtat {
  readonly base: Base;
  readonly maintenant: () => number;
  /** Suspension propagée aux process : flux, terminaux et exécutions du compte coupés (main compris). */
  readonly publierSuspension: (uid: number) => Promise<unknown>;
  readonly bac?: PortBac | undefined;
  readonly journal: Journal;
}

/** Pose la suspension sans écraser une suspension déjà posée, lève `session_min_ts`, coupe flux, exécutions et bac ; vrai si l'état a changé. */
export async function suspendre(dep: DependancesEtat, uid: number, par: string): Promise<boolean> {
  const t = dep.maintenant();
  const change =
    (
      await dep.base.run(
        "UPDATE users SET suspended_at=?, suspended_by=? WHERE id=? AND (suspended_at IS NULL OR suspended_at=0)",
        [t, par, uid],
      )
    ).changes > 0;
  await leverMinSession(dep.base, uid, t);
  try {
    await dep.publierSuspension(uid);
  } catch (e) {
    dep.journal.error({ err: e }, "[admin] publication account_suspended échouée");
  }
  await detruireBac(dep, uid);
  return change;
}

/** Conteneur du compte détruit (au mieux) : un compte suspendu n'a plus de processus qui tourne. */
async function detruireBac(dep: DependancesEtat, uid: number): Promise<void> {
  try {
    if (!dep.bac) throw new Error("pas de pilote de bac à sable dans ce process");
    const username = (await getUsernameById(dep.base, uid)) || `user_${uid}`;
    const profil = profilReseauDesReglages(await getUserSettings(dep.base, uid));
    await dep.bac.detruireConteneur(uid, username, travailBac(username, uid), profil);
  } catch (e) {
    dep.journal.warn(
      `[admin] destruction du conteneur user_id=${uid} à la suspension : ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Remet l'état à zéro ; les sessions d'avant restent mortes (`session_min_ts` n'est pas baissé) ; vrai si le compte était suspendu. */
export async function reactiver(dep: Pick<DependancesEtat, "base">, uid: number): Promise<boolean> {
  return (
    (
      await dep.base.run(
        "UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=? AND suspended_at > 0",
        [uid],
      )
    ).changes > 0
  );
}
