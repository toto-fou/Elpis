// SPDX-License-Identifier: MIT
/** apps/core/src/rag/magasin.ts — magasin des fichiers RAG hors sandbox : racine, chemins `<uid>/<collection>/…` construits d'identifiants validés, résolution confinée sans lien, noms Qdrant. */
import { closeSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { configRag } from "@elpis/config";
import { ouvrirDossierSous, supprimerArbreSous } from "@elpis/securite";

/** Même liste que `EXTENSIONS_RAG` de @elpis/contracts (vérifié par test) : le core n'importe pas les contrats. */
export const EXTENSIONS_MAGASIN_RAG = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "html",
  "htm",
  "md",
  "txt",
  "csv",
  "json",
  "yaml",
  "yml",
] as const;
export type ExtensionMagasinRag = (typeof EXTENSIONS_MAGASIN_RAG)[number];

/** Uuid v4 en minuscules, comme `RE_UUID_RAG` de @elpis/contracts. */
export const RE_UUID_MAGASIN_RAG = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EXT = EXTENSIONS_MAGASIN_RAG.join("|");
const UID = "[1-9][0-9]{0,15}";
/** Formes permises, rien d'autre : compte, collection, ses trois dossiers, source (et son `.part`), extrait et découpage propre, rendus d'un document. */
const RE_REL = new RegExp(
  `^${UID}(?:/${UUID}(?:/(?:sources(?:/${UUID}\\.(?:${EXT})(?:\\.part)?)?|extraits(?:/${UUID}(?:\\.decoupage)?\\.json)?|pages(?:/${UUID}(?:/[1-9][0-9]{0,5}\\.webp)?)?))?)?$`,
  "u",
);
const RE_DOSSIER = new RegExp(`^${UID}(?:/${UUID}(?:/(?:sources|extraits|pages(?:/${UUID})?))?)?$`, "u");
const RE_QDRANT = /^elpis_([0-9a-f]{32})(?:_g([1-9][0-9]{0,5}))?$/u;
const MODE_DOSSIER = 0o700;

/** Chemin refusé : hors des formes permises, hors de la racine, lien symbolique ou fichier spécial. */
export class ErreurMagasinRag extends Error {
  override name = "ErreurMagasinRag";
}

export function estUuidRag(v: unknown): v is string {
  return typeof v === "string" && RE_UUID_MAGASIN_RAG.test(v);
}

export function estExtensionRag(v: unknown): v is ExtensionMagasinRag {
  return typeof v === "string" && (EXTENSIONS_MAGASIN_RAG as readonly string[]).includes(v);
}

function exigerUid(uid: unknown): number {
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid <= 0)
    throw new ErreurMagasinRag(`compte invalide : ${String(uid)}`);
  return uid;
}

function exigerUuid(v: unknown, quoi: string): string {
  if (!estUuidRag(v)) throw new ErreurMagasinRag(`${quoi} invalide`);
  return v;
}

/** Racine du magasin (`rag.store_dir`, relue à chaque appel). */
export function racineMagasinRag(): string {
  return configRag().store_dir;
}

/** Crée la racine si besoin (0700) et la rend résolue ; la racine elle-même peut être un lien posé par l'administrateur. */
export function assurerRacineMagasinRag(): string {
  const racine = racineMagasinRag();
  mkdirSync(racine, { recursive: true, mode: MODE_DOSSIER });
  return realpathSync(racine);
}

export function relCompteRag(uid: number): string {
  return String(exigerUid(uid));
}

export function relCollectionRag(uid: number, collectionId: string): string {
  return `${relCompteRag(uid)}/${exigerUuid(collectionId, "collection")}`;
}

export function relSourceRag(uid: number, collectionId: string, docId: string, ext: string): string {
  if (!estExtensionRag(ext)) throw new ErreurMagasinRag("extension refusée");
  return `${relCollectionRag(uid, collectionId)}/sources/${exigerUuid(docId, "document")}.${ext}`;
}

/** Fichier en cours de dépôt, renommé en source une fois complet. */
export function relPartielRag(uid: number, collectionId: string, docId: string, ext: string): string {
  return `${relSourceRag(uid, collectionId, docId, ext)}.part`;
}

export function relExtraitRag(uid: number, collectionId: string, docId: string): string {
  return `${relCollectionRag(uid, collectionId)}/extraits/${exigerUuid(docId, "document")}.json`;
}

/** Découpage propre à un document, à côté de son extrait. */
export function relDecoupageDocumentRag(uid: number, collectionId: string, docId: string): string {
  return `${relCollectionRag(uid, collectionId)}/extraits/${exigerUuid(docId, "document")}.decoupage.json`;
}

