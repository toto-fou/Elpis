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
const FRAICHEUR_PAR_DEFAUT_JOURS = 14;

/** Colonnes et jointure qui rendent l'identité externe d'un compte (alias `u` = users) à côté de la ligne qui sert `accesPerime`. */
export const COLONNES_IDENTITE = "i.provider_id AS ident_provider_id, i.checked_at AS ident_checked_at";
export const JOINTURE_IDENTITE = "LEFT JOIN user_identities i ON i.user_id = u.id";

function fournisseurDeConfig(config: unknown, id: string): { enabled: boolean; jours: number } | null {
  const auth = (config as { auth?: { providers?: unknown } } | null | undefined)?.auth;
  const liste = Array.isArray(auth?.providers) ? (auth.providers as unknown[]) : [];
  for (const p of liste) {
    const f = p as { id?: unknown; enabled?: unknown; freshness_days?: unknown } | null;
    if (f === null || typeof f !== "object" || f.id !== id) continue;
    const jours = Number(f.freshness_days);
    return {
      enabled: f.enabled === true,
      jours: Number.isFinite(jours) && jours >= 1 ? jours : FRAICHEUR_PAR_DEFAUT_JOURS,
    };
  }
  return null;
}

/** Vrai si un accès sans session interactive est refusé faute de vérification récente : compte externe dont l'identité n'a pas été vue depuis `freshness_days` (fournisseur supprimé ou éteint : périmé) ; un compte local n'est jamais concerné. */
export function accesPerime(
  ligne: { ident_provider_id?: unknown; ident_checked_at?: unknown } | null | undefined,
  config: unknown,
  maintenant: number,
): boolean {
  const id = ligne?.ident_provider_id;
  if (id === null || id === undefined) return false;
  const f = typeof id === "string" ? fournisseurDeConfig(config, id) : null;
  if (f === null || !f.enabled) return true;
  const vu = Number(ligne?.ident_checked_at);
  return !Number.isFinite(vu) || vu <= 0 || maintenant - vu > f.jours * JOUR_S;
}
