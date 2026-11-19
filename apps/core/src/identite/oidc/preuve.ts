// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/preuve.ts — étape « preuve du titulaire » d'une première connexion SSO : flux `proof` lié au navigateur (profil vérifié rangé côté serveur) et session ouverte une fois la preuve faite. */
import { randomBytes } from "node:crypto";

import type { Session } from "@elpis/auth";
import type { Base } from "@elpis/db";
import { chiffrerSecret, dechiffrerSecret } from "@elpis/securite";

import { etablirConnexion } from "../../comptes/ouverture";
import type { EffetsConnexion } from "../../comptes/ouverture";
import { lectureOidc } from "../correspondance";
import { appliquerDroits } from "../droits";
import type { Appartenance, DependancesProvisionnement, ProfilIdentite } from "../provisionnement";
import type { FournisseurOidc } from "../reglages";
import { dureeDeSession } from "./connexion";
import { DUREE_FLUX_S, empreinte, empreinteAdresses, noterSessionExterne } from "./flux";
import type { CibleFlux } from "./flux";

export interface FluxPreuve {
  readonly stateHash: string;
  readonly providerId: string;
  readonly prelinkId: number;
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
  /** `sub` du jeton d'identité d'où vient le profil. */
  readonly sub: string;
  /** Identifiant de session du fournisseur et jeton d'identité du retour vérifié ; `null` s'ils manquent. */
  readonly idpSid: string | null;
  readonly idToken: string | null;
  /** Groupes du jeton que le fournisseur lit ; `null` s'ils étaient illisibles. */
  readonly groupes: readonly string[] | null;
  readonly cible: CibleFlux;
  readonly oauthNext: string | null;
}

type LignePreuve = {
  state_hash: string;
  provider_id: string;
  prelink_id: number | null;
  profile_json: string | null;
  target: string;
  oauth_next: string | null;
};

const texte = (v: unknown): v is string => typeof v === "string";

const contexteJeton = (stateHash: string): string => `auth-proof-flow:${stateHash}`;

/** Profil, appartenance, `sub`, `sid` et jeton d'identité (déchiffré) relus du JSON rangé ; `null` si la forme n'est pas exacte. */
function profilDe(
  json: string | null,
  stateHash: string,
): {
  profil: ProfilIdentite;
  appartenance: Appartenance;
  sub: string;
  idpSid: string | null;
  idToken: string | null;
  groupes: string[] | null;
} | null {
  if (json === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const { subject, issuer, extUsername, extEmail, extName, appartenance, sub, idpSid, idTokenEnc, groupes } =
    o;
  if (!texte(subject) || !texte(issuer) || !texte(extUsername) || !texte(extEmail) || !texte(extName))
    return null;
  if (appartenance !== "oui" && appartenance !== "non" && appartenance !== "inconnu") return null;
  let idToken: string | null = null;
  if (texte(idTokenEnc)) {
    try {
      idToken = dechiffrerSecret(idTokenEnc, contexteJeton(stateHash));
    } catch {
      idToken = null;
    }
  }
  return {
    profil: {
      subject,
      issuer,
      extUsername,
      extEmail,
      extName,
      ...(o["identifiantFiable"] === false ? { identifiantFiable: false } : {}),
    },
    appartenance,
    sub: texte(sub) ? sub : subject,
    idpSid: texte(idpSid) ? idpSid : null,
    idToken,
    groupes: Array.isArray(groupes) && groupes.every(texte) ? (groupes as string[]) : null,
  };
}

/** Flux d'étape `proof` du navigateur (état neuf, même empreinte de navigateur, dix minutes) ; un flux `proof` antérieur du même navigateur est remplacé. */
export async function ouvrirFluxPreuve(
  base: Base,
  e: {
    readonly providerId: string;
    readonly secretLiaison: string;
    readonly prelinkId: number;
    readonly profil: ProfilIdentite;
    readonly appartenance: Appartenance;
    readonly sub: string;
    readonly idpSid: string | null;
    readonly idToken: string | null;
    readonly groupes: readonly string[] | null;
    readonly cible: CibleFlux;
    readonly oauthNext: string | null;
    readonly adresse: string;
  },
  maintenant: number,
): Promise<void> {
  const navigateur = empreinte(e.secretLiaison);
  const stateHash = empreinte(randomBytes(32).toString("base64url"));
  let idTokenEnc: string | null = null;
  if (e.idToken !== null) {
    try {
      idTokenEnc = chiffrerSecret(e.idToken, contexteJeton(stateHash));
    } catch {
      idTokenEnc = null;
    }
  }
  await base.ecriture(async (x) => {
    await x.run("DELETE FROM auth_flows WHERE browser_hash=? AND stage='proof'", [navigateur]);
    await x.run(
      "INSERT INTO auth_flows(state_hash, provider_id, browser_hash, ip_hash, nonce, code_verifier, target, oauth_next, trial_admin, stage, prelink_id, profile_json, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        stateHash,
        e.providerId,
        navigateur,
        empreinteAdresses(e.adresse),
        "",
        "",
        e.cible,
        e.oauthNext,
        null,
        "proof",
        e.prelinkId,
        JSON.stringify({
          ...e.profil,
          appartenance: e.appartenance,
          sub: e.sub,
          idpSid: e.idpSid,
          idTokenEnc,
          groupes: e.groupes,
        }),
        maintenant,
        maintenant + DUREE_FLUX_S,
      ],
    );
  });
}

