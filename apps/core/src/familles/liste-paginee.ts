// SPDX-License-Identifier: MIT
/** apps/core/src/familles/liste-paginee.ts — aides des listes de la console : décalage borné, recherche LIKE échappée, tri en liste blanche. */
import { HttpError } from "@elpis/commun";
import { DECALAGE_MAX } from "@elpis/contracts";

export const RECHERCHE_MAX = 100;

export function decalage(v: number): number {
  return Math.max(0, Math.min(DECALAGE_MAX, v));
}

/** Motif LIKE d'une saisie (jokers neutralisés, bornée), ou `null` si elle est vide ; la casse est pliée par le moteur des deux côtés (`LOWER(col) LIKE LOWER(?)`). */
export function motifRecherche(saisie: string): string | null {
  const s = saisie.trim().slice(0, RECHERCHE_MAX);
  return s === "" ? null : `%${s.replace(/[\\%_]/gu, "\\$&")}%`;
}

/** Condition « une des colonnes contient la saisie » et ses paramètres liés ; `null` sans saisie. */
export function conditionRecherche(
  saisie: string,
  colonnes: readonly string[],
): { sql: string; params: string[] } | null {
  const motif = motifRecherche(saisie);
  if (motif === null) return null;
  return {
    sql: `(${colonnes.map((c) => `LOWER(${c}) LIKE LOWER(?) ESCAPE '\\'`).join(" OR ")})`,
    params: colonnes.map(() => motif),
  };
}

/** ORDER BY d'une colonne de la liste blanche (400 sinon), départagé par `departage` ; le mot SQL vient de la liste, jamais de la requête. */
export function clauseTri(
  colonne: string,
  sens: string,
  blanche: Readonly<Record<string, string>>,
  parDefaut: { expr: string; sens: "ASC" | "DESC" },
  departage: string,
): string {
  if (sens !== "" && sens !== "asc" && sens !== "desc") throw new HttpError(400, "Sens de tri inconnu");
  if (colonne === "") {
    const s = sens === "" ? parDefaut.sens : sens === "asc" ? "ASC" : "DESC";
    return `ORDER BY ${parDefaut.expr} ${s}, ${departage} ${s}`;
  }
  if (!Object.hasOwn(blanche, colonne)) throw new HttpError(400, "Colonne de tri inconnue");
  const s = sens === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${blanche[colonne]} ${s}, ${departage} ${s}`;
}
