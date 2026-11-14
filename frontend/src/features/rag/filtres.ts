// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/filtres.ts — page RAG : filtre des collections et des documents (texte, état), tri, fenêtre d'un tableau virtualisé. */
import type { CollectionVueRag, DocumentRag } from "@elpis/contracts";

import { nomAuteur } from "./format";

/** Texte sans accents ni casse, pour comparer des saisies. */
export function sansAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Collections dont le nom, la description ou l'auteur contient le texte (sans accents ni casse). */
export function filtrerCollections<T extends CollectionVueRag>(liste: readonly T[], texte: string): T[] {
  const q = sansAccents(texte.trim());
  if (q === "") return [...liste];
  return liste.filter((c) => sansAccents(`${c.name} ${c.description} ${nomAuteur(c)}`).includes(q));
}

export const FILTRES_ETAT = ["tous", "prets", "en_cours", "attente", "erreurs"] as const;
export type FiltreEtat = (typeof FILTRES_ETAT)[number];

export const LIBELLES_FILTRE_ETAT: Readonly<Record<FiltreEtat, string>> = {
  tous: "Tous les états",
  prets: "Prêts",
  en_cours: "En cours",
  attente: "En attente",
  erreurs: "En échec",
};

/** Le document passe le filtre d'état choisi. */
export function correspondEtat(d: Pick<DocumentRag, "status">, filtre: FiltreEtat): boolean {
  switch (filtre) {
    case "tous":
      return true;
    case "prets":
      return d.status === "ready";
    case "en_cours":
      return d.status === "extracting" || d.status === "indexing";
    case "attente":
      return d.status === "pending";
    case "erreurs":
      return d.status === "error";
  }
}

export type CleTri = "chemin" | "taille" | "recent";

const NATUREL = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/** Places des documents dont le chemin contient le texte (sans accents ni casse), en tri stable : chemin par ordre naturel, taille et date du plus grand ou plus récent au plus petit. */
export function ordonnerDocuments(liste: readonly DocumentRag[], texte: string, tri: CleTri): number[] {
  const q = sansAccents(texte.trim());
  const places: number[] = [];
  for (let i = 0; i < liste.length; i++)
    if (q === "" || sansAccents(liste[i]!.rel_path).includes(q)) places.push(i);
  const chemin = (i: number, j: number): number => NATUREL.compare(liste[i]!.rel_path, liste[j]!.rel_path);
  if (tri === "taille") return places.sort((i, j) => liste[j]!.bytes - liste[i]!.bytes || chemin(i, j));
  if (tri === "recent")
    return places.sort((i, j) => liste[j]!.created_at - liste[i]!.created_at || chemin(i, j));
  return places.sort(chemin);
}

/** Mêmes documents aux mêmes places avec les mêmes clés de tri (chemin, taille, date) : un ordre calculé sur l'une vaut pour l'autre. */
export function memesCles(a: readonly DocumentRag[], b: readonly DocumentRag[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (x.id !== y.id || x.rel_path !== y.rel_path || x.bytes !== y.bytes || x.created_at !== y.created_at)
      return false;
  }
  return true;
}

/** Insère ou remplace un document par son identifiant (la ligne vue par un événement). */
export function inserer(liste: readonly DocumentRag[], doc: DocumentRag): DocumentRag[] {
  const i = liste.findIndex((d) => d.id === doc.id);
  if (i < 0) return [...liste, doc];
  const copie = [...liste];
  copie[i] = doc;
  return copie;
}

/** Au-delà de ce nombre de lignes affichées, le tableau ne dessine que la fenêtre visible. */
export const SEUIL_VIRTUALISATION = 500;
export const HAUTEUR_LIGNE = 42;

export interface FenetreVirtuelle {
  debut: number;
  fin: number;
  /** Hauteurs des espaceurs avant et après la fenêtre, en pixels. */
  haut: number;
  bas: number;
}

/** Lignes à dessiner pour une zone défilante : la fenêtre visible plus un surplus de chaque côté. */
export function fenetreVirtuelle(
  total: number,
  scrollTop: number,
  hauteurVue: number,
  hauteurLigne: number = HAUTEUR_LIGNE,
  surplus = 8,
): FenetreVirtuelle {
  const premiere = Math.floor(Math.max(0, scrollTop) / hauteurLigne);
  const visibles = Math.ceil(Math.max(0, hauteurVue) / hauteurLigne) + 1;
  const debut = Math.max(0, Math.min(total, premiere - surplus));
  const fin = Math.max(debut, Math.min(total, premiere + visibles + surplus));
  return { debut, fin, haut: debut * hauteurLigne, bas: (total - fin) * hauteurLigne };
}
