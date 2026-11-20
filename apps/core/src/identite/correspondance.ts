// SPDX-License-Identifier: MIT
/** apps/core/src/identite/correspondance.ts — correspondance exacte groupes d'annuaire → rôle et groupes Elpis, en lecture seule : une appartenance illisible n'est jamais un « non » et suspend toute décision. */
import type { Executeur } from "@elpis/db";

import type { Appartenance } from "./provisionnement";
import type { Fournisseur } from "./reglages";

export type RoleElpis = "user" | "moderator" | "admin";

/** Appartenance lue de chaque groupe externe de la correspondance, par sa valeur exacte (DN complet ou valeur de la revendication). */
export type Lecture = ReadonlyMap<string, Appartenance>;

export interface Decision {
  /** `null` : l'option des rôles est éteinte ou sans groupe utilisable. */
  readonly role: RoleElpis | null;
  /** Par groupe Elpis cité dans la correspondance : le compte doit-il en être membre ; `null` si l'option est éteinte. */
  readonly groupes: ReadonlyMap<number, boolean> | null;
}

export const NIVEAU_DU_ROLE: Readonly<Record<RoleElpis, number>> = { user: 0, admin: 1, moderator: 2 };
const RANG: Readonly<Record<RoleElpis, number>> = { user: 0, moderator: 1, admin: 2 };

/** Rôle d'un niveau `is_admin` (1 administrateur, 2 modérateur, tout autre : utilisateur). */
export function roleDuNiveau(niveau: number): RoleElpis {
  return niveau === 1 ? "admin" : niveau === 2 ? "moderator" : "user";
}

/** Vrai si `a` est un rôle plus élevé que `b` (utilisateur < modérateur < administrateur). */
export function estPlusHaut(a: RoleElpis, b: RoleElpis): boolean {
  return RANG[a] > RANG[b];
}

const ACR_FAIBLES: ReadonlySet<string> = new Set(["0", "1"]);

/** Les groupes d'administrateurs ne comptent en SSO que si le fournisseur exige `mfa` / `mca` seuls en `amr`, ou un `acr` sans niveau faible ; un annuaire est confirmé à l'enregistrement. */
export function adminAdmis(f: Fournisseur): boolean {
  if (f.type === "ldap") return true;
  const amr = f.required_amr.map((m) => m.trim().toLowerCase());
  return (
    (amr.length > 0 && amr.every((m) => m === "mfa" || m === "mca")) ||
    (f.required_acr.length > 0 && f.required_acr.every((a) => !ACR_FAIBLES.has(a.trim())))
  );
}

function groupesDeRoles(f: Fournisseur): { admin: readonly string[]; moderateur: readonly string[] } {
  return {
    admin: adminAdmis(f) ? f.roles.admin_groups : [],
    moderateur: f.roles.moderator_groups,
  };
}

/** Vrai si les groupes du jeton contiennent un groupe d'administrateurs agissant alors que le jeton ne prouve pas de second facteur. */
export function adminSansPreuve(f: Fournisseur, groupes: readonly string[] | null, prouve: boolean): boolean {
  if (prouve || groupes === null || !rolesActifs(f)) return false;
  return groupesDeRoles(f).admin.some((g) => groupes.includes(g));
}

/** L'option des rôles agit : allumée et avec au moins un groupe utilisable (sinon elle rétrograderait tout le monde). */
export function rolesActifs(f: Fournisseur): boolean {
  const g = groupesDeRoles(f);
  return f.roles.enabled && g.admin.length + g.moderateur.length > 0;
}

/** L'option des groupes agit : allumée et avec au moins une correspondance. */
export function groupesActifs(f: Fournisseur): boolean {
  return f.group_map.enabled && f.group_map.map.length > 0;
}

/** Une des deux options agit : sinon rien n'est lu ni écrit. */
export function droitsActifs(f: Fournisseur): boolean {
  return rolesActifs(f) || groupesActifs(f);
}

