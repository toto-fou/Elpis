// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/sources-affichage.ts — sources d'une réponse, fonctions pures : renvois [n] d'un texte, documents cités et leur détail, droit d'ouverture, bande du document, rectangles du surlignage. */
import type { BoiteRag, CollectionVueRag, SourceCiteeRag } from "@elpis/contracts";

import { celluleDuPassage, cellulesBande } from "./format";

export type MorceauRenvoi = { texte: string } | { renvois: number[]; brut: string };

// « [3] », « [2, 5] », « [4-6] » : les trois formes que le serveur compte comme citées.
const RENVOI = /\[(\d{1,4}(?:\s*[-–]\s*\d{1,4})?(?:\s*[,;]\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?)*)\]/g;
const PLAGE_MAX = 50;

/** Numéros d'un crochet (« 2, 5 » donne 2 et 5, « 4-6 » donne 4, 5 et 6), ou `null` si le contenu n'est pas un renvoi valide. */
export function numerosDuCrochet(contenu: string): number[] | null {
  const numeros: number[] = [];
  for (const part of contenu.split(/[,;]/u)) {
    const m = /^\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s*$/u.exec(part);
    if (m === null) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b - a >= PLAGE_MAX) return null;
    for (let n = a; n <= b; n++) numeros.push(n);
  }
  return numeros.length > 0 && numeros.length <= PLAGE_MAX ? numeros : null;
}

/** Découpe un texte brut en morceaux de texte et renvois ; un crochet qui n'est pas un renvoi valide reste du texte. */
export function decouperRenvois(texte: string): MorceauRenvoi[] {
  const sortie: MorceauRenvoi[] = [];
  let debut = 0;
  const pousserTexte = (t: string): void => {
    if (t === "") return;
    const dernier = sortie[sortie.length - 1];
    if (dernier !== undefined && "texte" in dernier) dernier.texte += t;
    else sortie.push({ texte: t });
  };
  for (const m of texte.matchAll(RENVOI)) {
    const numeros = numerosDuCrochet(m[1] ?? "");
    pousserTexte(texte.slice(debut, m.index));
    if (numeros === null) pousserTexte(m[0]);
    else sortie.push({ renvois: numeros, brut: m[0] });
    debut = m.index + m[0].length;
  }
  pousserTexte(texte.slice(debut));
  return sortie;
}

/** Extension d'un nom de document, sans le point, en minuscules. */
export function extensionDe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i < 0 ? "" : nom.slice(i + 1).toLowerCase();
}

export interface DocumentCite {
  /** `collection/document` : unique dans la conversation. */
  readonly cle: string;
  readonly collection_id: string;
  readonly document_id: string;
  readonly nom: string;
  readonly chemin: string;
  readonly collection: string;
  /** Sources citées de ce document, par numéro. */
  readonly sources: readonly SourceCiteeRag[];
  /** « pages 7 et 8 », « § Tunnels IPsec · § Vérifications », ou vide. */
  readonly detail: string;
}

function liste(valeurs: readonly string[]): string {
  if (valeurs.length <= 1) return valeurs.join("");
  return `${valeurs.slice(0, -1).join(", ")} et ${valeurs[valeurs.length - 1] ?? ""}`;
}

/** Dernier titre d'un chemin de titres « 3 › 3.2 Renouvellement ». */
export function derniereSection(chemin: string): string {
  const parts = chemin.split("›").map((s) => s.trim());
  return parts[parts.length - 1] ?? "";
}

/** Où les renvois d'un document pointent : les pages, à défaut les sections. */
export function detailDocument(sources: readonly SourceCiteeRag[]): string {
  const pages = [...new Set(sources.map((s) => s.passage.page).filter((p): p is number => p !== null))].sort(
    (a, b) => a - b,
  );
  if (pages.length > 0) {
    const montrees = pages.slice(0, 4).map(String);
    const suite = pages.length > 4 ? "…" : "";
    return pages.length === 1 ? `page ${montrees[0] ?? ""}` : `pages ${liste(montrees)}${suite}`;
  }
  const sections = [
    ...new Set(sources.map((s) => derniereSection(s.passage.heading_path)).filter((t) => t !== "")),
  ];
  return sections
    .slice(0, 3)
    .map((t) => `§ ${t}`)
    .join(" · ");
}

/** Documents des sources citées, dans l'ordre de leur premier renvoi. */
export function documentsCites(sources: readonly SourceCiteeRag[]): DocumentCite[] {
  const parCle = new Map<string, SourceCiteeRag[]>();
  for (const s of [...sources].filter((x) => x.cited).sort((a, b) => a.n - b.n)) {
    const cle = `${s.passage.collection_id}/${s.passage.document_id}`;
    parCle.set(cle, [...(parCle.get(cle) ?? []), s]);
  }
  return [...parCle.entries()].map(([cle, ss]) => {
    const p = (ss[0] as SourceCiteeRag).passage;
    return {
      cle,
      collection_id: p.collection_id,
      document_id: p.document_id,
      nom: p.document_name,
      chemin: p.rel_path,
      collection: p.collection_name,
      sources: ss,
      detail: detailDocument(ss),
    };
  });
}

