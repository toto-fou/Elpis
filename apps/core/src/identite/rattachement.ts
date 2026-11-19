// SPDX-License-Identifier: MIT
/** apps/core/src/identite/rattachement.ts — rattachement d'un compte local à une identité externe : contrôles du compte, écriture unique (identité, mot de passe retiré, sessions coupées), détachement, rattachements préparés et leur consommation. */
import {
  leverMinSession,
  MARQUEUR_SANS_MOT_DE_PASSE,
  resetUserPassword,
  revoquerTousAcces,
  verifyUser,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Executeur } from "@elpis/db";
import { auditEvent, empreinteIdentifiant, tokenHex } from "@elpis/securite";

import { ancreIdentite } from "./ancre";
import { exigerAdminLocal } from "./etat";
import type { Appartenance, DependancesProvisionnement, ProfilIdentite, Resolution } from "./provisionnement";
import type { FournisseurOidc } from "./reglages";

/** Durée de validité d'un rattachement préparé avec preuve. */
export const DUREE_RATTACHEMENT_PREPARE_S = 30 * 86_400;
/** Durée de validité d'un rattachement préparé dispensé de preuve. */
export const DUREE_RATTACHEMENT_DISPENSE_S = 72 * 3600;
/** Échecs de mot de passe tolérés sur une ligne préparée avant qu'elle soit supprimée. */
export const ECHECS_PREUVE_MAX = 5;
const FORME_ATTENDU = /^[a-z0-9._@-]{1,256}$/u;
const FORME_RECU = /^[A-Za-z0-9._@-]{1,256}$/u;

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
  issuer: string;
  admin_confirmed: number;
  attempts: number;
};

const COLONNES_PREPARE =
  "id, user_id, provider_id, expected, waiver, created_by, created_at, expires_at, issuer, admin_confirmed, attempts";

const minusculesAscii = (t: string): string => t.replace(/[A-Z]/gu, (c) => c.toLowerCase());

/** Identifiant attendu à la création : minuscules ASCII, `[a-z0-9._@-]{1,256}` ; `null` sinon. */
export function attenduValide(brut: unknown): string | null {
  if (typeof brut !== "string") return null;
  const n = minusculesAscii(brut);
  return FORME_ATTENDU.test(n) ? n : null;
}

/** Forme comparée d'un identifiant reçu du fournisseur : `[A-Za-z0-9._@-]{1,256}` en minuscules ASCII ; `null` pour tout autre identifiant (aucune correspondance). */
export function attenduDeRecu(recu: string): string | null {
  return typeof recu === "string" && FORME_RECU.test(recu) ? minusculesAscii(recu) : null;
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
  const role = Number(c.is_admin);
  if (role !== 1 && role !== 2) return null;
  if (!confirmeAdmin) return "admin_confirmation_required";
  if (role !== 1) return null;
  try {
    await exigerAdminLocal(x, { sauf: uid });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 409) return "last_local_admin";
    throw e;
  }
  return null;
}

/** Rattache le compte dans l'écriture de l'appelant (`t` pris dans cette écriture) : refus sans rien écrire, ou identité insérée, mot de passe local retiré, rattachements préparés du compte supprimés, sessions d'avant coupées. */
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
  await x.run("DELETE FROM auth_prelinks WHERE user_id=?", [uid]);
  await leverMinSession(x, uid, o.t);
  return null;
}

/** Jetons d'API du compte supprimés dans l'écriture de l'appelant ; rend leur nombre. */
export async function supprimerJetonsDuCompte(x: Executeur, uid: number): Promise<number> {
  return (await x.run("DELETE FROM tool_tokens WHERE user_id=?", [uid])).changes;
}

/** Accès OAuth du compte révoqués après l'écriture (au mieux : une panne est journalisée) ; rend leur nombre. */
export async function revoquerOauthRattachement(
  dep: Pick<DependancesProvisionnement, "acces" | "journal">,
  uid: number,
): Promise<number> {
  try {
    return (await revoquerTousAcces(dep.acces, uid)).oauth;
  } catch (e) {
    dep.journal.error({ err: e }, "[identite] révocation des accès OAuth (rattachement) échouée");
    return 0;
  }
}

/** Ligne d'audit d'un rattachement réussi (l'auteur est l'opérateur, ou le compte lui-même quand personne n'a agi) ; `methode` : `assistant`, `proof` ou `waiver`. */
export function auditerRattachement(
  e: {
    readonly uid: number;
    readonly username: string | null;
    readonly fournisseurId: string;
    readonly par: string;
    readonly methode: "assistant" | "proof" | "waiver";
    readonly subject: string;
    readonly identifiantRecu?: string;
    readonly acteur?: { id: number; username: string | null } | null;
    readonly jetons?: { readonly tokens: number; readonly oauth: number } | "kept";
  },
  ip: string | null,
): void {
  auditEvent({
    userId: e.acteur?.id ?? e.uid,
    username: e.acteur === undefined || e.acteur === null ? e.username : e.acteur.username,
    action: "auth.identity.link",
    ip,
    details: {
      target_user_id: e.uid,
      provider_id: e.fournisseurId,
      by: e.par,
      method: e.methode,
      subject: e.subject,
      ...(e.identifiantRecu === undefined
        ? {}
        : { identifier_hash: empreinteIdentifiant(e.identifiantRecu) }),
      ...(e.jetons === undefined
        ? {}
        : e.jetons === "kept"
          ? { kept: true }
          : { revoked_tokens: e.jetons.tokens, revoked_oauth: e.jetons.oauth }),
    },
  });
}

