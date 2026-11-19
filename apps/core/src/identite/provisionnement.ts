// SPDX-License-Identifier: MIT
/** apps/core/src/identite/provisionnement.ts — profil externe vérifié → compte Elpis, en une écriture exclusive : identité connue (appartenance, suspension, mise à jour) ou compte créé sans mot de passe local ; jamais de rattachement par nom ou e-mail. */
import {
  compteSuspendu,
  createExternalUser,
  ErreurNomUtilisateur,
  getAllUsers,
  getUsernameById,
  nomCanonique,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { ErreurIntegrite } from "@elpis/db";
import { auditEvent } from "@elpis/securite";

import { couperAcces, poserReactivation, poserSuspension } from "../comptes/etat";
import type { DependancesEtat } from "../comptes/etat";
import { compterAdminsLocaux, exigerAdminLocal } from "./etat";
import { nomDerive } from "./nom";
import {
  auditerRattachement,
  ligneConvient,
  raisonDeRefus,
  rattacher,
  rattachementPrepareDe,
  revoquerFlux,
  revoquerOauthRattachement,
  supprimerJetonsDuCompte,
} from "./rattachement";
import type { LigneRattachementPrepare } from "./rattachement";
import { ancreIdentite } from "./ancre";
import type { Fournisseur } from "./reglages";

export type Appartenance = "oui" | "non" | "inconnu";

export interface ProfilIdentite {
  readonly subject: string;
  readonly issuer: string;
  readonly extUsername: string;
  readonly extEmail: string;
  readonly extName: string;
  /** Faux si l'identifiant ne peut pas servir à une correspondance (e-mail non vérifié, plus de 255 caractères) ; absent : fiable. */
  readonly identifiantFiable?: boolean;
}

export type RaisonRefusIdentite =
  | "issuer_mismatch"
  | "groups_unknown"
  | "not_in_group"
  | "suspended"
  | "name_invalid"
  | "account_conflict"
  | "no_local_admin"
  | "prelink_invalid";

export type Resolution =
  | { readonly type: "compte"; readonly uid: number; readonly cree: boolean }
  | { readonly type: "preuve"; readonly prelinkId: number; readonly uid: number }
  | { readonly type: "refus"; readonly raison: RaisonRefusIdentite; readonly uid?: number };

export interface DependancesProvisionnement extends DependancesEtat {
  /** Flux ouverts d'un compte rattaché coupés dans tous les process. */
  readonly revoquer: (uid: number) => Promise<unknown>;
}

type LigneIdentite = {
  id: number;
  user_id: number;
  issuer: string;
  username: string;
  suspended_at: unknown;
  suspended_by: string | null;
};

type LignePrepare = LigneRattachementPrepare;

interface Effets {
  suspendre: number | null;
  revoquer: number | null;
  username: string | null;
  oauth: number | null;
  oauthRevoques: number;
}

const LIRE_IDENTITE =
  "SELECT i.id, i.user_id, i.issuer, u.username, u.suspended_at, u.suspended_by FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id=? AND i.subject=?";

const refus = (raison: RaisonRefusIdentite, uid?: number): Resolution =>
  uid === undefined ? { type: "refus", raison } : { type: "refus", raison, uid };

/** Forme comparée des noms : casse ignorée, toute suite de `.`, `-`, `_` vaut un seul `-`. */
const cleHomonyme = (nom: string): string => nom.toLowerCase().replace(/[._-]+/gu, "-");

/** Compte déjà portant ce nom, à la casse et aux séparateurs `.`, `-`, `_` près, forme canonique comprise. */
async function nomPris(x: DependancesEtat["base"], nom: string): Promise<boolean> {
  const cle = cleHomonyme(nom);
  return (await getAllUsers(x)).some((u) => {
    const autre = String(u.username ?? "");
    return cleHomonyme(autre) === cle || cleHomonyme(nomCanonique(autre)) === cle;
  });
}

type Contexte = {
  readonly dep: DependancesProvisionnement;
  readonly fournisseur: Fournisseur;
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
  readonly maintenant: number;
  readonly effets: Effets;
  readonly audits: (() => void)[];
  readonly ip: string | null;
};

async function identiteConnue(c: Contexte, l: LigneIdentite): Promise<Resolution> {
  const { dep, fournisseur, profil, appartenance, maintenant, effets } = c;
  const uid = Number(l.user_id);
  effets.username = l.username;
  if (l.issuer !== profil.issuer) return refus("issuer_mismatch", uid);
  if (appartenance === "inconnu") return refus("groups_unknown", uid);
  const origine = `directory:${fournisseur.id}`;
  if (appartenance === "non") {
    if (await poserSuspensionDeLAnnuaire(c, uid, origine)) {
      await dep.base.run("DELETE FROM auth_ext_sessions WHERE user_id=?", [uid]);
      effets.suspendre = uid;
      c.audits.push(() => auditCompte(c, "auth.account.suspend", uid, l.username, origine));
    }
    return refus("not_in_group", uid);
  }
  if (compteSuspendu(l)) {
    const par = l.suspended_by;
    if (par !== origine && par !== `stale:${fournisseur.id}`) return refus("suspended", uid);
    if (await poserReactivation(dep.base, uid, maintenant))
      c.audits.push(() => auditCompte(c, "auth.account.reactivate", uid, l.username, String(par)));
  }
  await dep.base.run(
    "UPDATE user_identities SET ext_username=?, ext_email=?, ext_name=?, checked_at=? WHERE id=?",
    [profil.extUsername, profil.extEmail, profil.extName, maintenant, l.id],
  );
  return { type: "compte", uid, cree: false };
}

/** Suspension posée par l'annuaire ; le dernier administrateur local garde son accès (la suspension est alors sans effet). */
async function poserSuspensionDeLAnnuaire(c: Contexte, uid: number, origine: string): Promise<boolean> {
  try {
    return await poserSuspension(c.dep.base, uid, origine, c.maintenant);
  } catch (e) {
    if ((e as { statusCode?: unknown }).statusCode === 409) return false;
    throw e;
  }
}

/** Vrai si ce compte est le dernier administrateur local actif : sa preuve ne pourrait jamais aboutir. */
async function dernierAdminLocal(x: DependancesEtat["base"], uid: number): Promise<boolean> {
  try {
    await exigerAdminLocal(x, { sauf: uid });
    return false;
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 409) return true;
    throw e;
  }
}

