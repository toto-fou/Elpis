// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/connexion.ts — connexion SSO réussie côté serveur : profil vérifié → compte (création ou identité connue), session par l'unique voie d'ouverture, ligne de session du fournisseur ; tout refus est un `RefusOidc`. */
import { ligneUtilisateur } from "@elpis/auth";
import type { Session } from "@elpis/auth";
import type { CodeErreurConnexion } from "@elpis/contracts";
import type { Base } from "@elpis/db";

import { ConnexionRefusee, etablirConnexion } from "../../comptes/ouverture";
import type { EffetsConnexion } from "../../comptes/ouverture";
import { adminSansPreuve } from "../correspondance";
import { appliquerDroits } from "../droits";
import { resoudreIdentite } from "../provisionnement";
import type { DependancesProvisionnement, Resolution } from "../provisionnement";
import type { Fournisseur } from "../reglages";
import type { RetourVerifie } from "./echange";
import { noterSessionExterne } from "./flux";
import { RefusOidc } from "./refus";

export interface DependancesConnexionOidc {
  readonly base: Base;
  readonly provisionnement: DependancesProvisionnement;
  readonly effets: Omit<EffetsConnexion, "dureeMax">;
  /** Durée de vie globale d'une session, en secondes. */
  readonly dureeGlobale: () => number;
}

const CODE_PAR_RAISON: Readonly<Record<string, CodeErreurConnexion>> = {
  not_in_group: "not_in_group",
  groups_unknown: "groups_unknown",
  suspended: "suspended",
  no_local_admin: "unavailable",
};

/** Durée d'une session ouverte par ce fournisseur : la plus courte de la durée globale et de la sienne si elle est réglée. */
export function dureeDeSession(f: Fournisseur, globale: number): number {
  return f.session_max_age_sec > 0 ? Math.min(globale, f.session_max_age_sec) : globale;
}

/** Refus du compte : tout résultat autre que `compte` (y compris un résultat que ce code ne connaît pas encore) refuse. */
export function refusDeResolution(res: Resolution): RefusOidc {
  const r: { readonly type: string; readonly raison?: string; readonly uid?: number } = res;
  const raison = r.type === "refus" && r.raison !== undefined ? r.raison : r.type;
  return new RefusOidc(CODE_PAR_RAISON[raison] ?? "conflict", raison, r.uid ?? null);
}

/** Droits appliqués (`connexion` : montée et ajouts permis ; `retrait` : baisse seulement), puis session `oidc:<id>` du compte et ligne de session du fournisseur avec le `sid` et le jeton d'identité du retour vérifié. */
export async function ouvrirSessionOidc(
  dep: DependancesConnexionOidc,
  e: {
    readonly fournisseur: Fournisseur;
    readonly uid: number;
    readonly username: string;
    readonly mode: "connexion" | "retrait";
    readonly sub: string;
    readonly idpSid: string | null;
    readonly idToken: string | null;
    readonly groupes: readonly string[] | null;
    readonly secondFacteur: boolean;
    readonly session: Session;
    readonly ip: string;
    readonly userAgent: string | null;
  },
): Promise<void> {
  const f = e.fournisseur;
  await appliquerDroits(dep.provisionnement, {
    fournisseur: f,
    uid: e.uid,
    groupes: e.groupes,
    mode: e.mode,
    secondFacteur: e.secondFacteur,
    ip: e.ip,
  });
  await etablirConnexion(
    { ...dep.effets, dureeMax: () => dureeDeSession(f, dep.dureeGlobale()) },
    {
      session: e.session,
      uid: e.uid,
      username: e.username,
      methode: `oidc:${f.id}`,
      ip: e.ip,
      userAgent: e.userAgent,
      avantEffets: async () => {
        const sid = e.session.get("_sid");
        const expire = e.session.get("_exp");
        try {
          if (typeof sid !== "string" || typeof expire !== "number")
            throw new Error("session sans identifiant");
          await noterSessionExterne(dep.base, {
            sid,
            uid: e.uid,
            providerId: f.id,
            idpSid: e.idpSid,
            subject: e.sub,
            idToken: e.idToken,
            expire,
            avertir: (m) => dep.provisionnement.journal.warn(m),
          });
        } catch {
          throw new RefusOidc("unavailable", "ext_session_write", e.uid);
        }
      },
    },
  );
}

/** Ouvre la session du compte du retour vérifié et rend son identifiant, ou rend le rattachement préparé dont la preuve du titulaire est attendue. */
export async function connecterParOidc(
  dep: DependancesConnexionOidc,
  e: {
    fournisseur: Fournisseur;
    retour: RetourVerifie;
    session: Session;
    maintenant: number;
    ip: string;
    userAgent: string | null;
  },
): Promise<number | { readonly prelinkId: number }> {
  const f = e.fournisseur;
  if (adminSansPreuve(f, e.retour.groupesComplets, e.retour.secondFacteur))
    throw new RefusOidc("mfa_required", "admin_without_mfa");
  const res = await resoudreIdentite(dep.provisionnement, {
    fournisseur: f,
    profil: e.retour.profil,
    appartenance: e.retour.appartenance,
    maintenant: e.maintenant,
    ip: e.ip,
  });
  if (res.type === "preuve") return { prelinkId: res.prelinkId };
  if (res.type !== "compte") throw refusDeResolution(res);
  const ligne = await ligneUtilisateur(dep.base, res.uid);
  try {
    await ouvrirSessionOidc(dep, {
      fournisseur: f,
      uid: res.uid,
      username: String(ligne?.username ?? ""),
      mode: "connexion",
      sub: e.retour.sub,
      idpSid: e.retour.idpSid,
      idToken: e.retour.idToken,
      groupes: e.retour.groupesComplets,
      secondFacteur: e.retour.secondFacteur,
      session: e.session,
      ip: e.ip,
      userAgent: e.userAgent,
    });
  } catch (err) {
    if (err instanceof ConnexionRefusee) throw new RefusOidc("suspended", "account_suspended", res.uid);
    throw err;
  }
  return res.uid;
}
