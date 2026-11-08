// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/pagination.ts — pagination et tri côté serveur des listes de la console : fenêtre (décalage, limite), pages, sens de tri. */

import { DECALAGE_MAX } from "@elpis/contracts";
import { nombre } from "./formats";

export const PAR_PAGE = 50;

export interface Tri {
  col: string;
  dir: "asc" | "desc";
}

/** Colonnes dont le premier clic trie de A à Z ; les autres commencent par le plus grand ou le plus récent. */
const COLONNES_TEXTE: ReadonlySet<string> = new Set([
  "username",
  "kind",
  "status",
  "engine",
  "tool_name",
  "server_name",
  "run_id",
]);

/** Tri après un clic sur `col` : même colonne, sens inversé ; autre colonne, sens naturel. */
export function trierPar(actuel: Tri, col: string): Tri {
  if (actuel.col === col) return { col, dir: actuel.dir === "asc" ? "desc" : "asc" };
  return { col, dir: COLONNES_TEXTE.has(col) ? "asc" : "desc" };
}

/** Valeur de `aria-sort` d'un en-tête. */
export function ariaSort(tri: Tri, col: string): "ascending" | "descending" | undefined {
  if (tri.col !== col) return undefined;
  return tri.dir === "asc" ? "ascending" : "descending";
}

/** Paramètres `sort` et `dir` d'une requête : absents pour le tri par défaut du serveur. */
export function parametresTri(tri: Tri, parDefaut: Tri): string[] {
  if (tri.col === parDefaut.col && tri.dir === parDefaut.dir) return [];
  return ["sort=" + encodeURIComponent(tri.col), "dir=" + tri.dir];
}

/** Nombre de pages atteignables (le serveur borne le décalage). */
export function pagesDe(total: number, parPage: number): number {
  const utile = Math.max(0, total);
  const atteignable = Math.floor(DECALAGE_MAX / parPage) + 1;
  return Math.max(1, Math.min(Math.ceil(utile / parPage), atteignable));
}

/** Page ramenée dans 1..pages. */
export function pageBornee(page: number, total: number, parPage: number): number {
  return Math.max(1, Math.min(Math.floor(page) || 1, pagesDe(total, parPage)));
}

/** Total plus grand que la part atteignable avec le décalage maximal. */
export function totalDepasseLimite(total: number, parPage: number): boolean {
  return total > (Math.floor(DECALAGE_MAX / parPage) + 1) * parPage;
}

/** « 1-50 sur 1 284 » (bornes et total au format français). */
export function libelleFenetre(page: number, parPage: number, total: number, nbLignes: number): string {
  if (total <= 0 || nbLignes <= 0) return "0 sur " + nombre(Math.max(0, total));
  const debut = (page - 1) * parPage + 1;
  return nombre(debut) + "-" + nombre(debut + nbLignes - 1) + " sur " + nombre(total);
}