export function relPagesRag(uid: number, collectionId: string, docId: string): string {
  return `${relCollectionRag(uid, collectionId)}/pages/${exigerUuid(docId, "document")}`;
}

export function relPageRag(uid: number, collectionId: string, docId: string, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > 999_999) throw new ErreurMagasinRag("page invalide");
  return `${relPagesRag(uid, collectionId, docId)}/${page}.webp`;
}

export function estRelMagasinRag(rel: unknown): rel is string {
  return typeof rel === "string" && RE_REL.test(rel);
}

function racineResolue(): string {
  const racine = racineMagasinRag();
  try {
    return realpathSync(racine);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(racine);
    throw e;
  }
}

/** Chemin absolu de `rel` : forme stricte, puis chaque composant existant vérifié sans suivre de lien (dossier, feuille régulière). */
export function resoudreMagasinRag(rel: string): string {
  if (!estRelMagasinRag(rel)) throw new ErreurMagasinRag("chemin hors des formes du magasin RAG");
  const racine = racineResolue();
  const parties = rel.split("/");
  let courant = racine;
  for (const [i, partie] of parties.entries()) {
    courant = path.join(courant, partie);
    let st;
    try {
      st = lstatSync(courant);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw e;
    }
    if (st.isSymbolicLink()) throw new ErreurMagasinRag("lien symbolique refusé dans le magasin RAG");
    const feuille = i === parties.length - 1;
    if (st.isDirectory()) continue;
    if (!feuille || !st.isFile()) throw new ErreurMagasinRag("entrée inattendue dans le magasin RAG");
  }
  const absolu = path.join(racine, ...parties);
  if (!absolu.startsWith(racine + path.sep)) throw new ErreurMagasinRag("chemin hors de la racine RAG");
  return absolu;
}

/** Descripteur `O_PATH` d'un dossier du magasin, ouvert composant par composant sans suivre de lien ; à fermer par l'appelant. */
export function ouvrirDossierMagasinRag(rel: string, options: { creer?: boolean } = {}): number {
  if (typeof rel !== "string" || !RE_DOSSIER.test(rel))
    throw new ErreurMagasinRag("dossier hors des formes du magasin RAG");
  const racine = options.creer ? assurerRacineMagasinRag() : racineResolue();
  return ouvrirDossierSous(racine, rel, { creer: options.creer ?? false, modeDossier: MODE_DOSSIER });
}

/** Crée `sources/`, `extraits/` et `pages/` d'une collection (0700, aucun lien suivi). */
export function creerDossiersCollectionRag(uid: number, collectionId: string): void {
  const rel = relCollectionRag(uid, collectionId);
  for (const sous of ["sources", "extraits", "pages"])
    closeSync(ouvrirDossierMagasinRag(`${rel}/${sous}`, { creer: true }));
}

async function supprimerArbre(rel: string): Promise<boolean> {
  const absolu = resoudreMagasinRag(rel);
  try {
    await supprimerArbreSous(absolu);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Supprime le dossier d'une collection (vrai s'il existait) ; un lien à sa place est refusé, jamais suivi. */
export async function supprimerDossierCollectionRag(uid: number, collectionId: string): Promise<boolean> {
  return supprimerArbre(relCollectionRag(uid, collectionId));
}

export async function supprimerDossierCompteRag(uid: number): Promise<boolean> {
  return supprimerArbre(relCompteRag(uid));
}

/** Nom Qdrant d'une collection : `elpis_<uuid sans tirets>`, suffixé `_g<n>` pour une génération reconstruite (migration). */
export function nomQdrantRag(collectionId: string, generation = 0): string {
  const hex = exigerUuid(collectionId, "collection").replaceAll("-", "");
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 999_999)
    throw new ErreurMagasinRag("génération invalide");
  return generation === 0 ? `elpis_${hex}` : `elpis_${hex}_g${generation}`;
}

/** Collection et génération d'un nom Qdrant produit par `nomQdrantRag`, sinon `null` (anciennes collections comprises). */
export function analyserNomQdrantRag(nom: unknown): { collectionId: string; generation: number } | null {
  if (typeof nom !== "string") return null;
  const m = RE_QDRANT.exec(nom);
  if (m === null) return null;
  const h = m[1] as string;
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return estUuidRag(id) ? { collectionId: id, generation: m[2] === undefined ? 0 : Number(m[2]) } : null;
}

export function estNomQdrantRag(nom: unknown): nom is string {
  return analyserNomQdrantRag(nom) !== null;
}