/** Passages que l'assistant a lus sans les citer. */
export function passagesNonCites(sources: readonly SourceCiteeRag[]): SourceCiteeRag[] {
  return sources.filter((s) => !s.cited).sort((a, b) => a.n - b.n);
}

/** Noms des collections des sources, sans doublon, dans l'ordre : « Procédures réseau », « A, B ». */
export function collectionsDesSources(sources: readonly SourceCiteeRag[]): string {
  return [...new Set(sources.map((s) => s.passage.collection_name))].join(", ");
}

export type DroitSources = "ouvert" | "ferme" | "inconnu";

/** Ce que le compte peut ouvrir d'une collection : tout (propriétaire, ou ouverture permise), le passage cité seulement, ou inconnu (le serveur tranchera). */
export function droitSources(
  collectionId: string,
  collections: readonly Pick<CollectionVueRag, "id" | "role" | "allow_source_open">[],
): DroitSources {
  const c = collections.find((x) => x.id === collectionId);
  if (c === undefined) return "inconnu";
  return c.role === "proprietaire" || c.allow_source_open ? "ouvert" : "ferme";
}

/** Collection d'un passage telle que la bulle l'écrit : « Procédures réseau », ou « … · partagée par Sophie Laurent ». */
export function collectionAffichee(
  passage: SourceCiteeRag["passage"],
  collections: readonly Pick<CollectionVueRag, "id" | "role">[],
): string {
  const c = collections.find((x) => x.id === passage.collection_id);
  const auteur = passage.owner.display_name || passage.owner.username;
  return c?.role === "lecteur"
    ? `${passage.collection_name} · partagée par ${auteur}`
    : passage.collection_name;
}

export interface CelluleDocument {
  /** Numéros `[n]` des passages cités qui tombent dans cette cellule (le premier est affiché). */
  readonly renvois: readonly number[];
  readonly courante: boolean;
}

/** Bande du document : une cellule par passage (regroupés au-delà de `max`), marquée là où des passages cités se trouvent. */
export function bandeDuDocument(
  passages: number,
  marques: readonly { chunk_index: number; n: number }[],
  courant: number | null,
  max = 64,
): CelluleDocument[] {
  const total = Math.max(0, Math.floor(passages));
  if (total === 0) return [];
  const nb = cellulesBande(total, max);
  const cellules: { renvois: number[]; courante: boolean }[] = Array.from({ length: nb }, () => ({
    renvois: [],
    courante: false,
  }));
  for (const m of [...marques].sort((a, b) => a.n - b.n)) {
    const c = cellules[celluleDuPassage(m.chunk_index, total, nb)];
    if (c === undefined) continue;
    c.renvois.push(m.n);
    if (m.n === courant) c.courante = true;
  }
  return cellules;
}

export interface RectanglePourcent {
  readonly gauche: number;
  readonly haut: number;
  readonly largeur: number;
  readonly hauteur: number;
}

const borne = (v: number): number => Math.max(0, Math.min(100, v));

/** Rectangles d'une page en pourcentages de sa taille (boîtes en points PDF, origine en haut à gauche) ; les boîtes d'une autre page sont écartées. */
export function rectanglesEnPourcent(
  boites: readonly BoiteRag[],
  page: number,
  largeurPoints: number,
  hauteurPoints: number,
): RectanglePourcent[] {
  if (!(largeurPoints > 0) || !(hauteurPoints > 0)) return [];
  const sortie: RectanglePourcent[] = [];
  for (const [p, x0, y0, x1, y1] of boites) {
    if (p !== page) continue;
    const gauche = borne((Math.min(x0, x1) / largeurPoints) * 100);
    const haut = borne((Math.min(y0, y1) / hauteurPoints) * 100);
    const droite = borne((Math.max(x0, x1) / largeurPoints) * 100);
    const bas = borne((Math.max(y0, y1) / hauteurPoints) * 100);
    if (droite > gauche && bas > haut)
      sortie.push({ gauche, haut, largeur: droite - gauche, hauteur: bas - haut });
  }
  return sortie;
}

/** Pages sur lesquelles les rectangles d'un passage tombent. */
export function pagesDesBoites(boites: readonly BoiteRag[]): number[] {
  return [...new Set(boites.map((b) => b[0]))].sort((a, b) => a - b);
}

/** Texte lu à voix haute pour une pastille : « Source 2 : procedure.docx, page 7 ». */
export function libelleAccessibleSource(s: SourceCiteeRag): string {
  const p = s.passage;
  const ou = p.page === null ? derniereSection(p.heading_path) : `page ${p.page}`;
  return `Source ${s.n} : ${p.document_name}${ou === "" ? "" : `, ${ou}`}`;
}
