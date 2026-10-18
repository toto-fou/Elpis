// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/onglets.ts — règles pures des onglets de l'éditeur : libellé en deux parts, indices d'homonymes, épinglage, réordonnancement, position du menu. */

export interface OngletEditeur {
  path: string;
  name: string;
  pinned?: boolean;
  [cle: string]: unknown;
}

export interface MetaFichier {
  icon: string;
  color: string;
}

/** Tête (coupée en ellipse au plafond) et queue gardée entière (extension et quelques caractères). */
export function partiesLibelle(nom: unknown): { head: string; tail: string } {
  const s = String(nom ?? "");
  if (s.length <= 12) return { head: s, tail: "" };
  const point = s.lastIndexOf(".");
  const ext = point > 0 && s.length - point <= 8 ? s.length - point : 0;
  const garde = Math.min(s.length - 4, ext ? ext + 4 : 5);
  return { head: s.slice(0, s.length - garde), tail: s.slice(s.length - garde) };
}

/** Pour les onglets homonymes, le plus court suffixe de dossier qui les distingue (« / » à la racine). */
export function indicesHomonymes(onglets: readonly OngletEditeur[]): Record<string, string> {
  const parNom = new Map<string, string[]>();
  for (const t of onglets) {
    const liste = parNom.get(t.name);
    if (liste) liste.push(t.path);
    else parNom.set(t.name, [t.path]);
  }
  const indices: Record<string, string> = {};
  const dossierDe = (p: string, n: number): string => p.split("/").slice(0, -1).slice(-n).join("/");
  for (const chemins of parNom.values()) {
    if (chemins.length < 2) continue;
    for (const p of chemins) {
      const dossiers = p.split("/").slice(0, -1);
      let n = 1;
      let indice = dossiers.slice(-1).join("/");
      while (n < dossiers.length && chemins.some((q) => q !== p && dossierDe(q, n) === indice)) {
        n++;
        indice = dossiers.slice(-n).join("/");
      }
      indices[p] = indice || "/";
    }
  }
  return indices;
}

/** Bascule l'épinglage : épinglé → fin du groupe épinglé, désépinglé → début des autres. Null si absent. */
export function basculerEpingle<T extends OngletEditeur>(onglets: readonly T[], chemin: string): T[] | null {
  const liste = onglets.slice();
  const i = liste.findIndex((t) => t.path === chemin);
  if (i < 0) return null;
  const courant = liste[i] as T;
  const onglet = { ...courant, pinned: !courant.pinned };
  liste.splice(i, 1);
  const finEpingles = liste.reduce((n, t, k) => (t.pinned ? k + 1 : n), 0);
  liste.splice(finEpingles, 0, onglet);
  return liste;
}

/** Dépose `source` sur `cible` (derrière elle si elle était après), borné à son groupe d'épinglage. Null si rien ne change. */
export function deplacerOnglet<T extends OngletEditeur>(
  onglets: readonly T[],
  source: string,
  cible: string,
): T[] | null {
  if (!source || source === cible) return null;
  const liste = onglets.slice();
  const de = liste.findIndex((t) => t.path === source);
  if (de < 0) return null;
  const deplace = liste.splice(de, 1)[0] as T;
  let vers = liste.findIndex((t) => t.path === cible);
  if (vers < 0) return null;
  if (de <= vers) vers += 1;
  const epingles = liste.filter((t) => t.pinned).length;
  vers = deplace.pinned ? Math.min(vers, epingles) : Math.max(vers, epingles);
  vers = Math.min(vers, liste.length);
  liste.splice(vers, 0, deplace);
  return liste;
}

/** Position du menu contextuel, bornée à la fenêtre (menu de 220 × 380 px). */
export function positionMenu(
  x: number,
  y: number,
  largeurFenetre: number,
  hauteurFenetre: number,
): { x: number; y: number } {
  return { x: Math.min(x, largeurFenetre - 220 - 8), y: Math.min(y, hauteurFenetre - 380 - 8) };
}
