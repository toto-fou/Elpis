// SPDX-License-Identifier: MIT
/** apps/core/src/identite/provisionnement.ts — profil externe vérifié → compte Elpis, en une écriture exclusive : identité connue (appartenance, suspension, mise à jour) ou compte créé sans mot de passe local ; jamais de rattachement par nom ou e-mail. */
import {
  compteSuspendu,
  createExternalUser,
  ErreurNomUtilisateur,
  getAllUsers,
  nomCanonique,
} from "@elpis/auth";
import { ErreurIntegrite } from "@elpis/db";
import { auditEvent } from "@elpis/securite";

import { couperAcces, poserReactivation, poserSuspension } from "../comptes/etat";
import type { DependancesEtat } from "../comptes/etat";
import { compterAdminsLocaux } from "./etat";
import { nomDerive } from "./nom";
import type { Fournisseur } from "./reglages";

export type Appartenance = "oui" | "non" | "inconnu";

export interface ProfilIdentite {
  readonly subject: string;
  readonly issuer: string;
  readonly extUsername: string;
  readonly extEmail: string;
  readonly extName: string;
}

export type RaisonRefusIdentite =
  | "issuer_mismatch"
  | "groups_unknown"
  | "not_in_group"
  | "suspended"
  | "name_invalid"
  | "account_conflict"
  | "no_local_admin";

export type Resolution =
  | { readonly type: "compte"; readonly uid: number; readonly cree: boolean }
  | { readonly type: "refus"; readonly raison: RaisonRefusIdentite; readonly uid?: number };

export type DependancesProvisionnement = DependancesEtat;

type LigneIdentite = {
  id: number;
  user_id: number;
  issuer: string;
  username: string;
  suspended_at: unknown;
  suspended_by: string | null;
};

interface Effets {
  suspendre: number | null;
  username: string | null;
}

const LIRE_IDENTITE =
  "SELECT i.id, i.user_id, i.issuer, u.username, u.suspended_at, u.suspended_by FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id=? AND i.subject=?";

const refus = (raison: RaisonRefusIdentite, uid?: number): Resolution =>
  uid === undefined ? { type: "refus", raison } : { type: "refus", raison, uid };

/** Compte déjà portant ce nom, casse ignorée et forme canonique comprise. */
async function nomPris(x: DependancesEtat["base"], nom: string): Promise<boolean> {
  return (await getAllUsers(x)).some((u) => {
    const autre = String(u.username ?? "").toLowerCase();
    return autre === nom || nomCanonique(autre) === nom;
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

/** Identité inconnue : le compte est créé ; le rattachement d'un compte existant se branchera ici, avant la création. */
async function creerCompte(c: Contexte): Promise<Resolution> {
  const { dep, fournisseur, profil, appartenance, maintenant, effets } = c;
  if (appartenance === "non") return refus("not_in_group");
  if (appartenance === "inconnu") return refus("groups_unknown");
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
  const effets: Effets = { suspendre: null, username: null };
  const c: Contexte = { dep, ...e, effets, audits: [], ip: e.ip ?? null };
  const r = await dep.base.ecriture(async (x) => {
    const l = await x.get<LigneIdentite>(LIRE_IDENTITE, [e.fournisseur.id, e.profil.subject]);
    return l ? identiteConnue(c, l) : creerCompte(c);
  });
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
  if (effets.suspendre !== null) await couperAcces(dep, effets.suspendre);
  return r;
}
