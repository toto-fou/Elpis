// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/revendications.ts — lecture des revendications vérifiées d'un jeton d'identité : toujours par `Object.hasOwn`, sujet, groupes (chemin pointé), `acr` et `amr` requis, e-mail vérifié seulement. */
import type { Appartenance } from "../provisionnement";
import type { FournisseurOidc } from "../reglages";

export type Revendications = Readonly<Record<string, unknown>>;

const SUJET_MAX = 255;
const TEXTE_MAX = 255;

function proprieteDe(o: unknown, nom: string): unknown {
  return o !== null && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, nom)
    ? (o as Record<string, unknown>)[nom]
    : undefined;
}

/** Revendication par son nom entier d'abord (`realm_access.roles` peut être une clé plate), puis par chemin pointé ; `undefined` si absente. */
export function lireRevendication(claims: Revendications, nom: string): unknown {
  if (Object.hasOwn(claims, nom)) return claims[nom];
  let courant: unknown = claims;
  for (const segment of nom.split(".")) {
    courant = proprieteDe(courant, segment);
    if (courant === undefined) return undefined;
  }
  return courant;
}

/** Sujet : chaîne non vide de 255 caractères au plus ; `null` sinon. */
export function sujetDe(claims: Revendications, f: FournisseurOidc): string | null {
  const v = lireRevendication(claims, f.subject_claim);
  return typeof v === "string" && v !== "" && v.length <= SUJET_MAX && v.isWellFormed() ? v : null;
}

/** Texte court d'une revendication (255 caractères au plus) ; chaîne vide si absente ou d'un autre type. */
export function texteDe(claims: Revendications, nom: string): string {
  const v = lireRevendication(claims, nom);
  return typeof v === "string" && v.isWellFormed() ? v.slice(0, TEXTE_MAX) : "";
}

/** Vrai si l'identifiant lu peut servir à une correspondance : 255 caractères au plus, et `email_verified` vrai dans la même source quand la revendication désigne l'e-mail. */
export function identifiantFiable(source: Revendications, f: FournisseurOidc): boolean {
  const v = lireRevendication(source, f.username_claim);
  if (typeof v !== "string" || v.length > TEXTE_MAX) return false;
  const email = f.username_claim === "email" || f.username_claim === f.email_claim;
  return !email || lireRevendication(source, "email_verified") === true;
}

function marqueDepassement(claims: Revendications, nomGroupes: string): boolean {
  const noms = proprieteDe(claims, "_claim_names");
  if (noms !== undefined && noms !== null && typeof noms === "object") {
    const premier = nomGroupes.split(".")[0] ?? nomGroupes;
    for (const c of [nomGroupes, premier, "groups"]) if (Object.hasOwn(noms, c)) return true;
  }
  const a = proprieteDe(claims, "hasgroups");
  return a === true || a === "true";
}

/** Valeurs de groupe réglées pour ce fournisseur (requis, rôles, correspondances). */
function groupesRegles(f: FournisseurOidc): Set<string> {
  return new Set([
    ...f.required_groups,
    ...f.roles.admin_groups,
    ...f.roles.moderator_groups,
    ...f.group_map.map.map((m) => m.external),
  ]);
}

/** Groupes du jeton : tableau de chaînes, ou chaîne égale à un groupe réglé (liste d'un élément) ; `null` sinon (absent, autre type, dépassement : inconnu). */
export function groupesDe(claims: Revendications, f: FournisseurOidc): string[] | null {
  if (marqueDepassement(claims, f.groups_claim)) return null;
  const v = lireRevendication(claims, f.groups_claim);
  if (typeof v === "string") return v !== "" && groupesRegles(f).has(v) ? [v] : null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
  return v as string[];
}

/** Appartenance à l'un des groupes requis : `inconnu` si les groupes ne se lisent pas. */
export function appartenanceDe(groupes: readonly string[] | null, f: FournisseurOidc): Appartenance {
  if (groupes === null) return "inconnu";
  return f.required_groups.some((g) => groupes.includes(g)) ? "oui" : "non";
}

/** Vrai si `acr` et `amr` satisfont les réglages (liste vide : rien d'exigé). */
export function secondFacteurSatisfait(claims: Revendications, f: FournisseurOidc): boolean {
  if (f.required_acr.length > 0) {
    const acr = proprieteDe(claims, "acr");
    if (typeof acr !== "string" || !f.required_acr.includes(acr)) return false;
  }
  if (f.required_amr.length > 0) {
    const amr = proprieteDe(claims, "amr");
    if (!Array.isArray(amr) || !amr.some((m) => typeof m === "string" && f.required_amr.includes(m)))
      return false;
  }
  return true;
}

/** E-mail gardé seulement si `email_verified` est vrai (booléen) dans la même source. */
export function emailVerifieDe(claims: Revendications, f: FournisseurOidc): string {
  if (proprieteDe(claims, "email_verified") !== true) return "";
  return texteDe(claims, f.email_claim);
}