/** Détache le compte dans l'écriture de l'appelant (`t` pris dans cette écriture) : identité retirée, jetons d'API supprimés, mot de passe temporaire posé (à changer), sessions d'avant coupées ; `null` si le compte n'avait pas d'identité. */
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
  await supprimerJetonsDuCompte(x, uid);
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
    readonly ancre: string;
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
  const role = Number(c.is_admin);
  const privilegie = role === 1 || role === 2;
  if (privilegie) {
    if (e.dispense) return { raison: "waiver_forbidden_for_admin" };
    if (!e.confirmeAdmin) return { raison: "admin_confirmation_required" };
  }
  if (role === 1)
    try {
      await exigerAdminLocal(x, { sauf: e.uid });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) return { raison: "last_local_admin" };
      throw err;
    }
  const duree = e.dispense ? DUREE_RATTACHEMENT_DISPENSE_S : DUREE_RATTACHEMENT_PREPARE_S;
  const id = await x.insertId(
    "INSERT INTO auth_prelinks(user_id, provider_id, expected, waiver, created_by, created_at, expires_at, issuer, admin_confirmed, attempts) VALUES(?,?,?,?,?,?,?,?,?,0)",
    [
      e.uid,
      e.fournisseurId,
      e.attendu,
      e.dispense ? 1 : 0,
      e.par,
      e.t,
      e.t + duree,
      e.ancre,
      privilegie && e.confirmeAdmin ? 1 : 0,
    ],
  );
  return { id };
}

/** Rattachement préparé non périmé qui attend cet identifiant externe chez ce fournisseur ; aucun si l'identifiant reçu sort de l'alphabet sûr. */
export async function rattachementPrepareDe(
  x: Executeur,
  fournisseurId: string,
  identifiantExterne: string,
  t: number,
): Promise<LigneRattachementPrepare | undefined> {
  const attendu = attenduDeRecu(identifiantExterne);
  if (attendu === null) return undefined;
  return x.get<LigneRattachementPrepare>(
    `SELECT ${COLONNES_PREPARE} FROM auth_prelinks WHERE provider_id=? AND expected=? AND expires_at>?`,
    [fournisseurId, attendu, t],
  );
}

type Refus = Extract<Resolution, { type: "refus" }>;

const refus = (raison: Refus["raison"], uid?: number): Resolution =>
  uid === undefined ? { type: "refus", raison } : { type: "refus", raison, uid };

/** Raison de refus d'identité d'un obstacle de rattachement. */
export function raisonDeRefus(r: RaisonRefusRattachement): Refus["raison"] {
  if (r === "account_suspended") return "suspended";
  if (r === "last_local_admin") return "no_local_admin";
  if (r === "admin_confirmation_required") return "prelink_invalid";
  return "account_conflict";
}

/** Vrai si la ligne préparée est celle de ce fournisseur, de cette ancre et de cet identifiant (égalité stricte), non périmée. */
export function ligneConvient(
  l: LigneRattachementPrepare,
  e: { fournisseurId: string; ancre: string; profil: ProfilIdentite; t: number },
): boolean {
  const attendu = attenduDeRecu(e.profil.extUsername);
  return (
    attendu !== null &&
    attendu === l.expected &&
    Number(l.expires_at) > e.t &&
    l.provider_id === e.fournisseurId &&
    l.issuer === e.ancre &&
    e.profil.issuer === e.ancre &&
    e.profil.subject !== ""
  );
}

export type ResultatPreuve = Resolution | { readonly type: "mot_de_passe"; readonly verrouille: boolean };

export interface EntreePreuve {
  readonly fournisseur: FournisseurOidc;
  readonly prelinkId: number;
  readonly profil: ProfilIdentite;
  readonly appartenance: Appartenance;
  readonly motDePasse: string;
  readonly ip: string | null;
}

type SnapshotCompte = { username: string; pass_hash: string; pass_salt: string; is_admin: number | null };

