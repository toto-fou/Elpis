// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/format.ts — page RAG, fonctions pures d'affichage : tailles, nombres, dates, états d'un document, bande de passages, surlignage. */
import type { CollectionVueRag, DocumentRag } from "@elpis/contracts";

const ICONES: Readonly<Record<string, string>> = {
  pdf: "ph-file-pdf",
  docx: "ph-file-doc",
  pptx: "ph-file-ppt",
  xlsx: "ph-file-xls",
  md: "ph-file-md",
  html: "ph-file-html",
  htm: "ph-file-html",
  txt: "ph-file-txt",
  csv: "ph-file-csv",
  json: "ph-file-code",
  yaml: "ph-file-code",
  yml: "ph-file-code",
};

/** Icône Phosphor d'une extension (sans le point). */
export function iconeFichier(ext: string): string {
  return ICONES[ext.toLowerCase()] ?? "ph-file";
}

const NBSP = " ";

/** Entier groupé par milliers avec une espace insécable : « 1 532 ». */
export function formaterNombre(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Taille en octets, unités françaises et virgule décimale : « 380 Ko », « 18,2 Mo », « 2 Go ». */
export function formaterTaille(octets: number): string {
  const o = Math.max(0, octets);
  if (o < 1024) return `${Math.round(o)}${NBSP}o`;
  const ko = o / 1024;
  if (ko < 1000) return `${Math.round(ko)}${NBSP}Ko`;
  const decimale = (v: number): string => {
    const s = (Math.round(v * 10) / 10).toFixed(1);
    return (s.endsWith(".0") ? s.slice(0, -2) : s).replace(".", ",");
  };
  const mo = ko / 1024;
  if (mo < 1000) return `${decimale(mo)}${NBSP}Mo`;
  return `${decimale(mo / 1024)}${NBSP}Go`;
}

/** Quota exprimé en Mo, affiché comme une taille : 2048 donne « 2 Go ». */
export function formaterQuotaMo(mo: number): string {
  return formaterTaille(mo * 1024 * 1024);
}

const MOIS = [
  "janv.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];

function memeJour(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function veille(maintenant: Date): Date {
  const d = new Date(maintenant);
  d.setDate(d.getDate() - 1);
  return d;
}

/** Date d'un horodatage en secondes : « Aujourd'hui », « Hier », « 14 oct. » (avec l'année si ce n'est pas la courante). */
export function formaterDateCourte(ts: number, maintenant: Date = new Date()): string {
  const d = new Date(ts * 1000);
  if (memeJour(d, maintenant)) return "Aujourd’hui";
  if (memeJour(d, veille(maintenant))) return "Hier";
  const base = `${d.getDate()}${NBSP}${MOIS[d.getMonth()] ?? ""}`;
  return d.getFullYear() === maintenant.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

function heure(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Dernière modification d'une collection : « Modifiée aujourd'hui à 10:42 », « Modifiée hier », « Modifiée le 14 oct. ». */
export function formaterModification(ts: number, maintenant: Date = new Date(), lecteur = false): string {
  const d = new Date(ts * 1000);
  const verbe = lecteur ? "Mise à jour" : "Modifiée";
  if (memeJour(d, maintenant)) return lecteur ? `${verbe} aujourd’hui` : `${verbe} aujourd’hui à ${heure(d)}`;
  if (memeJour(d, veille(maintenant))) return `${verbe} hier`;
  return `${verbe} le ${formaterDateCourte(ts, maintenant)}`;
}

/** Initiales d'une pastille d'auteur : « Sophie Laurent » donne « SL », « alice » donne « AL ». */
export function initiales(nom: string): string {
  const mots = nom
    .trim()
    .split(/\s+/u)
    .filter((m) => m !== "");
  if (mots.length === 0) return "?";
  if (mots.length === 1)
    return Array.from(mots[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase();
  return (
    (Array.from(mots[0] ?? "")[0] ?? "").toUpperCase() +
    (Array.from(mots[mots.length - 1] ?? "")[0] ?? "").toUpperCase()
  );
}

/** Nom affiché d'un auteur : le nom d'affichage, sinon l'identifiant. */
export function nomAuteur(c: Pick<CollectionVueRag, "owner">): string {
  return c.owner.display_name || c.owner.username;
}

/** Dossier d'un chemin logique, avec barre finale (« VPN/ »), ou chaîne vide à la racine. */
export function dossierDe(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i + 1);
}

/** Cellules d'une bande de passages : une par passage, regroupées au-delà de `max`. */
export function cellulesBande(passages: number, max = 24): number {
  return Math.max(1, Math.min(Math.max(0, Math.floor(passages)), max));
}

/** Cellule de la bande qui porte le passage `index` quand `passages` sont regroupés en `cellules`. */
export function celluleDuPassage(index: number, passages: number, cellules: number): number {
  if (passages <= 0 || cellules <= 0) return 0;
  return Math.min(cellules - 1, Math.floor((index * cellules) / passages));
}

export type CleEtatDocument = "prete" | "attente" | "service" | "extraction" | "indexation" | "erreur";

export interface EtatAffiche {
  cle: CleEtatDocument;
  libelle: string;
  /** Texte long pour l'infobulle : le message du serveur s'il existe. */
  detail: string;
}

const LIBELLES_ERREUR: Readonly<Record<string, string>> = {
  no_text: "Sans texte : activez l’OCR",
  encrypted: "Protégé par un mot de passe",
  unsupported: "Format non pris en charge",
  too_large: "Document trop volumineux",
  timeout: "Extraction trop longue",
  corrupt: "Fichier illisible",
  ocr_unavailable: "OCR indisponible",
  extractor_unavailable: "Extracteur indisponible",
  embed_unavailable: "Embeddings indisponibles",
  qdrant_unavailable: "Qdrant indisponible",
  quota: "Quota dépassé",
  internal: "Erreur interne",
  cancelled: "Indexation annulée",
};

/** État d'un document tel que le tableau l'écrit : libellé court, clé de style, détail du serveur. */
export function etatDocument(d: Pick<DocumentRag, "status" | "error">): EtatAffiche {
  const detail = d.error?.message ?? "";
  switch (d.status) {
    case "ready":
      return { cle: "prete", libelle: "Prête", detail };
    case "extracting":
      return { cle: "extraction", libelle: "Extraction…", detail };
    case "indexing":
      return { cle: "indexation", libelle: "Indexation…", detail };
    case "error":
      return {
        cle: "erreur",
        libelle: LIBELLES_ERREUR[d.error?.code ?? ""] ?? (d.error?.message || "Échec de l’indexation"),
        detail,
      };
    case "pending":
      return d.error
        ? { cle: "service", libelle: "En attente d’un service", detail }
        : { cle: "attente", libelle: "En attente", detail };
  }
}

/** Le document est en cours de traitement ou dans la file. */
export function documentActif(d: Pick<DocumentRag, "status">): boolean {
  return d.status === "pending" || d.status === "extracting" || d.status === "indexing";
}

export function libelleVisibilite(c: Pick<CollectionVueRag, "visibility" | "groups">): string {
  if (c.visibility === "all") return "Tous les comptes";
  if (c.visibility === "groups") {
    const n = c.groups.length;
    return n === 0 ? "Groupes" : n === 1 ? (c.groups[0]?.name ?? "Groupe") : `${n}${NBSP}groupes`;
  }
  return "Privée";
}

export function iconeVisibilite(v: CollectionVueRag["visibility"]): string {
  return v === "all" ? "ph-globe" : v === "groups" ? "ph-users-three" : "ph-lock-simple";
}

/** Mot-clé d'accord : « 1 document », « 48 documents ». */
export function accorder(n: number, singulier: string, pluriel: string = `${singulier}s`): string {
  return `${formaterNombre(n)}${NBSP}${n === 1 || n === 0 ? singulier : pluriel}`;
}

/** Part du travail faite, en pour cent entiers (0 sans total). */
export function pourcentage(done: number, failed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((done + failed) * 100) / total)));
}

/** Reste estimé d'un travail : « environ 2 min restantes », « moins d'une minute » ; `null` tant qu'aucun document n'est fini. */
export function estimerRestant(
  travail: { created_at: number; done: number; failed: number; total: number },
  maintenantMs: number,
): string | null {
  const faits = travail.done + travail.failed;
  if (faits <= 0 || travail.total <= faits) return null;
  const ecoule = Math.max(0, maintenantMs - travail.created_at * 1000);
  const reste = (ecoule / faits) * (travail.total - faits);
  const minutes = Math.round(reste / 60_000);
  if (reste < 45_000) return "moins d’une minute restante";
  if (minutes < 60) return `environ ${minutes}${NBSP}min restantes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0
    ? `environ ${h}${NBSP}h restantes`
    : `environ ${h}${NBSP}h ${String(m).padStart(2, "0")} restantes`;
}

/** Libellé d'un nombre de jetons estimé : arrondi à la dizaine puis à la centaine au-delà de mille. */
export function formaterJetons(tokens: number): string {
  const arrondi = tokens >= 1000 ? Math.round(tokens / 100) * 100 : Math.round(tokens / 10) * 10;
  return `environ ${formaterNombre(arrondi)}${NBSP}jetons`;
}

/** Score ou pertinence de 0 à 1 écrit à la française : « 0,86 ». */
export function formaterScore(v: number): string {
  return (Math.round(v * 100) / 100).toFixed(2).replace(".", ",");
}

/** Durée d'une recherche en secondes, une décimale : « 0,4 s ». */
export function formaterDuree(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1).replace(".", ",")}${NBSP}s`;
}

/** Où se trouve un passage : « page 7 · 3.2 Renouvellement », « § Tunnels IPsec » sans page. */
export function emplacementPassage(p: { page: number | null; heading_path: string }): string {
  const titres = p.heading_path.trim();
  if (p.page !== null && titres !== "") return `page ${p.page} · ${titres}`;
  if (p.page !== null) return `page ${p.page}`;
  return titres !== "" ? `§ ${titres}` : "";
}

export interface SegmentSurligne {
  texte: string;
  marque: boolean;
}

function sansAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Racines des mots de la question à surligner : au moins quatre lettres, queue coupée pour couvrir les formes voisines. */
export function racinesDeRequete(requete: string): string[] {
  const mots = sansAccents(requete).match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const racines = mots.map((m) => m.slice(0, Math.max(4, m.length - 3)));
  return [...new Set(racines)];
}

/** Découpe un texte en segments, ceux qui commencent par une racine de la question étant marqués (rendu sans HTML brut). */
export function surlignerTexte(texte: string, requete: string): SegmentSurligne[] {
  const racines = racinesDeRequete(requete);
  if (racines.length === 0 || texte === "") return [{ texte, marque: false }];
  const segments: SegmentSurligne[] = [];
  let courant = "";
  let marque = false;
  const pousser = (): void => {
    if (courant !== "") segments.push({ texte: courant, marque });
    courant = "";
  };
  for (const part of texte.split(/([\p{L}\p{N}]+)/u)) {
    if (part === "") continue;
    const mot = /^[\p{L}\p{N}]+$/u.test(part);
    const m = mot && racines.some((r) => sansAccents(part).startsWith(r));
    if (m !== marque) {
      pousser();
      marque = m;
    }
    courant += part;
  }
  pousser();
  return segments;
}
