// SPDX-License-Identifier: MIT
/** apps/core/src/identite/rattachement.ts — rattachement d'un compte local à une identité externe : contrôles du compte, écriture unique (identité, mot de passe retiré, sessions coupées), détachement, rattachements préparés et leur consommation. */
import { leverMinSession, MARQUEUR_SANS_MOT_DE_PASSE, resetUserPassword } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { auditEvent, tokenHex } from "@elpis/securite";

import { exigerAdminLocal } from "./etat";
import type { DependancesProvisionnement, ProfilIdentite, Resolution } from "./provisionnement";

/** Durée de validité d'un rattachement préparé. */
export const DUREE_RATTACHEMENT_PREPARE_S = 30 * 86_400;
const ATTENDU_MAX = 256;

export type RaisonRefusRattachement =
  | "account_not_found"
  | "account_has_identity"
  | "account_suspended"
  | "admin_confirmation_required"
  | "last_local_admin"
  | "entry_already_linked";

export interface IdentiteARattacher {
  readonly fournisseurId: string;
  readonly subject: string;
  readonly issuer: string;
  readonly extUsername: string;
  readonly extEmail: string;
  readonly extName: string;
}

export type LigneRattachementPrepare = {
  id: number;
  user_id: number;
  provider_id: string;
  expected: string;
  waiver: number;
  created_by: number;
  created_at: number;
  expires_at: number;
};

/** Forme comparée des identifiants attendus : NFKC puis minuscules. */
export function normaliserAttendu(brut: string): string {
  return brut.normalize("NFKC").toLowerCase();
}

/** Identifiant attendu valide (texte bien formé, 1 à 256 caractères, sans caractère de contrôle), normalisé ; `null` sinon. */
export function attenduValide(brut: unknown): string | null {
  if (typeof brut !== "string" || !brut.isWellFormed() || /\p{Cc}/u.test(brut)) return null;
  const n = normaliserAttendu(brut);
  return n.trim() === n && n.length >= 1 && n.length <= ATTENDU_MAX ? n : null;
}

type LigneCompte = { is_admin: number | null; suspended_at: unknown };

/** Premier obstacle à rattacher ce compte (relu dans l'écriture en cours), `null` si rien ne s'y oppose. */
async function obstacleCompte(
  x: Executeur,
  uid: number,
  confirmeAdmin: boolean,
): Promise<RaisonRefusRattachement | null> {
  const c = await x.get<LigneCompte>("SELECT is_admin, suspended_at FROM users WHERE id=?", [uid]);
  if (c === undefined) return "account_not_found";
  if ((await x.get("SELECT 1 AS un FROM user_identities WHERE user_id=?", [uid])) !== undefined)
    return "account_has_identity";
  if (c.suspended_at !== null && c.suspended_at !== undefined && Number(c.suspended_at) !== 0)
    return "account_suspended";
  if (Number(c.is_admin) !== 1) return null;
  if (!confirmeAdmin) return "admin_confirmation_required";
  try {
    await exigerAdminLocal(x, { sauf: uid });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 409) return "last_local_admin";
    throw e;
  }
  return null;
}

/** Rattache le compte dans l'écriture de l'appelant : refus sans rien écrire, ou identité insérée, mot de passe local retiré, sessions d'avant coupées. */
export async function rattacher(
  x: Executeur,
  uid: number,
  i: IdentiteARattacher,
  o: { readonly par: string; readonly confirmeAdmin: boolean; readonly t: number },
): Promise<RaisonRefusRattachement | null> {
  const obstacle = await obstacleCompte(x, uid, o.confirmeAdmin);
  if (obstacle !== null) return obstacle;
  if (
    (await x.get("SELECT 1 AS un FROM user_identities WHERE provider_id=? AND subject=?", [
      i.fournisseurId,
      i.subject,
    ])) !== undefined
  )
    return "entry_already_linked";
  await x.run(
    "INSERT INTO user_identities(user_id, provider_id, subject, issuer, ext_username, ext_email, ext_name, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [uid, i.fournisseurId, i.subject, i.issuer, i.extUsername, i.extEmail, i.extName, o.par, o.t, o.t],
  );
  await x.run("UPDATE users SET pass_hash=?, pass_salt=?, must_change_pwd=0 WHERE id=?", [
    MARQUEUR_SANS_MOT_DE_PASSE,
    tokenHex(16),
    uid,
  ]);
  await leverMinSession(x, uid, o.t);
  return null;
}