/** Rattachement préparé d'un fournisseur OIDC pour cette identité inconnue : preuve à faire, ou rattachement tout de suite si la preuve est dispensée (simple utilisateur seulement) ; jamais de compte créé. */
async function rattachementPrepare(c: Contexte, l: LignePrepare): Promise<Resolution> {
  const { dep, fournisseur, profil, effets } = c;
  const uid = Number(l.user_id);
  const ancre = ancreIdentite(fournisseur);
  const t = dep.maintenant();
  if (!ligneConvient(l, { fournisseurId: fournisseur.id, ancre, profil, t }))
    return refus("prelink_invalid", uid);
  const role = Number(
    (await dep.base.get<{ is_admin: number | null }>("SELECT is_admin FROM users WHERE id=?", [uid]))
      ?.is_admin,
  );
  if (Number(l.waiver) !== 1) {
    if (role === 1 && (await dernierAdminLocal(dep.base, uid))) return refus("prelink_invalid", uid);
    return { type: "preuve", prelinkId: Number(l.id), uid };
  }
  if (role === 1 || role === 2) {
    await dep.base.run("DELETE FROM auth_prelinks WHERE id=?", [l.id]);
    return refus("prelink_invalid", uid);
  }
  const par = `prelink:${Number(l.created_by)}`;
  const obstacle = await rattacher(
    dep.base,
    uid,
    {
      fournisseurId: fournisseur.id,
      subject: profil.subject,
      issuer: ancre,
      extUsername: profil.extUsername,
      extEmail: profil.extEmail,
      extName: profil.extName,
    },
    { par, confirmeAdmin: false, t },
  );
  if (obstacle !== null)
    return refus(raisonDeRefus(obstacle), obstacle === "account_not_found" ? undefined : uid);
  const tokens = await supprimerJetonsDuCompte(dep.base, uid);
  const nom = await getUsernameById(dep.base, uid);
  effets.username = nom;
  effets.revoquer = uid;
  effets.oauth = uid;
  c.audits.push(() =>
    auditerRattachement(
      {
        uid,
        username: nom,
        fournisseurId: fournisseur.id,
        par,
        methode: "waiver",
        subject: profil.subject,
        identifiantRecu: profil.extUsername,
        jetons: { tokens, oauth: effets.oauthRevoques },
      },
      c.ip,
    ),
  );
  return { type: "compte", uid, cree: false };
}

