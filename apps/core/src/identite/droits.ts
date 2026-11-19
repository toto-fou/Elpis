// SPDX-License-Identifier: MIT
/** apps/core/src/identite/droits.ts — application du rôle et des groupes Elpis d'après l'annuaire ou le SSO, en une écriture : montée à la connexion seulement, rétrogradation et retrait aussi par la passe, sessions coupées à la rétrogradation, audit des changements. */
import { leverMinSession } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { Base } from "@elpis/db";
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
} from "./correspondance";
import type { Lecture, RoleElpis } from "./correspondance";
import { exigerAdminLocal } from "./etat";
import { lireReglagesAuth } from "./reglages";
import type { Fournisseur } from "./reglages";

export interface DependancesDroits {
  readonly base: Base;
  /** Secondes. */
  readonly maintenant: () => number;
  readonly journal: Journal;
  /** Flux ouverts du compte coupés dans tous les process. */
  readonly revoquer?: (uid: number) => Promise<unknown>;
  /** Flux coupés et exécutions du compte arrêtées (préféré à `revoquer` pour une rétrogradation). */
  readonly publierSuspension?: (uid: number) => Promise<unknown>;
}

export interface BilanDroits {
  readonly role: { readonly de: RoleElpis; readonly vers: RoleElpis } | null;
  readonly ajoutes: readonly number[];
  readonly retires: readonly number[];
}

const RIEN: BilanDroits = { role: null, ajoutes: [], retires: [] };

/** Identifiants des fournisseurs dont l'option des rôles est allumée : le rôle de leurs comptes ne se modifie pas à la main. */
export function fournisseursAuRoleGere(): ReadonlySet<string> {
  return new Set(
    lireReglagesAuth()
      .providers.filter((p) => p.roles.enabled)
      .map((p) => p.id),
  );
}

const donneAdmin = (f: Fournisseur): boolean => f.roles.enabled && f.roles.admin_groups.length > 0;

const trier = (l: readonly string[]): string[] => [...l].sort();

/** Ce qui fait le sens d'une correspondance d'administrateurs : les groupes et la façon de les lire. */
function sensAdmin(f: Fournisseur): string {
  const lecture =
    f.type === "ldap" ? [f.groups.mode] : [f.groups_claim, trier(f.required_acr), trier(f.required_amr)];
  return JSON.stringify([trier(f.roles.admin_groups), lecture]);
}

/** 409 si l'enregistrement donne le rôle d'administrateur sans second facteur exigé (SSO) ou, quand le sens de la correspondance d'administrateurs est nouveau ou changé, sans confirmation explicite. */
export function exigerConfirmationAdmin(
  actuel: Fournisseur | null,
  nouveau: Fournisseur,
  confirme: boolean,
): void {
  if (!donneAdmin(nouveau)) return;
  if (!adminAdmis(nouveau))
    throw new HttpError(
      409,
      "Un groupe d'administrateurs exige que ce fournisseur impose un second facteur.",
    );
  const identique = actuel !== null && donneAdmin(actuel) && sensAdmin(actuel) === sensAdmin(nouveau);
  if (!identique && !confirme)
    throw new HttpError(409, "Confirmez que les membres de ces groupes deviennent administrateurs.");
}

/** Applique la lecture au compte `uid` rattaché au fournisseur ; `connexion` peut monter et ajouter, `passe` seulement rétrograder et retirer ; une lecture absente ou incomplète ne change rien. */
export async function appliquerDroits(
  dep: DependancesDroits,
  e: {
    readonly fournisseur: Fournisseur;
    readonly uid: number;
    readonly lecture: Lecture | null;
    readonly mode: "connexion" | "passe";
    readonly ip?: string | null;
  },
): Promise<BilanDroits> {
  const f = e.fournisseur;
  if (!droitsActifs(f) || e.lecture === null) return RIEN;
  const decision = decider(f, e.lecture);
  if (decision === null) {
    dep.journal.warn(`fournisseur ${f.id} : appartenance illisible, rôle et groupes du compte inchangés`);
    return RIEN;
  }
  const montee = e.mode === "connexion";
  const t = dep.maintenant();
  const { bilan, nom } = await dep.base.ecriture(async (x) => {
    const l = await x.get<{ is_admin: unknown; username: string }>(
      "SELECT is_admin, username FROM users WHERE id=?",
      [e.uid],
    );
    if (l === undefined) return { bilan: RIEN, nom: null };
    let role: BilanDroits["role"] = null;
    const actuel = roleDuNiveau(Number(l.is_admin));
    const voulu = decision.role;
    if (voulu !== null && voulu !== actuel && (montee || !estPlusHaut(voulu, actuel))) {
      let permis = true;
      if (actuel === "admin" && voulu !== "admin") {
        try {
          await exigerAdminLocal(x, { sauf: e.uid });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          permis = false;
        }
      }
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
    if (decision.groupes !== null) {
      const gerees = [...decision.groupes.keys()];
      const existants = new Set(
        (
          await x.valeurs<[unknown]>(
            `SELECT id FROM "groups" WHERE id IN (${gerees.map(() => "?").join(",")})`,
            gerees,
          )
        ).map(([g]) => Number(g)),
      );
      for (const g of gerees)
        if (!existants.has(g)) dep.journal.warn(`fournisseur ${f.id} : le groupe ${g} n'existe plus, ignoré`);
      const membre = new Set(
        (await x.valeurs<[unknown]>("SELECT group_id FROM user_groups WHERE user_id=?", [e.uid])).map(([g]) =>
          Number(g),
        ),
      );
      for (const [g, doit] of decision.groupes) {
        if (!existants.has(g) || doit === membre.has(g)) continue;
        if (doit) {
          if (!montee) continue;
          await x.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [e.uid, g]);
          ajoutes.push(g);
        } else {
          await x.run("DELETE FROM user_groups WHERE user_id=? AND group_id=?", [e.uid, g]);
          retires.push(g);
        }
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
      await (dep.publierSuspension ?? dep.revoquer)?.(e.uid);
    } catch (err) {
      dep.journal.warn({ err }, `fournisseur ${f.id} : coupure des flux d'un compte rétrogradé non publiée`);
    }
  }
  return bilan;
}