/** Ligne d'audit d'un rattachement réussi (l'auteur est l'opérateur, ou le compte lui-même quand personne n'a agi). */
export function auditerRattachement(
  e: {
    readonly uid: number;
    readonly username: string | null;
    readonly fournisseurId: string;
    readonly par: string;
    readonly acteur?: { id: number; username: string | null } | null;
  },
  ip: string | null,
): void {
  auditEvent({
    userId: e.acteur?.id ?? e.uid,
    username: e.acteur === undefined || e.acteur === null ? e.username : e.acteur.username,
    action: "auth.identity.link",
    ip,
    details: { target_user_id: e.uid, provider_id: e.fournisseurId, by: e.par },
  });
}

/** Détache le compte dans l'écriture de l'appelant : identité retirée, mot de passe temporaire posé (à changer), sessions d'avant coupées ; `null` si le compte n'avait pas d'identité. */
export async function detacher(
  x: Executeur,
  uid: number,
  motDePasse: string,
  t: number,
): Promise<{ fournisseurId: string } | null> {
  const l = await x.get<{ provider_id: string }>("SELECT provider_id FROM user_identities WHERE user_id=?", [
    uid,
  ]);
  if (l === undefined) return null;
  await x.run("DELETE FROM user_identities WHERE user_id=?", [uid]);
  await resetUserPassword(x, uid, motDePasse, { detacher: true });
  await x.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [uid]);
  await leverMinSession(x, uid, t);
  return { fournisseurId: String(l.provider_id) };
}

/** Lignes périmées supprimées. */
export async function purgerRattachementsPerimes(x: Executeur, t: number): Promise<number> {
  return (await x.run("DELETE FROM auth_prelinks WHERE expires_at<=?", [t])).changes;
}

export type RaisonRefusPrepare =
  | "account_not_found"
  | "account_has_identity"
  | "prelink_exists"
  | "expected_taken"
  | "waiver_forbidden_for_admin"
  | "admin_confirmation_required"
  | "last_local_admin";

/** Rattachement préparé posé dans l'écriture de l'appelant ; refus sans rien écrire sinon. */
export async function preparerRattachement(
  x: Executeur,
  e: {
    readonly uid: number;
    readonly fournisseurId: string;
    readonly attendu: string;
    readonly dispense: boolean;
    readonly confirmeAdmin: boolean;
    readonly par: number;
    readonly t: number;
  },
): Promise<{ id: number } | { raison: RaisonRefusPrepare }> {
  const c = await x.get<LigneCompte>("SELECT is_admin, suspended_at FROM users WHERE id=?", [e.uid]);
  if (c === undefined) return { raison: "account_not_found" };
  if ((await x.get("SELECT 1 AS un FROM user_identities WHERE user_id=?", [e.uid])) !== undefined)
    return { raison: "account_has_identity" };
  await purgerRattachementsPerimes(x, e.t);
  if ((await x.get("SELECT 1 AS un FROM auth_prelinks WHERE user_id=?", [e.uid])) !== undefined)
    return { raison: "prelink_exists" };
  if (
    (await x.get("SELECT 1 AS un FROM auth_prelinks WHERE provider_id=? AND expected=?", [
      e.fournisseurId,
      e.attendu,
    ])) !== undefined
  )
    return { raison: "expected_taken" };
  if (Number(c.is_admin) === 1) {
    if (e.dispense) return { raison: "waiver_forbidden_for_admin" };
    if (!e.confirmeAdmin) return { raison: "admin_confirmation_required" };
    try {
      await exigerAdminLocal(x, { sauf: e.uid });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) return { raison: "last_local_admin" };
      throw err;
    }
  }
  const id = await x.insertId(
    "INSERT INTO auth_prelinks(user_id, provider_id, expected, waiver, created_by, created_at, expires_at) VALUES(?,?,?,?,?,?,?)",
    [e.uid, e.fournisseurId, e.attendu, e.dispense ? 1 : 0, e.par, e.t, e.t + DUREE_RATTACHEMENT_PREPARE_S],
  );
  return { id };
}

