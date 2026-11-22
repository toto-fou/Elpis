// SPDX-License-Identifier: MIT
/** apps/core/src/identite/decision.ts — décision d'une connexion SSO pour un profil vérifié, en lecture seule : la connexion l'applique dans son écriture exclusive, l'essai à blanc la montre sans rien écrire. */
import { compteSuspendu } from "@elpis/auth";
import type { RaisonRefusCompte } from "@elpis/contracts";
import type { Executeur } from "@elpis/db";

import { ancreIdentite } from "./ancre";
import { compterAdminsLocaux, dernierAdminLocal } from "./etat";
import { nomDerive, nomPris } from "./nom";
import type { Appartenance, ProfilIdentite } from "./provisionnement";
import { ligneConvient, obstacleRattachement, raisonDeRefus, rattachementPrepareDe } from "./rattachement";
import type { LigneRattachementPrepare } from "./rattachement";
import type { Fournisseur } from "./reglages";

export type LigneIdentite = {
  id: number;
  user_id: number;
  issuer: string;
  username: string;
  suspended_at: unknown;
  suspended_by: string | null;
};

export const LIRE_IDENTITE =
  "SELECT i.id, i.user_id, i.issuer, u.username, u.suspended_at, u.suspended_by FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id=? AND i.subject=?";

/** Ce que ferait la connexion : `compte` est le nom du compte visé quand il est connu ; `ligne`, l'identité déjà rattachée à ce sujet. */
export type Plan =
  | {
      readonly type: "refus";
      readonly raison: RaisonRefusCompte;
      readonly uid?: number;
      readonly compte: string | null;
      readonly ligne?: LigneIdentite;
      /** Compte sorti des groupes requis : la connexion le suspend. */
      readonly suspendre?: true;
      /** Rattachement préparé que la connexion supprime. */
      readonly oublierPrepare?: number;
    }
  | {
      readonly type: "connu";
      readonly uid: number;
      readonly compte: string;
      readonly ligne: LigneIdentite;
      /** Origine de la suspension que la connexion lève, `null` sans suspension. */
      readonly reactiver: string | null;
    }
  | {
      readonly type: "preuve";
      readonly uid: number;
      readonly compte: string | null;
      readonly prelinkId: number;
    }
  | {
      readonly type: "dispense";
      readonly uid: number;
      readonly compte: string | null;
      readonly prepare: LigneRattachementPrepare;
      readonly t: number;
    }
  | { readonly type: "creation"; readonly compte: string };

export interface EntreeDecision {
  readonly fournisseur: Fournisseur;
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
  readonly maintenant: number;
  /** Heure relue au moment de juger un rattachement préparé. */
  readonly instant: () => number;
}

/** Décision pour l'identité déjà rattachée à ce sujet : émetteur, groupes, suspension. */
export function planIdentiteConnue(
  e: Pick<EntreeDecision, "fournisseur" | "profil" | "appartenance">,
  l: LigneIdentite,
): Plan {
  const uid = Number(l.user_id);
  const refus = (raison: RaisonRefusCompte, suspendre = false): Plan => ({
    type: "refus",
    raison,
    uid,
    compte: l.username,
    ligne: l,
    ...(suspendre ? { suspendre: true as const } : {}),
  });
  if (l.issuer !== e.profil.issuer) return refus("issuer_mismatch");
  if (e.appartenance === "inconnu") return refus("groups_unknown");
  if (e.appartenance === "non") return refus("not_in_group", true);
  let reactiver: string | null = null;
  if (compteSuspendu(l)) {
    const par = String(l.suspended_by);
    if (par !== `provider:${e.fournisseur.id}` && par !== `stale:${e.fournisseur.id}`)
      return refus("suspended");
    reactiver = par;
  }
  return { type: "connu", uid, compte: l.username, ligne: l, reactiver };
}

/** Rattachement préparé pour cet identifiant : preuve du titulaire, ou rattachement dispensé (simple utilisateur seulement). */
async function planPrepare(x: Executeur, e: EntreeDecision, l: LigneRattachementPrepare): Promise<Plan> {
  const f = e.fournisseur;
  const uid = Number(l.user_id);
  const t = e.instant();
  const c = await x.get<{ is_admin: number | null; username: string }>(
    "SELECT is_admin, username FROM users WHERE id=?",
    [uid],
  );
  const compte = c === undefined ? null : String(c.username);
  const refus = (raison: RaisonRefusCompte, oublierPrepare?: number): Plan => ({
    type: "refus",
    raison,
    uid,
    compte,
    ...(oublierPrepare === undefined ? {} : { oublierPrepare }),
  });
  if (!ligneConvient(l, { fournisseurId: f.id, ancre: ancreIdentite(f), profil: e.profil, t }))
    return refus("prelink_invalid");
  const role = Number(c?.is_admin);
  if (Number(l.waiver) !== 1) {
    if (role === 1 && (await dernierAdminLocal(x, uid))) return refus("prelink_invalid");
    return { type: "preuve", uid, compte, prelinkId: Number(l.id) };
  }
  if (role === 1 || role === 2) return refus("prelink_invalid", Number(l.id));
  const obstacle = await obstacleRattachement(
    x,
    uid,
    { fournisseurId: f.id, subject: e.profil.subject },
    false,
  );
  if (obstacle !== null) return refus(raisonDeRefus(obstacle));
  return { type: "dispense", uid, compte, prepare: l, t };
}

/** Décision pour un sujet sans identité : rattachement préparé d'abord, sinon création ; jamais de rattachement par nom ou e-mail. */
async function planIdentiteNouvelle(x: Executeur, e: EntreeDecision): Promise<Plan> {
  const refus = (raison: RaisonRefusCompte, compte: string | null = null): Plan => ({
    type: "refus",
    raison,
    compte,
  });
  if (e.appartenance === "non") return refus("not_in_group");
  if (e.appartenance === "inconnu") return refus("groups_unknown");
  const prepare = await rattachementPrepareDe(x, e.fournisseur.id, e.profil.extUsername, e.maintenant);
  if (prepare !== undefined) return planPrepare(x, e, prepare);
  if (e.profil.identifiantFiable === false) return refus("name_invalid");
  const nom = nomDerive(e.profil.extUsername);
  if (nom === null) return refus("name_invalid");
  if (await nomPris(x, nom)) return refus("account_conflict", nom);
  if ((await compterAdminsLocaux(x)) === 0) return refus("no_local_admin");
  return { type: "creation", compte: nom };
}

/** Décision de la connexion pour ce profil vérifié, en lecture seule (aucune écriture, aucun effet). */
export async function deciderIdentite(x: Executeur, e: EntreeDecision): Promise<Plan> {
  const l = await x.get<LigneIdentite>(LIRE_IDENTITE, [e.fournisseur.id, e.profil.subject]);
  return l ? planIdentiteConnue(e, l) : planIdentiteNouvelle(x, e);
}