/** Valeurs externes dont l'appartenance se lit, sans doublon. */
export function groupesALire(f: Fournisseur): string[] {
  const vus = new Set<string>();
  if (rolesActifs(f)) {
    const g = groupesDeRoles(f);
    for (const v of [...g.admin, ...g.moderateur]) vus.add(v);
  }
  if (groupesActifs(f)) for (const m of f.group_map.map) vus.add(m.external);
  return [...vus];
}

/** Lecture d'un jeton SSO : valeur exacte de la revendication ; `null` (groupes illisibles) rend tout « inconnu ». */
export function lectureOidc(f: Fournisseur, groupes: readonly string[] | null): Lecture {
  return new Map(
    groupesALire(f).map((g): [string, Appartenance] => [
      g,
      groupes === null ? "inconnu" : groupes.includes(g) ? "oui" : "non",
    ]),
  );
}

/** Seuls les groupes du jeton que le fournisseur lit sont gardés ; `null` reste `null` (groupes illisibles). */
export function groupesUtiles(f: Fournisseur, groupes: readonly string[] | null): string[] | null {
  if (groupes === null) return null;
  const lus = new Set(groupesALire(f));
  return groupes.filter((g) => lus.has(g));
}

/** Décision d'après la lecture ; `null` si l'appartenance à un seul groupe à lire est inconnue ou absente de la lecture : rien ne doit alors être modifié. */
export function decider(f: Fournisseur, lecture: Lecture): Decision | null {
  const oui = new Set<string>();
  for (const g of groupesALire(f)) {
    const a = lecture.get(g);
    if (a !== "oui" && a !== "non") return null;
    if (a === "oui") oui.add(g);
  }
  let role: RoleElpis | null = null;
  if (rolesActifs(f)) {
    const g = groupesDeRoles(f);
    role = g.admin.some((v) => oui.has(v))
      ? "admin"
      : g.moderateur.some((v) => oui.has(v))
        ? "moderator"
        : "user";
  }
  let groupes: Map<number, boolean> | null = null;
  if (groupesActifs(f)) {
    groupes = new Map();
    for (const m of f.group_map.map)
      groupes.set(m.group_id, (groupes.get(m.group_id) ?? false) || oui.has(m.external));
  }
  return { role, groupes };
}

/** Ce qu'un compte obtiendrait, tel que l'essai le montre. */
export interface ApercuDroits {
  readonly roles_enabled: boolean;
  readonly groups_enabled: boolean;
  /** Faux : une appartenance est illisible, aucun droit ne serait modifié. */
  readonly readable: boolean;
  readonly role: RoleElpis | null;
  readonly groups: readonly { id: number; name: string }[];
  /** Groupes Elpis cités dans la correspondance qui n'existent plus (ignorés). */
  readonly missing_group_ids: readonly number[];
  /** Groupes d'administrateurs ignorés faute de second facteur exigé. */
  readonly admin_ignored: boolean;
}

/** Aperçu des droits d'une lecture : lecture seule de la base, jamais d'écriture. */
export async function apercuDroits(x: Executeur, f: Fournisseur, lecture: Lecture): Promise<ApercuDroits> {
  const d = decider(f, lecture);
  const ids = groupesActifs(f) ? [...new Set(f.group_map.map.map((m) => m.group_id))] : [];
  const connus = new Map<number, string>();
  if (ids.length > 0)
    for (const l of await x.all<{ id: number; name: string }>(
      `SELECT id, name FROM "groups" WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    ))
      connus.set(Number(l.id), String(l.name));
  return {
    roles_enabled: rolesActifs(f),
    groups_enabled: groupesActifs(f),
    readable: d !== null,
    role: d?.role ?? null,
    groups: [...(d?.groupes ?? new Map<number, boolean>())]
      .filter(([id, membre]) => membre && connus.has(id))
      .map(([id]) => ({ id, name: connus.get(id) ?? "" })),
    missing_group_ids: ids.filter((id) => !connus.has(id)),
    admin_ignored: f.roles.enabled && f.roles.admin_groups.length > 0 && !adminAdmis(f),
  };
}
