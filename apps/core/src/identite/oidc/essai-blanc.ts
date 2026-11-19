// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/essai-blanc.ts — essai à blanc d'un fournisseur : revendications d'une liste blanche et décision qui serait prise, rangées pour l'administrateur ; n'importe ni la résolution d'identité ni l'ouverture de session, ne crée aucun compte. */
import { getAllUsers, nomCanonique } from "@elpis/auth";
import type { Executeur } from "@elpis/db";

import { apercuDroits, lectureOidc } from "../correspondance";
import type { ApercuDroits } from "../correspondance";
import { nomDerive } from "../nom";
import type { FournisseurOidc } from "../reglages";
import type { RetourVerifie } from "./echange";
import type { RefusOidc } from "./refus";

export const RAISON_REGLAGES_CHANGES = "settings_changed";

export interface ResultatEssaiBlanc {
  /** Secondes depuis l'époque. */
  readonly at: number;
  /** Le parcours est allé au bout, les groupes se lisent et la décision serait une connexion ou une création. */
  readonly ok: boolean;
  readonly claims: {
    readonly iss: string;
    readonly subject: string;
    readonly identifier: string;
    readonly name: string;
    readonly email: string;
    readonly email_verified: boolean;
    readonly acr: string | null;
    readonly amr: string[];
    /** Au plus 50 ; `null` quand les groupes ne se lisent pas. */
    readonly groups: string[] | null;
  } | null;
  readonly decision: {
    readonly outcome: "login" | "create" | "refuse" | "error";
    readonly username: string | null;
    /** Code de refus ou cause (liste fermée), jamais un message du fournisseur. */
    readonly reason: string | null;
  };
  /** Rôle et groupes Elpis qui seraient donnés (rien n'est écrit) ; `null` quand le parcours n'a pas abouti. */
  readonly rights: ApercuDroits | null;
  readonly warnings: string[];
}

const AVERTISSEMENT_SUJET =
  "Le sujet est égal à l'identifiant : un identifiant réattribué hériterait du compte. Choisissez une autre revendication pour le sujet.";

async function nomPris(x: Executeur, nom: string): Promise<boolean> {
  return (await getAllUsers(x)).some((u) => {
    const autre = String(u.username ?? "").toLowerCase();
    return autre === nom || nomCanonique(autre) === nom;
  });
}

async function decider(
  x: Executeur,
  f: FournisseurOidc,
  r: RetourVerifie,
): Promise<ResultatEssaiBlanc["decision"]> {
  const refuse = (reason: string): ResultatEssaiBlanc["decision"] => ({
    outcome: "refuse",
    username: null,
    reason,
  });
  if (r.appartenance === "inconnu") return refuse("groups_unknown");
  if (r.appartenance === "non") return refuse("not_in_group");
  const connu = await x.get<{ username: string; issuer: string }>(
    "SELECT u.username, i.issuer FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider_id=? AND i.subject=?",
    [f.id, r.profil.subject],
  );
  if (connu !== undefined)
    return connu.issuer === r.profil.issuer
      ? { outcome: "login", username: String(connu.username), reason: null }
      : refuse("issuer_mismatch");
  const nom = nomDerive(r.profil.extUsername);
  if (nom === null) return refuse("name_invalid");
  if (await nomPris(x, nom)) return refuse("account_conflict");
  return { outcome: "create", username: nom, reason: null };
}

/** Résultat d'un essai à blanc : lecture seule de la base, aucun écrit ici. */
export async function resultatEssaiBlanc(
  x: Executeur,
  f: FournisseurOidc,
  r: RetourVerifie,
  maintenant: number,
): Promise<ResultatEssaiBlanc> {
  const warnings: string[] = [];
  if (r.vue.sujetEstIdentifiant) warnings.push(AVERTISSEMENT_SUJET);
  const decision = await decider(x, f, r);
  return {
    at: maintenant,
    ok: r.appartenance !== "inconnu" && (decision.outcome === "login" || decision.outcome === "create"),
    claims: {
      iss: r.vue.iss,
      subject: r.vue.sujet,
      identifier: r.vue.identifiant,
      name: r.vue.nom,
      email: r.vue.email,
      email_verified: r.vue.emailVerifie,
      acr: r.vue.acr,
      amr: r.vue.amr,
      groups: r.vue.groupes,
    },
    decision,
    rights: await apercuDroits(x, f, lectureOidc(f, r.groupesComplets)),
    warnings,
  };
}

/** Résultat d'un essai à blanc qui a échoué : le code de refus, ou `settings_changed` ; rien d'autre. */
export function resultatEssaiEchoue(refus: RefusOidc, maintenant: number): ResultatEssaiBlanc {
  return {
    at: maintenant,
    ok: false,
    claims: null,
    decision: {
      outcome: "error",
      username: null,
      reason: refus.cause_ === RAISON_REGLAGES_CHANGES ? RAISON_REGLAGES_CHANGES : refus.code,
    },
    rights: null,
    warnings: [],
  };
}

/** Dernier résultat rangé pour ce fournisseur (remplace le précédent). */
export async function ranger(
  x: Executeur,
  providerId: string,
  admin: number,
  resultat: ResultatEssaiBlanc,
): Promise<void> {
  await x.run("DELETE FROM auth_trials WHERE provider_id=?", [providerId]);
  await x.run("INSERT INTO auth_trials(provider_id, admin_id, result_json, created_at) VALUES(?,?,?,?)", [
    providerId,
    admin,
    JSON.stringify(resultat),
    resultat.at,
  ]);
}

/** Dernier résultat d'essai à blanc, ou `null`. */
export async function dernierEssai(x: Executeur, providerId: string): Promise<ResultatEssaiBlanc | null> {
  const l = await x.get<{ result_json: string }>("SELECT result_json FROM auth_trials WHERE provider_id=?", [
    providerId,
  ]);
  if (l === undefined) return null;
  try {
    return JSON.parse(l.result_json) as ResultatEssaiBlanc;
  } catch {
    return null;
  }
}
