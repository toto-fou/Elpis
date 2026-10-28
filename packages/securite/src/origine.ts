// SPDX-License-Identifier: MIT
/** packages/securite/src/origine.ts — origine exacte d'une adresse (schéma, hôte, port) lue par WHATWG, clé d'un identifiant du coffre. */

/** `scheme://host[:port]` d'une adresse http(s) (port par défaut omis, hôte en minuscules et punycode) ; `null` sinon. */
export function origineExacte(adresse: string): string | null {
  const brut = typeof adresse === "string" ? adresse.trim() : "";
  if (!brut || brut.length > 2048 || !URL.canParse(brut)) return null;
  const u = new URL(brut);
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  return u.origin === "null" ? null : u.origin;
}
