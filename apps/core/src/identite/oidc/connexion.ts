// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/connexion.ts — connexion SSO réussie côté serveur : profil vérifié → compte (création ou identité connue), session par l'unique voie d'ouverture, ligne de session du fournisseur ; tout refus est un `RefusOidc`. */
import { ligneUtilisateur } from "@elpis/auth";
import type { Session } from "@elpis/auth";
import type { Base } from "@elpis/db";

import { ConnexionRefusee, etablirConnexion } from "../../comptes/ouverture";
import type { EffetsConnexion } from "../../comptes/ouverture";
import { resoudreIdentite } from "../provisionnement";
import type {
  Appartenance,
  DependancesProvisionnement,
  ProfilIdentite,
  Resolution,
} from "../provisionnement";
import type { FournisseurOidc } from "../reglages";
import type { RetourVerifie } from "./echange";
import { noterSessionExterne } from "./flux";
import { RefusOidc } from "./refus";
import type { CodeRefus } from "./refus";

export interface DependancesConnexionOidc {
  readonly base: Base;
  readonly provisionnement: DependancesProvisionnement;
  readonly effets: Omit<EffetsConnexion, "dureeMax">;
  /** Durée de vie globale d'une session, en secondes. */
  readonly dureeGlobale: () => number;
}

const CODE_PAR_RAISON: Readonly<Record<string, CodeRefus>> = {
  not_in_group: "not_in_group",
  groups_unknown: "groups_unknown",
  suspended: "suspended",
  no_local_admin: "unavailable",
};

/** Durée d'une session ouverte par ce fournisseur : la plus courte de la durée globale et de la sienne si elle est réglée. */
export function dureeDeSession(f: FournisseurOidc, globale: number): number {
  return f.session_max_age_sec > 0 ? Math.min(globale, f.session_max_age_sec) : globale;
}

/** Refus du compte : tout résultat autre que `compte` (y compris un résultat que ce code ne connaît pas encore) refuse. */
export function refusDeResolution(res: Resolution): RefusOidc {
  const r: { readonly type: string; readonly raison?: string; readonly uid?: number } = res;
  const raison = r.type === "refus" && r.raison !== undefined ? r.raison : r.type;
  return new RefusOidc(CODE_PAR_RAISON[raison] ?? "conflict", raison, r.uid ?? null);
}

/** Preuve du titulaire à faire avant tout rattachement : aucune session n'est ouverte, le profil vérifié part dans un flux `proof`. */
export interface PreuveAttendue {
  readonly prelinkId: number;
  readonly uid: number;
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
}

/** Ouvre la session du compte du retour vérifié et rend son identifiant, ou rend la preuve attendue d'un compte local à rattacher. */
export async function connecterParOidc(
  dep: DependancesConnexionOidc,
  e: {
    fournisseur: FournisseurOidc;
    retour: RetourVerifie;
    session: Session;
    maintenant: number;
    ip: string;
    userAgent: string | null;
  },
): Promise<number | PreuveAttendue> {
  const f = e.fournisseur;
  const res = await resoudreIdentite(dep.provisionnement, {
    fournisseur: f,
    profil: e.retour.profil,
    appartenance: e.retour.appartenance,
    maintenant: e.maintenant,
    ip: e.ip,
  });
  if (res.type === "preuve")
    return {
      prelinkId: res.prelinkId,
      uid: res.uid,
      profil: e.retour.profil,
      appartenance: e.retour.appartenance,
    };
  if (res.type !== "compte") throw refusDeResolution(res);
  const ligne = await ligneUtilisateur(dep.base, res.uid);
  try {
    await etablirConnexion(
      { ...dep.effets, dureeMax: () => dureeDeSession(f, dep.dureeGlobale()) },
      {
        session: e.session,
        uid: res.uid,
        username: String(ligne?.username ?? ""),
        methode: `oidc:${f.id}`,
        ip: e.ip,
        userAgent: e.userAgent,
      },
    );
  } catch (err) {
    if (err instanceof ConnexionRefusee) throw new RefusOidc("suspended", "account_suspended", res.uid);
    throw err;
  }
  const sid = e.session.get("_sid");
  const expire = e.session.get("_exp");
  try {
    if (typeof sid !== "string" || typeof expire !== "number") throw new Error("session sans identifiant");
    await noterSessionExterne(dep.base, {
      sid,
      uid: res.uid,
      providerId: f.id,
      idpSid: e.retour.idpSid,
      subject: e.retour.profil.subject,
      idToken: e.retour.idToken,
      maintenant: e.maintenant,
      expire,
    });
  } catch {
    e.session.vider();
    throw new RefusOidc("unavailable", "ext_session_write", res.uid);
  }
  return res.uid;
}