/** Ligne préparée et compte relus, contrôlés ; refus sinon. */
async function lireEtControler(
  x: Executeur,
  e: EntreePreuve,
  ancre: string,
  t: number,
): Promise<{ ligne: LigneRattachementPrepare; compte: SnapshotCompte } | Resolution> {
  const l = await x.get<LigneRattachementPrepare>(
    `SELECT ${COLONNES_PREPARE} FROM auth_prelinks WHERE id=?`,
    [e.prelinkId],
  );
  if (l === undefined || !ligneConvient(l, { fournisseurId: e.fournisseur.id, ancre, profil: e.profil, t }))
    return refus("prelink_invalid");
  const uid = Number(l.user_id);
  const c = await x.get<SnapshotCompte & { suspended_at: unknown }>(
    "SELECT username, pass_hash, pass_salt, is_admin, suspended_at FROM users WHERE id=?",
    [uid],
  );
  if (c === undefined) return refus("prelink_invalid");
  if (c.suspended_at !== null && c.suspended_at !== undefined && Number(c.suspended_at) !== 0)
    return refus("suspended", uid);
  if ((await x.get("SELECT 1 AS un FROM user_identities WHERE user_id=?", [uid])) !== undefined)
    return refus("account_conflict", uid);
  const role = Number(c.is_admin);
  if ((role === 1 || role === 2) && Number(l.admin_confirmed) !== 1) return refus("prelink_invalid", uid);
  return { ligne: l, compte: c };
}

/** Échec de mot de passe compté sur la ligne préparée ; à `ECHECS_PREUVE_MAX` la ligne et ses flux sont supprimés. */
async function compterEchec(
  dep: DependancesProvisionnement,
  e: EntreePreuve,
  uid: number,
  nom: string,
): Promise<boolean> {
  const verrouille = await dep.base.ecriture(async (x) => {
    const r = await x.run("UPDATE auth_prelinks SET attempts=attempts+1 WHERE id=?", [e.prelinkId]);
    if (r.changes === 0) return false;
    const l = await x.get<{ attempts: number }>("SELECT attempts FROM auth_prelinks WHERE id=?", [
      e.prelinkId,
    ]);
    if (Number(l?.attempts ?? 0) < ECHECS_PREUVE_MAX) return false;
    await x.run("DELETE FROM auth_prelinks WHERE id=?", [e.prelinkId]);
    await x.run("DELETE FROM auth_flows WHERE prelink_id=?", [e.prelinkId]);
    return true;
  });
  auditEvent({
    userId: uid,
    username: nom,
    action: verrouille ? "auth.prelink.locked" : "auth.identity.link.denied",
    ip: e.ip,
    outcome: "failure",
    details: { target_user_id: uid, provider_id: e.fournisseur.id, reason: "bad_password" },
  });
  return verrouille;
}

/** Seule voie de consommation d'un rattachement préparé avec preuve : lit la ligne et son compte, vérifie l'ancien mot de passe du compte DE LA LIGNE hors verrou, puis dans l'écriture revérifie la ligne, que le mot de passe n'a pas changé, écrit l'identité et supprime la ligne ; jetons et accès gardés. */
export async function prouverEtRattacher(
  dep: DependancesProvisionnement,
  e: EntreePreuve,
): Promise<ResultatPreuve> {
  if (e.appartenance === "non") return refus("not_in_group");
  if (e.appartenance !== "oui") return refus("groups_unknown");
  const ancre = ancreIdentite(e.fournisseur);
  const lu = await lireEtControler(dep.base, e, ancre, dep.maintenant());
  if ("type" in lu) return lu;
  const uid = Number(lu.ligne.user_id);
  const nom = lu.compte.username;
  const prouve = typeof e.motDePasse === "string" && (await verifyUser(dep.base, nom, e.motDePasse)) === uid;
  if (!prouve) return { type: "mot_de_passe", verrouille: await compterEchec(dep, e, uid, nom) };
  const effets: { audit: (() => void) | null } = { audit: null };
  const r = await dep.base.ecriture(async (x) => {
    const t = dep.maintenant();
    const relu = await lireEtControler(x, e, ancre, t);
    if ("type" in relu) return relu;
    if (
      relu.ligne.user_id !== lu.ligne.user_id ||
      relu.compte.pass_hash !== lu.compte.pass_hash ||
      relu.compte.pass_salt !== lu.compte.pass_salt
    )
      return refus("prelink_invalid", uid);
    const obstacle = await rattacher(
      x,
      uid,
      {
        fournisseurId: e.fournisseur.id,
        subject: e.profil.subject,
        issuer: ancre,
        extUsername: e.profil.extUsername,
        extEmail: e.profil.extEmail,
        extName: e.profil.extName,
      },
      { par: "proof", confirmeAdmin: Number(relu.ligne.admin_confirmed) === 1, t },
    );
    if (obstacle !== null)
      return refus(raisonDeRefus(obstacle), obstacle === "account_not_found" ? undefined : uid);
    await x.run("DELETE FROM auth_flows WHERE prelink_id=?", [e.prelinkId]);
    effets.audit = () =>
      auditerRattachement(
        {
          uid,
          username: nom,
          fournisseurId: e.fournisseur.id,
          par: `prelink:${Number(relu.ligne.created_by)}`,
          methode: "proof",
          subject: e.profil.subject,
          identifiantRecu: e.profil.extUsername,
          jetons: "kept",
        },
        e.ip,
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
  try {
    await dep.revoquer(uid);
  } catch (e) {
    dep.journal.error({ err: e }, "[identite] publication session_revoked (rattachement) échouée");
  }
}