/** Flux `proof` non périmé du navigateur qui porte ce secret de liaison ; `null` sinon. */
export async function lireFluxPreuve(
  base: Base,
  secretLiaison: string,
  maintenant: number,
): Promise<FluxPreuve | null> {
  const l = await base.get<LignePreuve>(
    "SELECT state_hash, provider_id, prelink_id, profile_json, target, oauth_next FROM auth_flows WHERE browser_hash=? AND stage='proof' AND expires_at>? ORDER BY created_at DESC",
    [empreinte(secretLiaison), maintenant],
  );
  if (l === undefined || l.prelink_id === null) return null;
  const p = profilDe(l.profile_json, l.state_hash);
  if (p === null) return null;
  return {
    stateHash: l.state_hash,
    providerId: l.provider_id,
    prelinkId: Number(l.prelink_id),
    ...p,
    cible: l.target === "console" ? "console" : "app",
    oauthNext: l.oauth_next,
  };
}

/** Droits appliqués en baisse seulement (la montée attend la connexion suivante), puis session `oidc:<id>` du compte dont la preuve vient d'aboutir, et ligne de session du fournisseur avec le `sid` et le jeton d'identité du retour vérifié (une session SSO complète). */
export async function ouvrirSessionApresPreuve(
  dep: {
    readonly base: Base;
    readonly provisionnement: DependancesProvisionnement;
    readonly effets: Omit<EffetsConnexion, "dureeMax">;
    readonly dureeGlobale: () => number;
  },
  e: {
    readonly fournisseur: FournisseurOidc;
    readonly uid: number;
    readonly username: string;
    readonly sub: string;
    readonly idpSid: string | null;
    readonly idToken: string | null;
    readonly groupes: readonly string[] | null;
    readonly session: Session;
    readonly maintenant: number;
    readonly ip: string;
    readonly userAgent: string | null;
  },
): Promise<void> {
  await appliquerDroits(dep.provisionnement, {
    fournisseur: e.fournisseur,
    uid: e.uid,
    lecture: lectureOidc(e.fournisseur, e.groupes),
    mode: "passe",
    ip: e.ip,
  });
  await etablirConnexion(
    { ...dep.effets, dureeMax: () => dureeDeSession(e.fournisseur, dep.dureeGlobale()) },
    {
      session: e.session,
      uid: e.uid,
      username: e.username,
      methode: `oidc:${e.fournisseur.id}`,
      ip: e.ip,
      userAgent: e.userAgent,
      avantEffets: async () => {
        const sid = e.session.get("_sid");
        const expire = e.session.get("_exp");
        if (typeof sid !== "string" || typeof expire !== "number")
          throw new Error("session sans identifiant");
        await noterSessionExterne(dep.base, {
          sid,
          uid: e.uid,
          providerId: e.fournisseur.id,
          idpSid: e.idpSid,
          subject: e.sub,
          idToken: e.idToken,
          maintenant: e.maintenant,
          expire,
        });
      },
    },
  );
}
