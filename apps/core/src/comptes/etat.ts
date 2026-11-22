// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/etat.ts — suspension et réactivation d'un compte : état et coupure des sessions posés en une écriture, puis flux, terminaux, exécutions et bac coupés. */
import { getUsernameById, getUserSettings, revoquerTousAcces } from "@elpis/auth";
import type { DependancesJetons } from "@elpis/auth";
import type { Base, Executeur } from "@elpis/db";

import { travailBac } from "../admin/bac";
import type { PortBac } from "../admin/bac";
import { exigerAdminLocal } from "../identite/etat";
import { profilReseauDesReglages } from "../relais/identite";
import type { Journal } from "../journal";

export interface DependancesEtat {
  readonly base: Base;
  /** Jetons d'API et accès OAuth du compte, révoqués par toute suspension. */
  readonly acces: DependancesJetons;
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
  /** Jetons d'API révoqués. */
  readonly tokens: number;
  /** Accès OAuth révoqués. */
  readonly oauth: number;
  /** Origine `provider:*` ou `stale:*` remplacée par `admin`, `null` sinon. */
  readonly remplace: string | null;
}

export interface OptionsCoupure {
  /** Faux : jetons d'API et accès OAuth gardés (déjà refusés tant que le compte est suspendu) ; vrai par défaut. */
  readonly revoquerAcces?: boolean;
}

const ORIGINE_FOURNISSEUR = /^(provider|stale):/u;

/** Pose la suspension (voir `poserSuspension`) ; `remplace` rend l'origine posée par un fournisseur qu'une suspension d'administrateur a prise à sa place. */
export async function poserSuspensionDetaillee(
  x: Executeur,
  uid: number,
  par: string,
  t: number,
): Promise<{ change: boolean; remplace: string | null }> {
  await exigerAdminLocal(x, { sauf: uid });
  const pose = await x.run(
    "UPDATE users SET suspended_at=?, suspended_by=?, session_min_ts=CASE WHEN session_min_ts IS NULL OR session_min_ts<? THEN ? ELSE session_min_ts END WHERE id=? AND (suspended_at IS NULL OR suspended_at=0)",
    [t, par, t, t, uid],
  );
  if (pose.changes > 0) {
    return { change: true, remplace: null };
  }
  if (par !== "admin") return { change: false, remplace: null };
  const l = await x.get<{ suspended_by: string | null }>("SELECT suspended_by FROM users WHERE id=?", [uid]);
  const origine = String(l?.suspended_by ?? "");
  if (!ORIGINE_FOURNISSEUR.test(origine)) return { change: false, remplace: null };
  const remplace = await x.run(
    "UPDATE users SET suspended_by=? WHERE id=? AND suspended_by=? AND suspended_at IS NOT NULL AND suspended_at<>0",
    [par, uid, origine],
  );
  if (remplace.changes === 0) return { change: false, remplace: null };
  return { change: true, remplace: origine };
}

/** Pose la suspension et la coupure des sessions dans l'écriture de l'appelant (refusée si elle retire le dernier administrateur local actif, sans écraser une suspension déjà posée) ; vrai si l'état a changé. */
export async function poserSuspension(x: Executeur, uid: number, par: string, t: number): Promise<boolean> {
  return (await poserSuspensionDetaillee(x, uid, par, t)).change;
}

/** Pose la suspension en UNE écriture, puis coupe les accès seulement si l'état a changé ; la suspension d'un administrateur remplace l'origine posée par un fournisseur. */
export async function suspendre(
  dep: DependancesEtat,
  uid: number,
  par: string,
  options: OptionsCoupure = {},
): Promise<BilanSuspension> {
  const t = dep.maintenant();
  const r = await dep.base.ecriture((x) => poserSuspensionDetaillee(x, uid, par, t));
  if (!r.change)
    return { change: false, propage: false, bacArrete: false, tokens: 0, oauth: 0, remplace: null };
  return { change: true, remplace: r.remplace, ...(await couperAcces(dep, uid, options)) };
}

/** Révoque jetons d'API et accès OAuth du compte (sauf `revoquerAcces: false`) puis coupe flux, exécutions et bac (appels réseau : jamais dans une transaction). */
export async function couperAcces(
  dep: DependancesEtat,
  uid: number,
  options: OptionsCoupure = {},
): Promise<Omit<BilanSuspension, "change" | "remplace">> {
  const { tokens, oauth } =
    options.revoquerAcces === false ? { tokens: 0, oauth: 0 } : await revoquerAcces(dep, uid);
  let propage = false;
  try {
    propage = (await dep.publierSuspension(uid)) !== false;
  } catch (e) {
    dep.journal.error({ err: e }, "[admin] publication account_suspended échouée");
  }
  const bacArrete = await detruireBac(dep, uid);
  return { propage, bacArrete, tokens, oauth };
}

/** Jetons d'API et accès OAuth du compte révoqués (au mieux : une panne est journalisée, l'état suspendu les refuse déjà). */
async function revoquerAcces(dep: DependancesEtat, uid: number): Promise<{ tokens: number; oauth: number }> {
  try {
    return await revoquerTousAcces(dep.acces, uid);
  } catch (e) {
    dep.journal.error({ err: e }, "[admin] révocation des accès du compte suspendu échouée");
    return { tokens: 0, oauth: 0 };
  }
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

/** Remet l'état à zéro dans l'écriture de l'appelant et remonte `session_min_ts` à `t` (une session datée pendant la suspension ne revit pas) ; vrai si le compte était suspendu. */
export async function poserReactivation(x: Executeur, uid: number, t: number): Promise<boolean> {
  return (
    (
      await x.run(
        "UPDATE users SET suspended_at=0, suspended_by=NULL, session_min_ts=CASE WHEN session_min_ts IS NULL OR session_min_ts<? THEN ? ELSE session_min_ts END WHERE id=? AND suspended_at IS NOT NULL AND suspended_at<>0",
        [t, t, uid],
      )
    ).changes > 0
  );
}

/** Réactive le compte ; vrai s'il était suspendu. */
export async function reactiver(
  dep: Pick<DependancesEtat, "base"> & { readonly maintenant?: () => number },
  uid: number,
): Promise<boolean> {
  return poserReactivation(dep.base, uid, dep.maintenant?.() ?? Date.now() / 1000);
}
