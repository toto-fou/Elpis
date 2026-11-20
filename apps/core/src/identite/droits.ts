// SPDX-License-Identifier: MIT
/** apps/core/src/identite/droits.ts — application du rôle et des groupes Elpis d'après les groupes du jeton SSO, en une écriture à la connexion, sessions coupées à la rétrogradation, audit des changements. */
import { leverMinSession } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";
import { auditEvent } from "@elpis/securite";

import type { Journal } from "../journal";
import { invaliderAccesRag } from "../rag/acces";
import {
  adminAdmis,
  decider,
  droitsActifs,
  estPlusHaut,
  NIVEAU_DU_ROLE,
  roleDuNiveau,
  rolesActifs,
} from "./correspondance";
import type { RoleElpis } from "./correspondance";
import { dernierAdminLocal } from "./etat";
import { lireReglagesAuth } from "./reglages";
import type { Fournisseur } from "./reglages";

export interface DependancesDroits {
  readonly base: Base;
  /** Secondes. */
  readonly maintenant: () => number;
  readonly journal: Journal;
  /** Flux coupés et exécutions du compte arrêtées, dans tous les process (rétrogradation). */
  readonly publierSuspension: (uid: number) => Promise<unknown>;
}

export interface BilanDroits {
  readonly role: { readonly de: RoleElpis; readonly vers: RoleElpis } | null;
  readonly ajoutes: readonly number[];
  readonly retires: readonly number[];
}

interface EtatDroits {
  readonly l: { is_admin: unknown; username: string };
  readonly existants: ReadonlySet<number>;
  readonly membre: ReadonlySet<number>;
}

const disparus = new WeakMap<Base, Set<string>>();

/** Avertit une fois par base ouverte qu'un groupe cité par un fournisseur n'existe plus. */
function signalerGroupeDisparu(dep: DependancesDroits, fournisseur: string, groupe: number): void {
  const vus = disparus.get(dep.base) ?? new Set<string>();
  disparus.set(dep.base, vus);
  const cle = `${fournisseur}:${groupe}`;
  if (vus.has(cle)) return;
  vus.add(cle);
  dep.journal.warn(`fournisseur ${fournisseur} : le groupe ${groupe} n'existe plus, ignoré`);
}

const RIEN: BilanDroits = { role: null, ajoutes: [], retires: [] };

/** Identifiants des fournisseurs dont l'option des rôles est allumée : le rôle de leurs comptes ne se modifie pas à la main. */
export function fournisseursAuRoleGere(): ReadonlySet<string> {
  return new Set(
    lireReglagesAuth()
      .providers.filter(rolesActifs)
      .map((p) => p.id),
  );
}

const donneAdmin = (f: Fournisseur): boolean => f.roles.enabled && f.roles.admin_groups.length > 0;

const trier = (l: readonly string[]): string[] => [...l].sort();

/** Ce qui fait le sens d'une correspondance d'administrateurs : les groupes et la façon de les lire. */
function sensAdmin(f: Fournisseur): string {
  return JSON.stringify([
    trier(f.roles.admin_groups),
    [f.groups_claim, trier(f.required_acr), trier(f.required_amr)],
  ]);
}

/** 409 si l'enregistrement donne le rôle d'administrateur sans second facteur exigé ou, quand le sens de la correspondance d'administrateurs est nouveau ou changé, sans confirmation explicite. */
export function exigerConfirmationAdmin(
  actuel: Fournisseur | null,
  nouveau: Fournisseur,
  confirme: boolean,
): void {
  if (!donneAdmin(nouveau)) return;
  if (!adminAdmis(nouveau))
    throw new HttpError(
      400,
      "Un groupe d'administrateurs exige que ce fournisseur impose un second facteur : une méthode de possession ou d'inhérence (par exemple « otp »), « mfa » ou « mca » en méthodes (amr), ou un niveau (acr) autre que 0 ou 1.",
    );
  const identique = actuel !== null && donneAdmin(actuel) && sensAdmin(actuel) === sensAdmin(nouveau);
  if (!identique && !confirme)
    throw new HttpError(409, "Confirmez que les membres de ces groupes deviennent administrateurs.");
}

