// SPDX-License-Identifier: MIT
/** apps/core/src/rag/sources.ts — sources d'un document pour la visionneuse : fenêtre de passages (Qdrant), rendu d'une page en cache, localisation d'un passage, ouverture de l'original ; règle d'ouverture des sources. */
import {
  closeSync,
  createReadStream,
  fstatSync,
  readdirSync,
  readSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import type { ReadStream } from "node:fs";

import type { Base } from "@elpis/db";
import { ErreurRag } from "@elpis/rag";
import type { ClientQdrant } from "@elpis/rag";
import { ecrireSous, ouvrirDossierSous, ouvrirFeuille } from "@elpis/securite";

import { journal } from "../journal";
import type { RoleRag } from "./acces";
import { ErreurRouteRag, MESSAGE_SOURCES_FERMEES } from "./http";
import {
  assurerRacineMagasinRag,
  ouvrirDossierMagasinRag,
  relCollectionRag,
  relPageRag,
  relPagesRag,
  relSourceRag,
} from "./magasin";
import { DPI_RENDU, localiserExtracteur, rendrePageExtracteur } from "./rendu";
import { lireDocument, nomQdrantCollectionRag } from "./travaux";
import type { LigneDocumentRag } from "./travaux";

const log = journal("rag");

/** Rendus gardés par document ; au-delà, les plus anciens partent. */
export const PAGES_EN_CACHE_MAX = 300;
const IMAGE_MAX_OCTETS = 32 * 1024 * 1024;
const viaFd = (fd: number, nom: string): string => `/proc/self/fd/${fd}${nom ? `/${nom}` : ""}`;

export interface DependancesSourcesRag {
  readonly base: Base;
  readonly qdrant: () => ClientQdrant;
}

/** Collection d'un document, avec son propriétaire : de quoi retrouver ses fichiers et sa collection vectorielle. */
export interface CibleSourcesRag {
  readonly collectionId: string;
  readonly proprietaire: number;
  readonly metaJson: string;
}

export type DroitSources = "complet" | "passage";

/** Le propriétaire ouvre tout ; un lecteur seulement si le propriétaire a ouvert les sources, sinon un passage précis. */
export function droitSources(role: RoleRag, ouvertes: boolean): DroitSources {
  return role === "proprietaire" || ouvertes ? "complet" : "passage";
}

/** Lectures d'un passage seul (sources fermées) permises par compte et par collection sur une minute : freine la reconstitution d'un document passage par passage. */
export const reglagesLecturesRestreintes = { max: 60, fenetreMs: 60_000 };
const lecturesRestreintes = new Map<string, { debut: number; n: number }>();

/** Compte une lecture restreinte ; faux au-delà du plafond de la fenêtre en cours. */
export function lectureRestreintePermise(
  uid: number,
  collectionId: string,
  maintenant = Date.now(),
): boolean {
  const cle = `${uid}/${collectionId}`;
  const e = lecturesRestreintes.get(cle);
  if (e === undefined || maintenant - e.debut >= reglagesLecturesRestreintes.fenetreMs) {
    if (lecturesRestreintes.size > 10_000) lecturesRestreintes.clear();
    lecturesRestreintes.set(cle, { debut: maintenant, n: 1 });
    return true;
  }
  e.n += 1;
  return e.n <= reglagesLecturesRestreintes.max;
}

/** Oublie les compteurs (tests). */
export function oublierLecturesRestreintes(): void {
  lecturesRestreintes.clear();
}

/** Refus 403 `sources_fermees` quand le compte n'a droit qu'à un passage. */
export function exigerSourcesOuvertes(droit: DroitSources): void {
  if (droit !== "complet") throw new ErreurRouteRag(403, "sources_fermees", MESSAGE_SOURCES_FERMEES);
}

export interface PassageDocumentRag {
  chunk_index: number;
  text: string;
  heading_path: string;
  page: number | null;
  boxes: [number, number, number, number, number][];
  char_start: number;
  char_end: number;
}

/** Fenêtre de passages `autour ± n` (un seul passage sans le droit complet), triés par rang. */
export async function fenetrePassages(
  dep: DependancesSourcesRag,
  cible: CibleSourcesRag,
  doc: LigneDocumentRag,
  o: { autour: number; n: number; droit: DroitSources },
  signal?: AbortSignal,
): Promise<{ passages: PassageDocumentRag[]; restreint: boolean }> {
  const n = o.droit === "complet" ? o.n : 0;
  const bas = Math.max(0, o.autour - n);
  const haut = o.autour + n;
  let points;
  try {
    points = await dep.qdrant().parcourir(nomQdrantCollectionRag(cible.collectionId, cible.metaJson), {
      filtre: { docIds: [doc.id], chunkMin: bas, chunkMax: haut },
      limite: haut - bas + 1,
      depuis: bas,
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof ErreurRag && e.code === "collection_absente")
      return { passages: [], restreint: n === 0 };
    throw e;
  }
  const passages = points
    .filter((p) => p.charge.doc_id === doc.id && p.charge.chunk_index >= bas && p.charge.chunk_index <= haut)
    .map((p) => ({
      chunk_index: p.charge.chunk_index,
      text: p.charge.text,
      heading_path: p.charge.heading_path,
      page: p.charge.page,
      boxes: p.charge.bbox.flatMap((b) =>
        b.page >= 1 && Number.isInteger(b.page)
          ? b.rects.map((r) => [b.page, r[0], r[1], r[2], r[3]] as [number, number, number, number, number])
          : [],
      ),
      char_start: p.charge.char_start,
      char_end: p.charge.char_end,
    }))
    .sort((a, b) => a.chunk_index - b.chunk_index);
  return { passages, restreint: o.droit !== "complet" };
}

function estWebp(b: Buffer): boolean {
  return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
}

/** Rendu déjà en cache (`pages/<doc>/<n>.webp`) ; `null` s'il manque, est illisible ou n'a pas la forme d'une image WebP. */
function lireRenduEnCache(cible: CibleSourcesRag, docId: string, page: number): Buffer | null {
  let dfd: number;
  try {
    dfd = ouvrirDossierMagasinRag(relPagesRag(cible.proprietaire, cible.collectionId, docId));
  } catch {
    return null;
  }
  try {
    const fd = ouvrirFeuille(dfd, `${page}.webp`);
    try {
      const taille = fstatSync(fd).size;
      if (taille <= 0 || taille > IMAGE_MAX_OCTETS) return null;
      const b = Buffer.alloc(taille);
      let lu = 0;
      while (lu < taille) {
        const k = readSync(fd, b, lu, taille - lu, lu);
        if (k <= 0) break;
        lu += k;
      }
      return lu === taille && estWebp(b) ? b : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  } finally {
    closeSync(dfd);
  }
}

/** Retire les rendus les plus anciens d'un document au-delà de `PAGES_EN_CACHE_MAX`. */
function elaguerRendus(cible: CibleSourcesRag, docId: string): void {
  let dfd: number;
  try {
    dfd = ouvrirDossierSous(
      assurerRacineMagasinRag(),
      relPagesRag(cible.proprietaire, cible.collectionId, docId),
      {
        lisible: true,
      },
    );
  } catch {
    return;
  }
  try {
    const noms = readdirSync(viaFd(dfd, "")).filter((n) => /^[1-9][0-9]{0,5}\.webp$/u.test(n));
    if (noms.length <= PAGES_EN_CACHE_MAX) return;
    const ages = noms.map((n) => ({ n, t: lstatSync(viaFd(dfd, n)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { n } of ages.slice(0, noms.length - PAGES_EN_CACHE_MAX)) unlinkSync(viaFd(dfd, n));
  } catch (e) {
    log.debug({ err: e }, "élagage des rendus de pages en échec");
  } finally {
    closeSync(dfd);
  }
}

const enCours = new Map<string, Promise<{ octets: Buffer; pages: number | null }>>();

/** Rendu fait par l'extracteur puis gardé, sauf si le document a changé de version pendant ce temps ; un seul rendu à la fois par page. */
async function rendreEtGarder(
  dep: DependancesSourcesRag,
  cible: CibleSourcesRag,
  doc: LigneDocumentRag,
  page: number,
): Promise<{ octets: Buffer; pages: number | null }> {
  const r = await rendrePageExtracteur({
    source: relSourceRag(cible.proprietaire, cible.collectionId, doc.id, doc.ext),
    ext: doc.ext,
    page,
  });
  const maintenant = await lireDocument(dep.base, doc.id);
  if (maintenant !== null && maintenant.sha256 === doc.sha256) {
    try {
      ecrireSous(
        assurerRacineMagasinRag(),
        relPageRag(cible.proprietaire, cible.collectionId, doc.id, page),
        r.octets,
        { creerParents: true, modeDossier: 0o700, modeDefaut: 0o600 },
      );
      elaguerRendus(cible, doc.id);
    } catch (e) {
      log.warn({ err: e }, `rendu de la page ${page} non gardé`);
    }
  }
  return { octets: r.octets, pages: r.pages };
}

/** Rendu WebP de la page `page` (à partir de 1) : cache du magasin, sinon extracteur ; lève `page_introuvable` hors du document. */
export async function pageDuDocument(
  dep: DependancesSourcesRag,
  cible: CibleSourcesRag,
  doc: LigneDocumentRag,
  page: number,
): Promise<{ octets: Buffer; pages: number | null; dpi: number }> {
  if (doc.pages !== null && page > doc.pages)
    throw new ErreurRouteRag(404, "page_introuvable", "Cette page n'existe pas dans le document.");
  const garde = lireRenduEnCache(cible, doc.id, page);
  if (garde !== null) return { octets: garde, pages: doc.pages, dpi: DPI_RENDU };
  const cle = `${doc.id}:${doc.sha256}:${page}`;
  let travail = enCours.get(cle);
  if (travail === undefined) {
    travail = rendreEtGarder(dep, cible, doc, page).finally(() => enCours.delete(cle));
    enCours.set(cle, travail);
  }
  const r = await travail;
  return { octets: r.octets, pages: r.pages ?? doc.pages, dpi: DPI_RENDU };
}

/** Page et rectangles d'un passage dans le rendu du document, rectangles au format `[page, x0, y0, x1, y1]`. */
export async function localiserPassage(
  cible: CibleSourcesRag,
  doc: LigneDocumentRag,
  o: { texte: string; page?: number | undefined },
  signal?: AbortSignal,
): Promise<{
  page: number | null;
  boxes: [number, number, number, number, number][];
  score: number;
  page_width: number | null;
  page_height: number | null;
}> {
  const r = await localiserExtracteur({
    source: relSourceRag(cible.proprietaire, cible.collectionId, doc.id, doc.ext),
    ext: doc.ext,
    texte: o.texte,
    pageIndice: o.page,
    signal,
  });
  return {
    page: r.page,
    boxes: r.page === null ? [] : r.boites.map((b) => [r.page as number, b[0], b[1], b[2], b[3]]),
    score: r.score,
    page_width: r.largeur,
    page_height: r.hauteur,
  };
}

/** Original du document ouvert sans suivre de lien : flux, taille ; 404 `document_introuvable` si le fichier manque. */
export function ouvrirOriginal(
  cible: CibleSourcesRag,
  doc: LigneDocumentRag,
): { flux: ReadStream; taille: number } {
  const absent = (): ErreurRouteRag =>
    new ErreurRouteRag(404, "document_introuvable", "Le fichier source est introuvable.");
  let dfd: number;
  try {
    dfd = ouvrirDossierMagasinRag(`${relCollectionRag(cible.proprietaire, cible.collectionId)}/sources`);
  } catch {
    throw absent();
  }
  try {
    const fd = ouvrirFeuille(dfd, `${doc.id}.${doc.ext}`);
    try {
      const taille = fstatSync(fd).size;
      return { flux: createReadStream("", { fd, autoClose: true }), taille };
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  } catch (e) {
    if (e instanceof ErreurRouteRag) throw e;
    throw absent();
  } finally {
    closeSync(dfd);
  }
}
