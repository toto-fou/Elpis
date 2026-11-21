// SPDX-License-Identifier: MIT
/** apps/core/src/identite/provisionnement.ts — profil externe vérifié → compte Elpis, en une écriture exclusive qui applique la décision partagée (`decision.ts`) : identité connue (suspension, réactivation, mise à jour), rattachement dispensé ou compte créé sans mot de passe local ; jamais de rattachement par nom ou e-mail. */
import { createExternalUser, ErreurNomUtilisateur, getUsernameById } from "@elpis/auth";
import type { RaisonRefusCompte } from "@elpis/contracts";
import { ErreurIntegrite } from "@elpis/db";
import { auditEvent } from "@elpis/securite";

import { couperAcces, poserReactivation, poserSuspension } from "../comptes/etat";
import type { DependancesEtat } from "../comptes/etat";
import { deciderIdentite, LIRE_IDENTITE, planIdentiteConnue } from "./decision";
import type { LigneIdentite, Plan } from "./decision";
import {
  auditerRattachement,
  raisonDeRefus,
  rattacher,
  revoquerFlux,
  revoquerOauthRattachement,
  supprimerJetonsDuCompte,
} from "./rattachement";
import { ancreIdentite } from "./ancre";
import type { Fournisseur } from "./reglages";

export type Appartenance = "oui" | "non" | "inconnu";

export interface ProfilIdentite {
  readonly subject: string;
  readonly issuer: string;
  readonly extUsername: string;
  /** Faux si l'identifiant ne peut pas servir à une correspondance (e-mail non vérifié, plus de 255 caractères) ; absent : fiable. */
  readonly identifiantFiable?: boolean;
}

export type Resolution =
  | { readonly type: "compte"; readonly uid: number; readonly cree: boolean }
  | { readonly type: "preuve"; readonly prelinkId: number; readonly uid: number }
  | { readonly type: "refus"; readonly raison: RaisonRefusCompte; readonly uid?: number };

export interface DependancesProvisionnement extends DependancesEtat {
  /** Flux ouverts d'un compte rattaché coupés dans tous les process. */
  readonly revoquer: (uid: number) => Promise<unknown>;
}

interface Effets {
  suspendre: number | null;
  username: string | null;
  rattache: number | null;
  oauthRevoques: number;
}

const refus = (raison: RaisonRefusCompte, uid?: number): Resolution =>
  uid === undefined ? { type: "refus", raison } : { type: "refus", raison, uid };

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

/** Suspension posée par le fournisseur (groupe requis) ; le dernier administrateur local garde son accès (la suspension est alors sans effet). */
async function poserSuspensionDuFournisseur(c: Contexte, uid: number, origine: string): Promise<boolean> {
  try {
    return await poserSuspension(c.dep.base, uid, origine, c.maintenant);
  } catch (e) {
    if ((e as { statusCode?: unknown }).statusCode === 409) return false;
    throw e;
  }
}

/** Rattachement dispensé de preuve d'un simple utilisateur : identité insérée, jetons du compte supprimés. */
async function rattacherSansPreuve(c: Contexte, p: Extract<Plan, { type: "dispense" }>): Promise<Resolution> {
  const { dep, fournisseur, profil, effets } = c;
  const uid = p.uid;
  const par = `prelink:${Number(p.prepare.created_by)}`;
  const obstacle = await rattacher(
    dep.base,
    uid,
    {
      fournisseurId: fournisseur.id,
      subject: profil.subject,
      issuer: ancreIdentite(fournisseur),
      extUsername: profil.extUsername,
    },
    { par, confirmeAdmin: false, t: p.t },
  );
  if (obstacle !== null) return refus(raisonDeRefus(obstacle), uid);
  const tokens = await supprimerJetonsDuCompte(dep.base, uid);
  const nom = await getUsernameById(dep.base, uid);
  effets.username = nom;
  effets.rattache = uid;
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

/** Compte créé sans mot de passe local avec son identité ; une course perdue relit l'identité écrite entre-temps. */
async function creerCompte(c: Contexte, nom: string): Promise<Resolution> {
  const { dep, fournisseur, profil, maintenant, effets } = c;
  try {
    const uid = await dep.base.transaction(async (tx) => {
      const cree = await createExternalUser(dep.base, nom, { maintenant });
      await tx.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, ext_username, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          cree,
          fournisseur.id,
          profil.subject,
          profil.issuer,
          profil.extUsername,
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
    return l ? appliquer(c, planIdentiteConnue(c, l)) : refus("account_conflict");
  }
}

/** Applique la décision dans l'écriture exclusive : suspension ou réactivation, mise à jour de l'identité, rattachement dispensé, création ; rien d'autre n'est décidé ici. */
async function appliquer(c: Contexte, p: Plan): Promise<Resolution> {
  const { dep, fournisseur, profil, maintenant, effets } = c;
  if ((p.type === "refus" || p.type === "connu") && p.ligne !== undefined) effets.username = p.ligne.username;
  switch (p.type) {
    case "refus": {
      const uid = p.uid;
      if (p.suspendre === true && uid !== undefined) {
        const origine = `provider:${fournisseur.id}`;
        if (await poserSuspensionDuFournisseur(c, uid, origine)) {
          await dep.base.run("DELETE FROM auth_ext_sessions WHERE user_id=?", [uid]);
          effets.suspendre = uid;
          c.audits.push(() => auditCompte(c, "auth.account.suspend", uid, p.compte ?? "", origine));
        }
      }
      if (p.oublierPrepare !== undefined)
        await dep.base.run("DELETE FROM auth_prelinks WHERE id=?", [p.oublierPrepare]);
      return refus(p.raison, uid);
    }
    case "connu": {
      const { uid, ligne: l, reactiver } = p;
      if (reactiver !== null && (await poserReactivation(dep.base, uid, maintenant)))
        c.audits.push(() => auditCompte(c, "auth.account.reactivate", uid, l.username, reactiver));
      if (profil.identifiantFiable === false)
        await dep.base.run("UPDATE user_identities SET checked_at=? WHERE id=?", [maintenant, l.id]);
      else
        await dep.base.run("UPDATE user_identities SET ext_username=?, checked_at=? WHERE id=?", [
          profil.extUsername,
          maintenant,
          l.id,
        ]);
      return { type: "compte", uid, cree: false };
    }
    case "preuve":
      return { type: "preuve", prelinkId: p.prelinkId, uid: p.uid };
    case "dispense":
      return rattacherSansPreuve(c, p);
    case "creation":
      return creerCompte(c, p.compte);
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

/** Profil vérifié par le fournisseur → compte, en une écriture exclusive ; coupure des flux et du bac après la validation. */
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
  const effets: Effets = { suspendre: null, username: null, rattache: null, oauthRevoques: 0 };
  const c: Contexte = { dep, ...e, effets, audits: [], ip: e.ip ?? null };
  const r = await dep.base.ecriture(async (x) =>
    appliquer(c, await deciderIdentite(x, { ...e, instant: dep.maintenant })),
  );
  if (effets.rattache !== null) effets.oauthRevoques = await revoquerOauthRattachement(dep, effets.rattache);
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
  if (effets.rattache !== null) await revoquerFlux(dep, effets.rattache);
  return r;
}
