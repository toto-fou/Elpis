// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/preuve.ts — étape « preuve du titulaire » d'une première connexion SSO : flux `proof` lié au navigateur, profil vérifié rangé côté serveur. */
import { randomBytes } from "node:crypto";

import type { Base } from "@elpis/db";
import { chiffrerSecret, dechiffrerSecret } from "@elpis/securite";

import type { Appartenance, ProfilIdentite } from "../provisionnement";
import { DUREE_FLUX_S, empreinte, empreinteAdresses } from "./flux";
import type { CibleFlux } from "./flux";

export interface FluxPreuve {
  readonly stateHash: string;
  readonly providerId: string;
  readonly prelinkId: number;
  /** Nom du compte visé par le rattachement préparé. */
  readonly username: string;
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
  /** `sub` du jeton d'identité d'où vient le profil. */
  readonly sub: string;
  /** Identifiant de session du fournisseur et jeton d'identité du retour vérifié ; `null` s'ils manquent. */
  readonly idpSid: string | null;
  readonly idToken: string | null;
  /** Groupes du jeton que le fournisseur lit ; `null` s'ils étaient illisibles. */
  readonly groupes: readonly string[] | null;
  /** Le jeton du retour prouvait un second facteur. */
  readonly secondFacteur: boolean;
  readonly cible: CibleFlux;
  readonly oauthNext: string | null;
}

type LignePreuve = {
  state_hash: string;
  provider_id: string;
  prelink_id: number | null;
  username: string;
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
): Pick<
  FluxPreuve,
  "profil" | "appartenance" | "sub" | "idpSid" | "idToken" | "groupes" | "secondFacteur"
> | null {
  if (json === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const { subject, issuer, extUsername, appartenance, sub, idpSid, idTokenEnc, groupes } = o;
  if (!texte(subject) || !texte(issuer) || !texte(extUsername)) return null;
  if (!texte(sub)) return null;
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
      ...(o["identifiantFiable"] === false ? { identifiantFiable: false } : {}),
    },
    appartenance,
    sub,
    idpSid: texte(idpSid) ? idpSid : null,
    idToken,
    groupes: Array.isArray(groupes) && groupes.every(texte) ? (groupes as string[]) : null,
    secondFacteur: o["secondFacteur"] === true,
  };
}

/** Flux d'étape `proof` du navigateur (état neuf, même empreinte de navigateur, dix minutes) ; un flux `proof` antérieur du même navigateur est remplacé. */
export async function ouvrirFluxPreuve(
  base: Base,
  e: Omit<FluxPreuve, "stateHash" | "username"> & {
    readonly secretLiaison: string;
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
          secondFacteur: e.secondFacteur,
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
    "SELECT f.state_hash, f.provider_id, f.prelink_id, f.profile_json, f.target, f.oauth_next, u.username FROM auth_flows f JOIN auth_prelinks p ON p.id=f.prelink_id JOIN users u ON u.id=p.user_id WHERE f.browser_hash=? AND f.stage='proof' AND f.expires_at>? ORDER BY f.created_at DESC",
    [empreinte(secretLiaison), maintenant],
  );
  if (l === undefined || l.prelink_id === null) return null;
  const p = profilDe(l.profile_json, l.state_hash);
  if (p === null) return null;
  return {
    stateHash: l.state_hash,
    providerId: l.provider_id,
    prelinkId: Number(l.prelink_id),
    username: l.username,
    ...p,
    cible: l.target === "console" ? "console" : "app",
    oauthNext: l.oauth_next,
  };
}
