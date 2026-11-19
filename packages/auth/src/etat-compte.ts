// SPDX-License-Identifier: MIT
/** packages/auth/src/etat-compte.ts — état d'un compte : suspendu dès que `suspended_at` est non nul et différent de 0 (valeur illisible comprise). */

const ZERO_TEXTE = /^0(\.0+)?$/u;

/** Vrai si la ligne du compte porte une suspension : valeur absente, nulle ou 0 (nombre ou texte « 0 », « 0.0 ») = actif, toute autre (négative, vide, non numérique) = suspendu. */
export function compteSuspendu(ligne: { suspended_at?: unknown } | null | undefined): boolean {
  const brut = ligne?.suspended_at;
  if (brut === null || brut === undefined) return false;
  if (typeof brut === "string") return !ZERO_TEXTE.test(brut);
  return Number(brut) !== 0;
}

const JOUR_S = 86_400;
const FRAICHEUR_MIN_JOURS = 1;
const FRAICHEUR_MAX_JOURS = 90;

/** Durée de fraîcheur validée (en jours) des fournisseurs actifs, par identifiant ; un fournisseur absent est inconnu, éteint, invalide ou tenu pour inactif. */
export type Fraicheurs = ReadonlyMap<string, number>;

/** Dépendance qui rend les fraîcheurs des fournisseurs actifs (fournie par le cœur) ; sans elle, tout compte externe est périmé. */
export interface PorteFraicheur {
  fraicheursFournisseurs?(): Promise<Fraicheurs>;
}

/** Colonnes et jointure qui rendent l'identité externe d'un compte (alias `u` = users) à côté de la ligne qui sert `accesPerime`. */
export const COLONNES_IDENTITE = "i.provider_id AS ident_provider_id, i.checked_at AS ident_checked_at";
export const JOINTURE_IDENTITE = "LEFT JOIN user_identities i ON i.user_id = u.id";

/** Fraîcheurs des fournisseurs actifs ; une panne ou l'absence de la dépendance rend une table vide (comptes externes périmés). */
export async function lireFraicheurs(dep: PorteFraicheur): Promise<Fraicheurs> {
  try {
    return (await dep.fraicheursFournisseurs?.()) ?? new Map();
  } catch {
    return new Map();
  }
}

/** Vrai si un accès sans session interactive est refusé faute de vérification récente : compte externe dont l'identité n'a pas été vue depuis la fraîcheur de son fournisseur (fournisseur inconnu, éteint ou inactif : périmé tout de suite) ; un compte local n'est jamais concerné. */
export function accesPerime(
  ligne: { ident_provider_id?: unknown; ident_checked_at?: unknown } | null | undefined,
  fraicheurs: Fraicheurs,
  maintenant: number,
): boolean {
  const id = ligne?.ident_provider_id;
  if (id === null || id === undefined) return false;
  const jours = typeof id === "string" ? fraicheurs.get(id) : undefined;
  if (jours === undefined || !(jours >= FRAICHEUR_MIN_JOURS && jours <= FRAICHEUR_MAX_JOURS)) return true;
  const vu = Number(ligne?.ident_checked_at);
  return !Number.isFinite(vu) || vu <= 0 || maintenant - vu > jours * JOUR_S;
}

/** `accesPerime` avec les fraîcheurs lues auprès de la dépendance, seulement pour un compte externe. */
export async function accesPerimeDe(
  dep: PorteFraicheur,
  ligne: { ident_provider_id?: unknown; ident_checked_at?: unknown } | null | undefined,
  maintenant: number,
): Promise<boolean> {
  if (ligne?.ident_provider_id === null || ligne?.ident_provider_id === undefined) return false;
  return accesPerime(ligne, await lireFraicheurs(dep), maintenant);
}