/** Applique les groupes du jeton au compte `uid` rattaché au fournisseur ; `connexion` peut monter et ajouter, `retrait` seulement rétrograder et retirer (première connexion d'un compte rattaché par preuve) ; des groupes illisibles ne changent rien. */
export async function appliquerDroits(
  dep: DependancesDroits,
  e: {
    readonly fournisseur: Fournisseur;
    readonly uid: number;
    /** Groupes du jeton ; `null` : illisibles. */
    readonly groupes: readonly string[] | null;
    readonly mode: "connexion" | "retrait";
    /** Faux : le jeton reçu ne prouve pas de second facteur ; un groupe d'administrateurs reçu ne change alors rien. */
    readonly secondFacteur?: boolean;
    readonly ip?: string | null;
  },
): Promise<BilanDroits> {
  const montee = e.mode === "connexion";
  const f = e.fournisseur;
  if (!droitsActifs(f)) return RIEN;
  if (e.secondFacteur === false) {
    const admins = f.roles.admin_groups.filter((g) => e.groupes?.includes(g) === true);
    if (adminAdmis(f) && admins.length > 0) return RIEN;
  }
  const decision = decider(f, e.groupes);
  if (decision === null) {
    dep.journal.warn(`fournisseur ${f.id} : appartenance illisible, rôle et groupes du compte inchangés`);
    return RIEN;
  }
  const gerees = decision.groupes === null ? [] : [...decision.groupes.keys()];
  const lire = async (x: Executeur): Promise<EtatDroits | null> => {
    const l = await x.get<{ is_admin: unknown; username: string }>(
      "SELECT is_admin, username FROM users WHERE id=?",
      [e.uid],
    );
    if (l === undefined) return null;
    if (decision.groupes === null) return { l, existants: new Set(), membre: new Set() };
    const existants = new Set(
      (
        await x.valeurs<[unknown]>(
          `SELECT id FROM "groups" WHERE id IN (${gerees.map(() => "?").join(",")})`,
          gerees,
        )
      ).map(([g]) => Number(g)),
    );
    const membre = new Set(
      (await x.valeurs<[unknown]>("SELECT group_id FROM user_groups WHERE user_id=?", [e.uid])).map(([g]) =>
        Number(g),
      ),
    );
    return { l, existants, membre };
  };
  const roleVoulu = (l: EtatDroits["l"]): RoleElpis | null => {
    const actuel = roleDuNiveau(Number(l.is_admin));
    const voulu = decision.role;
    return voulu !== null && voulu !== actuel && (montee || !estPlusHaut(voulu, actuel)) ? voulu : null;
  };
  const groupeAChanger = (g: number, doit: boolean, lu: EtatDroits): boolean =>
    lu.existants.has(g) && doit !== lu.membre.has(g) && (doit ? montee : true);
  const vu = await lire(dep.base);
  if (vu === null) return RIEN;
  for (const g of gerees) if (!vu.existants.has(g)) signalerGroupeDisparu(dep, f.id, g);
  if (
    roleVoulu(vu.l) === null &&
    ![...(decision.groupes ?? [])].some(([g, doit]) => groupeAChanger(g, doit, vu))
  )
    return RIEN;
  const t = dep.maintenant();
  const { bilan, nom } = await dep.base.ecriture(async (x) => {
    const lu = await lire(x);
    if (lu === null) return { bilan: RIEN, nom: null };
    const { l } = lu;
    let role: BilanDroits["role"] = null;
    const actuel = roleDuNiveau(Number(l.is_admin));
    const voulu = roleVoulu(l);
    if (voulu !== null) {
      const permis = actuel !== "admin" || voulu === "admin" || !(await dernierAdminLocal(x, e.uid));
      if (permis) {
        const pose = await x.run("UPDATE users SET is_admin=? WHERE id=? AND is_admin=?", [
          NIVEAU_DU_ROLE[voulu],
          e.uid,
          Number(l.is_admin),
        ]);
        if (pose.changes > 0) {
          role = { de: actuel, vers: voulu };
          if (!estPlusHaut(voulu, actuel)) await leverMinSession(x, e.uid, t);
        }
      } else dep.journal.warn(`fournisseur ${f.id} : rétrogradation refusée, dernier administrateur local`);
    }
    const ajoutes: number[] = [];
    const retires: number[] = [];
    if (decision.groupes !== null)
      for (const [g, doit] of decision.groupes) {
        if (!groupeAChanger(g, doit, lu)) continue;
        if (doit) {
          await x.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [e.uid, g]);
          ajoutes.push(g);
        } else {
          await x.run("DELETE FROM user_groups WHERE user_id=? AND group_id=?", [e.uid, g]);
          retires.push(g);
        }
      }
    return { bilan: { role, ajoutes, retires }, nom: String(l.username) };
  });
  if (bilan.role === null && bilan.ajoutes.length === 0 && bilan.retires.length === 0) return bilan;
  invaliderAccesRag(dep.base);
  const base = { target_user_id: e.uid, provider_id: f.id };
  if (bilan.role !== null)
    auditEvent({
      userId: e.uid,
      username: nom,
      action: "auth.role.sync",
      ip: e.ip ?? null,
      details: { ...base, from: bilan.role.de, to: bilan.role.vers },
    });
  if (bilan.ajoutes.length > 0 || bilan.retires.length > 0)
    auditEvent({
      userId: e.uid,
      username: nom,
      action: "auth.groups.sync",
      ip: e.ip ?? null,
      details: { ...base, added: bilan.ajoutes, removed: bilan.retires },
    });
  if (bilan.role !== null && !estPlusHaut(bilan.role.vers, bilan.role.de)) {
    try {
      await dep.publierSuspension(e.uid);
    } catch (err) {
      dep.journal.warn({ err }, `fournisseur ${f.id} : coupure des flux d'un compte rétrogradé non publiée`);
    }
  }
  return bilan;
}
