// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/voie-annuaire.ts — voie « annuaire » de la connexion : authentification, compte résolu, audit des refus (un seul 401 côté client, la raison reste au journal d'audit). */
import { ligneUtilisateur } from "@elpis/auth";
import type { MethodeConnexion } from "@elpis/auth";
import { auditLogin, cleAuditCourante, empreinteIdentifiant } from "@elpis/securite";

import { authentifierParAnnuaire } from "../identite/annuaire/connexion";
import type { DependancesAnnuaire } from "../identite/annuaire/connexion";
import { resoudreIdentite } from "../identite/provisionnement";
import type { DependancesProvisionnement } from "../identite/provisionnement";
import type { FournisseurLdap } from "../identite/reglages";

export interface DependancesVoieAnnuaire {
  readonly annuaire: DependancesAnnuaire;
  readonly provisionnement: DependancesProvisionnement;
}

export type IssueAnnuaire =
  | {
      readonly type: "ok";
      readonly uid: number;
      readonly username: string;
      readonly methode: MethodeConnexion;
    }
  | { readonly type: "refus" }
  | { readonly type: "indisponible" };

interface Client {
  readonly ip: string;
  readonly userAgent: string | null;
}

function auditerRefus(
  c: Client,
  e: {
    raison: string;
    fournisseurId: string | null;
    identifiant: string;
    compte?: { uid: number; username: string } | null;
  },
): void {
  const compte = e.compte ?? null;
  auditLogin({
    userId: compte?.uid ?? null,
    username: compte?.username ?? null,
    ip: c.ip,
    userAgent: c.userAgent,
    success: false,
    reason: e.raison,
    ...(e.fournisseurId === null ? {} : { loginMethod: `ldap:${e.fournisseurId}` }),
    ...(compte === null && cleAuditCourante() !== null
      ? { identifierHash: empreinteIdentifiant(e.identifiant) }
      : {}),
  });
}

/** Authentifie auprès des annuaires actifs puis résout le compte ; tout refus est audité ici avec sa raison, jamais le mot de passe ni l'identifiant en clair. */
export async function connecterParAnnuaire(
  dep: DependancesVoieAnnuaire,
  e: {
    identifiant: string;
    motDePasse: string;
    actifs: readonly FournisseurLdap[];
    maintenant: number;
    client: Client;
  },
): Promise<IssueAnnuaire> {
  const { identifiant, client } = e;
  const r = await authentifierParAnnuaire(dep.annuaire, identifiant, e.motDePasse, e.actifs);
  if (r.type === "indisponible") {
    auditerRefus(client, { raison: "directory_unavailable", fournisseurId: null, identifiant });
    return r;
  }
  if (r.type === "absent") {
    auditerRefus(client, { raison: "unknown_user", fournisseurId: null, identifiant });
    return { type: "refus" };
  }
  if (r.type === "refus") {
    auditerRefus(client, { raison: r.raison, fournisseurId: r.fournisseurId, identifiant });
    return { type: "refus" };
  }
  const methode: MethodeConnexion = `ldap:${r.fournisseur.id}`;
  const res = await resoudreIdentite(dep.provisionnement, {
    fournisseur: r.fournisseur,
    profil: r.profil,
    appartenance: r.appartenance,
    maintenant: e.maintenant,
    ip: client.ip,
  });
  if (res.type === "refus") {
    const ligne =
      res.uid === undefined ? undefined : await ligneUtilisateur(dep.provisionnement.base, res.uid);
    auditerRefus(client, {
      raison: res.raison,
      fournisseurId: r.fournisseur.id,
      identifiant,
      compte: ligne && res.uid !== undefined ? { uid: res.uid, username: String(ligne.username) } : null,
    });
    return { type: "refus" };
  }
  if (res.type === "preuve") return { type: "refus" };
  const ligne = await ligneUtilisateur(dep.provisionnement.base, res.uid);
  return { type: "ok", uid: res.uid, username: String(ligne?.username ?? ""), methode };
}