/** Rattachement préparé non périmé qui attend cet identifiant externe chez ce fournisseur. */
export async function rattachementPrepareDe(
  x: Executeur,
  fournisseurId: string,
  identifiantExterne: string,
  t: number,
): Promise<LigneRattachementPrepare | undefined> {
  return x.get<LigneRattachementPrepare>(
    "SELECT id, user_id, provider_id, expected, waiver, created_by, created_at, expires_at FROM auth_prelinks WHERE provider_id=? AND expected=? AND expires_at>?",
    [fournisseurId, normaliserAttendu(identifiantExterne), t],
  );
}

const refus = (raison: Extract<Resolution, { type: "refus" }>["raison"], uid?: number): Resolution =>
  uid === undefined ? { type: "refus", raison } : { type: "refus", raison, uid };

/** Raison de refus d'identité d'un obstacle de rattachement. */
export function raisonDeRefus(r: RaisonRefusRattachement): Extract<Resolution, { type: "refus" }>["raison"] {
  if (r === "account_suspended") return "suspended";
  if (r === "last_local_admin") return "no_local_admin";
  if (r === "admin_confirmation_required") return "prelink_invalid";
  return "account_conflict";
}

/** Rattache le compte visé par un rattachement préparé, preuve du titulaire déjà faite par l'appelant : la ligne est relue dans la transaction (présente, non périmée, identifiant attendu égal), l'identité écrite et la ligne supprimée ; refus sans rien écrire sinon. */
export async function consommerRattachement(
  dep: DependancesProvisionnement,
  prelinkId: number,
  profil: ProfilIdentite,
  o: { readonly fournisseurId?: string; readonly ip?: string | null } = {},
): Promise<Resolution> {
  const t = dep.maintenant();
  const effets: { audit: (() => void) | null } = { audit: null };
  const r = await dep.base.ecriture(async (x) => {
    const l = await x.get<LigneRattachementPrepare>(
      "SELECT id, user_id, provider_id, expected, waiver, created_by, created_at, expires_at FROM auth_prelinks WHERE id=?",
      [prelinkId],
    );
    if (
      l === undefined ||
      Number(l.expires_at) <= t ||
      (o.fournisseurId !== undefined && o.fournisseurId !== l.provider_id) ||
      profil.subject === "" ||
      profil.issuer === "" ||
      normaliserAttendu(profil.extUsername) !== l.expected
    )
      return refus("prelink_invalid");
    const uid = Number(l.user_id);
    const par = `prelink:${Number(l.created_by)}`;
    const obstacle = await rattacher(
      x,
      uid,
      {
        fournisseurId: String(l.provider_id),
        subject: profil.subject,
        issuer: profil.issuer,
        extUsername: profil.extUsername,
        extEmail: profil.extEmail,
        extName: profil.extName,
      },
      { par, confirmeAdmin: true, t },
    );
    if (obstacle !== null)
      return refus(raisonDeRefus(obstacle), obstacle === "account_not_found" ? undefined : uid);
    await x.run("DELETE FROM auth_prelinks WHERE id=?", [prelinkId]);
    const nom = await x.get<{ username: string }>("SELECT username FROM users WHERE id=?", [uid]);
    effets.audit = () =>
      auditerRattachement(
        { uid, username: nom?.username ?? null, fournisseurId: String(l.provider_id), par },
        o.ip ?? null,
      );
    return { type: "compte", uid, cree: false } satisfies Resolution;
  });
  effets.audit?.();
  if (r.type === "compte") await revoquerFlux(dep, r.uid);
  return r;
}

/** Flux ouverts du compte coupés (au mieux : une panne est journalisée, `session_min_ts` refuse déjà les sessions d'avant). */
export async function revoquerFlux(
  dep: Pick<DependancesProvisionnement, "revoquer" | "journal">,
  uid: number,
): Promise<void> {
  if (dep.revoquer === undefined) return;
  try {
    await dep.revoquer(uid);
  } catch (e) {
    dep.journal.error({ err: e }, "[identite] publication session_revoked (rattachement) échouée");
  }
}
