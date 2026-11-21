// SPDX-License-Identifier: MIT
/** apps/core/src/identite/correspondance.ts — correspondance exacte groupes du jeton → rôle et groupes Elpis, en lecture seule : des groupes illisibles ne sont jamais un « non » et suspendent toute décision. */
import { ACR_FAIBLES, AMR_MULTI_FACTEUR, FAMILLES_AMR, secondFacteurDemande } from "@elpis/contracts";
import type { ResultatEssaiBlanc } from "@elpis/contracts";
import type { Executeur } from "@elpis/db";

import type { Fournisseur } from "./reglages";

export type RoleElpis = "user" | "moderator" | "admin";

interface Decision {
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

export { ACR_FAIBLES, AMR_MULTI_FACTEUR, FAMILLES_AMR };

/** Le fournisseur est invité à un second facteur (règle partagée avec la console) ; la preuve du jeton décide ensuite à la connexion. */
export function adminAdmis(f: Fournisseur): boolean {
  return secondFacteurDemande(f.required_acr, f.required_amr);
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
function groupesActifs(f: Fournisseur): boolean {
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

/** Seuls les groupes du jeton que le fournisseur lit sont gardés ; `null` reste `null` (groupes illisibles). */
export function groupesUtiles(f: Fournisseur, groupes: readonly string[] | null): string[] | null {
  if (groupes === null) return null;
  const lus = new Set(groupesALire(f));
  return groupes.filter((g) => lus.has(g));
}

/** Décision d'après les groupes du jeton (valeur exacte de la revendication) ; `null` si les groupes sont illisibles alors qu'il y en a à lire : rien ne doit alors être modifié. */
export function decider(f: Fournisseur, groupes: readonly string[] | null): Decision | null {
  const lus = groupesALire(f);
  if (groupes === null && lus.length > 0) return null;
  const oui = new Set(lus.filter((g) => groupes?.includes(g) === true));
  let role: RoleElpis | null = null;
  if (rolesActifs(f)) {
    const g = groupesDeRoles(f);
    role = g.admin.some((v) => oui.has(v))
      ? "admin"
      : g.moderateur.some((v) => oui.has(v))
        ? "moderator"
        : "user";
  }
  let membres: Map<number, boolean> | null = null;
  if (groupesActifs(f)) {
    membres = new Map();
    for (const m of f.group_map.map)
      membres.set(m.group_id, (membres.get(m.group_id) ?? false) || oui.has(m.external));
  }
  return { role, groupes: membres };
}

/** Ce qu'un compte obtiendrait, tel que l'essai le montre. */
export type ApercuDroits = NonNullable<ResultatEssaiBlanc["rights"]>;

/** Aperçu des droits d'une lecture : lecture seule de la base, jamais d'écriture. */
export async function apercuDroits(
  x: Executeur,
  f: Fournisseur,
  groupes: readonly string[] | null,
): Promise<ApercuDroits> {
  const d = decider(f, groupes);
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
