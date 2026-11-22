// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/essai-blanc.ts — essai à blanc d'un fournisseur : revendications d'une liste blanche et décision qui serait prise, celle de la connexion (même preuve d'administrateur, même décision de compte en lecture seule), rangées pour l'administrateur ; n'importe ni la résolution d'identité ni l'ouverture de session, ne crée aucun compte. */
import type { RaisonEssai, ResultatEssaiBlanc } from "@elpis/contracts";
import type { Executeur } from "@elpis/db";

import { adminSansPreuve, apercuDroits } from "../correspondance";
import { deciderIdentite } from "../decision";
import { nomPrisParRattaches } from "../nom";
import type { Fournisseur } from "../reglages";
import type { RetourVerifie } from "./echange";
import type { RefusOidc } from "./refus";

export const RAISON_REGLAGES_CHANGES = "settings_changed";

const AVERTISSEMENT_SUJET =
  "Le sujet est égal à l'identifiant : un identifiant réattribué hériterait du compte. Choisissez une autre revendication pour le sujet.";

type Decision = ResultatEssaiBlanc["decision"];

/** Décision de la connexion pour ce retour, et le compte dont les droits ne pourraient que baisser (preuve du titulaire). */
async function decider(
  x: Executeur,
  f: Fournisseur,
  r: RetourVerifie,
  maintenant: number,
): Promise<{ decision: Decision; retraitDe: number | null }> {
  const issue = (
    outcome: Decision["outcome"],
    username: string | null,
    reason: RaisonEssai | null = null,
  ) => ({
    decision: { outcome, username, reason },
    retraitDe: null,
  });
  if (adminSansPreuve(f, r.groupesComplets, r.secondFacteur)) return issue("refuse", null, "mfa_required");
  const p = await deciderIdentite(x, {
    fournisseur: f,
    profil: r.profil,
    appartenance: r.appartenance,
    maintenant,
    instant: () => maintenant,
  });
  switch (p.type) {
    case "refus": {
      const refus = issue("refuse", p.compte, p.raison);
      if (p.raison !== "account_conflict" || p.compte === null) return refus;
      return {
        ...refus,
        decision: { ...refus.decision, conflict_linked: await nomPrisParRattaches(x, p.compte) },
      };
    }
    case "connu":
      return issue("login", p.compte);
    case "dispense":
      return issue("link", p.compte);
    case "preuve":
      return { ...issue("proof", p.compte), retraitDe: p.uid };
    case "creation":
      return issue("create", p.compte);
  }
}

/** Résultat d'un essai à blanc : lecture seule de la base, aucun écrit ici. */
export async function resultatEssaiBlanc(
  x: Executeur,
  f: Fournisseur,
  r: RetourVerifie,
  maintenant: number,
): Promise<ResultatEssaiBlanc> {
  const warnings: string[] = [];
  if (r.vue.sujetEstIdentifiant) warnings.push(AVERTISSEMENT_SUJET);
  const { decision, retraitDe } = await decider(x, f, r, maintenant);
  const entre = decision.outcome !== "refuse";
  return {
    at: maintenant,
    ok: entre,
    claims: {
      iss: r.vue.iss,
      subject: r.vue.sujet,
      identifier: r.vue.identifiant,
      name: r.vue.nom,
      email: r.vue.email,
      email_verified: r.vue.emailVerifie,
      acr: r.vue.acr,
      amr: r.vue.amr,
      second_factor: r.vue.preuveSecondFacteur,
      groups: r.vue.groupes,
    },
    decision,
    rights: entre ? await apercuDroits(x, f, r.groupesComplets, retraitDe) : null,
    warnings,
  };
}

/** Cause d'un échec rendue à la console : celles qui disent quoi corriger, sinon le code de la connexion. */
const CAUSES: Readonly<Record<string, RaisonEssai>> = {
  [RAISON_REGLAGES_CHANGES]: "settings_changed",
  client_secret_missing: "secret_missing",
  client_auth_rejected: "client_auth_rejected",
  alg_unexpected: "alg_unexpected",
  "lib:OAUTH_KEY_SELECTION_FAILED": "signing_key",
  aud_untrusted: "aud_untrusted",
  azp_mismatch: "token_mismatch",
  iss_mismatch: "token_mismatch",
  iat_in_future: "clock",
  "lib:OAUTH_JWT_TIMESTAMP_CHECK_FAILED": "clock",
  subject_invalid: "subject_invalid",
  id_token_missing: "id_token_missing",
};

/** Raison d'un essai qui n'a pas abouti, d'une liste fermée ; jamais un texte du fournisseur. */
export function raisonDEchec(refus: RefusOidc): RaisonEssai {
  const cause = refus.cause_;
  if (Object.hasOwn(CAUSES, cause)) return CAUSES[cause] ?? refus.code;
  if (cause.startsWith("token_endpoint:")) return "code_rejected";
  return refus.code;
}

/** Résultat d'un essai à blanc qui a échoué : la raison seulement ; un second facteur non prouvé est un refus de la personne, pas une panne. */
export function resultatEssaiEchoue(refus: RefusOidc, maintenant: number): ResultatEssaiBlanc {
  return {
    at: maintenant,
    ok: false,
    claims: null,
    decision: {
      outcome: refus.code === "mfa_required" ? "refuse" : "error",
      username: null,
      reason: raisonDEchec(refus),
    },
    rights: null,
    warnings: [],
  };
}

/** Dernier résultat rangé pour ce fournisseur (remplace le précédent). */
export async function ranger(x: Executeur, providerId: string, resultat: ResultatEssaiBlanc): Promise<void> {
  await x.run(
    "INSERT INTO auth_trials(provider_id, result_json) VALUES(?,?) ON CONFLICT(provider_id) DO UPDATE SET result_json=excluded.result_json",
    [providerId, JSON.stringify(resultat)],
  );
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