/** Identité inconnue : un rattachement préparé (OIDC) décide d'abord, sinon le compte est créé ; jamais de rattachement par nom ou e-mail. */
async function creerCompte(c: Contexte): Promise<Resolution> {
  const { dep, fournisseur, profil, appartenance, maintenant, effets } = c;
  if (appartenance === "non") return refus("not_in_group");
  if (appartenance === "inconnu") return refus("groups_unknown");
  if (fournisseur.type === "oidc") {
    const prepare = await rattachementPrepareDe(dep.base, fournisseur.id, profil.extUsername, maintenant);
    if (prepare !== undefined) return rattachementPrepare(c, prepare);
  }
  const nom = nomDerive(profil.extUsername);
  if (nom === null) return refus("name_invalid");
  if (await nomPris(dep.base, nom)) return refus("account_conflict");
  if ((await compterAdminsLocaux(dep.base)) === 0) return refus("no_local_admin");
  try {
    const uid = await dep.base.transaction(async (tx) => {
      const cree = await createExternalUser(dep.base, nom, { maintenant });
      await tx.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, ext_username, ext_email, ext_name, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [
          cree,
          fournisseur.id,
          profil.subject,
          profil.issuer,
          profil.extUsername,
          profil.extEmail,
          profil.extName,
          "auto",
          maintenant,
          maintenant,
        ],
      );
      return cree;
    });
    effets.username = nom;
    c.audits.push(() => auditCompte(c, "auth.identity.create", uid, nom, null));
    return { type: "compte", uid, cree: true };
  } catch (e) {
    if (e instanceof ErreurNomUtilisateur) return refus("account_conflict");
    if (!(e instanceof ErreurIntegrite)) throw e;
    const l = await dep.base.get<LigneIdentite>(LIRE_IDENTITE, [fournisseur.id, profil.subject]);
    return l ? identiteConnue(c, l) : refus("account_conflict");
  }
}

function auditCompte(
  c: Contexte,
  action: string,
  uid: number,
  username: string,
  origine: string | null,
): void {
  const details: Record<string, unknown> = { target_user_id: uid, provider_id: c.fournisseur.id };
  if (action === "auth.identity.create") details["linked_by"] = "auto";
  else details["origin"] = origine;
  auditEvent({ userId: uid, username, action, ip: c.ip, details });
}

/** Profil vérifié par l'annuaire → compte, en une écriture exclusive ; coupure des flux et du bac après la validation. */
export async function resoudreIdentite(
  dep: DependancesProvisionnement,
  e: {
    readonly fournisseur: Fournisseur;
    readonly profil: ProfilIdentite;
    readonly appartenance: Appartenance;
    readonly maintenant: number;
    readonly ip?: string | null;
  },
): Promise<Resolution> {
  const effets: Effets = { suspendre: null, revoquer: null, username: null, oauth: null, oauthRevoques: 0 };
  const c: Contexte = { dep, ...e, effets, audits: [], ip: e.ip ?? null };
  const r = await dep.base.ecriture(async (x) => {
    const l = await x.get<LigneIdentite>(LIRE_IDENTITE, [e.fournisseur.id, e.profil.subject]);
    return l ? identiteConnue(c, l) : creerCompte(c);
  });
  if (effets.oauth !== null) effets.oauthRevoques = await revoquerOauthRattachement(dep, effets.oauth);
  for (const audit of c.audits) audit();
  if (r.type === "refus")
    auditEvent({
      userId: r.uid ?? null,
      username: effets.username,
      action: "auth.identity.refused",
      ip: c.ip,
      outcome: "failure",
      details: { provider_id: e.fournisseur.id, reason: r.raison },
    });
  if (effets.suspendre !== null)
    couperAcces(dep, effets.suspendre, { revoquerAcces: false }).catch((e: unknown) =>
      dep.journal.error({ err: e }, "[auth] coupure d'accès du compte sorti du groupe échouée"),
    );
  if (effets.revoquer !== null) await revoquerFlux(dep, effets.revoquer);
  return r;
}
