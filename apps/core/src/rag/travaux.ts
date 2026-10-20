// SPDX-License-Identifier: MIT
/** apps/core/src/rag/travaux.ts — lignes RAG en base pour l'indexation : travaux (file, jonction, migration), documents et collections sous la forme des contrats, compteurs recalculés. */
import { randomUUID } from "node:crypto";

import type { Executeur } from "@elpis/db";

import { nomQdrantRag } from "./magasin";

export type GenreTravailRag = "ingest" | "reindex" | "migrate" | "purge";
export type EtatTravailRag = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export type EtatDocumentRag = "pending" | "extracting" | "indexing" | "ready" | "error";

/** Travail à mener : en file, en cours ou suspendu. */
export const ETATS_TRAVAIL_ACTIFS = "('queued', 'running', 'paused')";
/** Document encore à traiter par le travail actif de sa collection. */
export const ETATS_DOCUMENT_A_TRAITER = "('pending', 'extracting', 'indexing')";
export const DOCUMENT_A_TRAITER: ReadonlySet<string> = new Set(["pending", "extracting", "indexing"]);

/** Paramètres d'un travail (`params_json`) : réextraction ; pour une migration, génération, modèle, dimension, curseur et début. */
export interface ParamsTravailRag {
  reextraire?: boolean;
  generation?: number;
  modele?: string;
  dimension?: number;
  curseur?: string | null;
  debut?: number;
}

export interface LigneTravailRag {
  readonly id: string;
  readonly collection_id: string;
  readonly owner_user_id: number;
  readonly kind: GenreTravailRag;
  readonly status: EtatTravailRag;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly params: ParamsTravailRag;
  readonly heartbeat_at: number | null;
  readonly worker_boot_id: string | null;
  readonly error: string | null;
  readonly created_at: number;
  readonly finished_at: number | null;
}

/** Travail sous la forme du contrat `schemaTravailRag`. */
export interface TravailRagPublic {
  id: string;
  collection_id: string;
  kind: GenreTravailRag;
  status: EtatTravailRag;
  total: number;
  done: number;
  failed: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface LigneDocumentRag {
  readonly id: string;
  readonly collection_id: string;
  readonly rel_path: string;
  readonly name: string;
  readonly ext: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly pages: number | null;
  readonly chunk_count: number;
  readonly status: EtatDocumentRag;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly chunk_params_hash: string;
  readonly created_at: number;
  readonly indexed_at: number | null;
}

/** Document sous la forme du contrat `schemaDocumentRag`. */
export interface DocumentRagPublic {
  id: string;
  collection_id: string;
  rel_path: string;
  name: string;
  ext: string;
  bytes: number;
  pages: number | null;
  chunk_count: number;
  status: EtatDocumentRag;
  error: { code: string; message: string } | null;
  created_at: number;
  indexed_at: number | null;
}

/** Réglages propres d'une collection rangés dans `meta_json` : OCR et génération Qdrant courante. */
export interface MetaCollectionRag {
  readonly ocr: boolean;
  readonly generation: number;
}

export interface LigneCollectionRag {
  readonly id: string;
  readonly owner_user_id: number;
  readonly name: string;
  readonly chunk_json: string;
  readonly meta_json: string;
  readonly meta: MetaCollectionRag;
  readonly embed_model: string;
  readonly embed_dim: number;
  readonly status: string;
  readonly allow_source_open: boolean;
}

const COLONNES_TRAVAIL =
  "id, collection_id, owner_user_id, kind, status, total, done, failed, params_json, heartbeat_at, worker_boot_id, error, created_at, finished_at";
const COLONNES_DOCUMENT =
  "id, collection_id, rel_path, name, ext, bytes, sha256, pages, chunk_count, status, error_code, error_message, chunk_params_hash, created_at, indexed_at";
const COLONNES_COLLECTION =
  "id, owner_user_id, name, chunk_json, meta_json, embed_model, embed_dim, status, allow_source_open";

function objet(texte: unknown): Record<string, unknown> {
  if (typeof texte !== "string" || texte === "") return {};
  try {
    const v = JSON.parse(texte) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const nombre = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nombreOuNul = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const texteOuNul = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function entierBorne(v: unknown, bas: number, haut: number): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= bas && v <= haut ? v : undefined;
}

export function lireParamsTravail(texte: unknown): ParamsTravailRag {
  const o = objet(texte);
  const p: ParamsTravailRag = {};
  if (o["reextraire"] === true) p.reextraire = true;
  const generation = entierBorne(o["generation"], 0, 999_999);
  if (generation !== undefined) p.generation = generation;
  if (typeof o["modele"] === "string") p.modele = o["modele"];
  const dimension = entierBorne(o["dimension"], 1, 65_536);
  if (dimension !== undefined) p.dimension = dimension;
  if (typeof o["curseur"] === "string" || o["curseur"] === null) p.curseur = o["curseur"];
  if (typeof o["debut"] === "number" && Number.isFinite(o["debut"])) p.debut = o["debut"];
  return p;
}

function ligneTravail(r: Record<string, unknown>): LigneTravailRag {
  return {
    id: String(r["id"]),
    collection_id: String(r["collection_id"]),
    owner_user_id: nombre(r["owner_user_id"]),
    kind: String(r["kind"]) as GenreTravailRag,
    status: String(r["status"]) as EtatTravailRag,
    total: nombre(r["total"]),
    done: nombre(r["done"]),
    failed: nombre(r["failed"]),
    params: lireParamsTravail(r["params_json"]),
    heartbeat_at: nombreOuNul(r["heartbeat_at"]),
    worker_boot_id: texteOuNul(r["worker_boot_id"]),
    error: texteOuNul(r["error"]),
    created_at: nombre(r["created_at"]),
    finished_at: nombreOuNul(r["finished_at"]),
  };
}

export function travailPublic(l: LigneTravailRag): TravailRagPublic {
  return {
    id: l.id,
    collection_id: l.collection_id,
    kind: l.kind,
    status: l.status,
    total: Math.max(0, l.total),
    done: Math.max(0, l.done),
    failed: Math.max(0, l.failed),
    error: l.error,
    created_at: l.created_at,
    finished_at: l.finished_at,
  };
}

function ligneDocument(r: Record<string, unknown>): LigneDocumentRag {
  return {
    id: String(r["id"]),
    collection_id: String(r["collection_id"]),
    rel_path: String(r["rel_path"]),
    name: String(r["name"]),
    ext: String(r["ext"]),
    bytes: nombre(r["bytes"]),
    sha256: String(r["sha256"] ?? ""),
    pages: nombreOuNul(r["pages"]),
    chunk_count: nombre(r["chunk_count"]),
    status: String(r["status"]) as EtatDocumentRag,
    error_code: texteOuNul(r["error_code"]),
    error_message: texteOuNul(r["error_message"]),
    chunk_params_hash: String(r["chunk_params_hash"] ?? ""),
    created_at: nombre(r["created_at"]),
    indexed_at: nombreOuNul(r["indexed_at"]),
  };
}

export function documentPublic(l: LigneDocumentRag): DocumentRagPublic {
  return {
    id: l.id,
    collection_id: l.collection_id,
    rel_path: l.rel_path,
    name: l.name,
    ext: l.ext,
    bytes: l.bytes,
    pages: l.pages,
    chunk_count: l.chunk_count,
    status: l.status,
    error: l.error_code === null ? null : { code: l.error_code, message: l.error_message ?? "" },
    created_at: l.created_at,
    indexed_at: l.indexed_at,
  };
}

/** OCR et génération Qdrant d'une collection, lus de `meta_json` (valeurs absentes : sans OCR, génération 0). */
export function metaCollectionRag(metaJson: unknown): MetaCollectionRag {
  const o = objet(metaJson);
  return { ocr: o["ocr"] === true, generation: entierBorne(o["generation"], 0, 999_999) ?? 0 };
}

/** `meta_json` réécrit avec la génération donnée, les autres clés gardées. */
export function metaAvecGeneration(metaJson: unknown, generation: number): string {
  return JSON.stringify({ ...objet(metaJson), generation });
}

/** Nom Qdrant servi pour une collection : sa génération courante (`meta_json.generation`). */
export function nomQdrantCollectionRag(collectionId: string, metaJson: unknown): string {
  return nomQdrantRag(collectionId, metaCollectionRag(metaJson).generation);
}

export async function lireTravail(x: Executeur, id: string): Promise<LigneTravailRag | null> {
  const r = await x.get(`SELECT ${COLONNES_TRAVAIL} FROM rag_jobs WHERE id=?`, [id]);
  return r === undefined ? null : ligneTravail(r);
}

export async function travauxActifs(x: Executeur): Promise<LigneTravailRag[]> {
  const lignes = await x.all(
    `SELECT ${COLONNES_TRAVAIL} FROM rag_jobs WHERE status IN ${ETATS_TRAVAIL_ACTIFS} ORDER BY created_at, id`,
  );
  return lignes.map(ligneTravail);
}

/** Travaux de toute l'instance (console), les plus récents d'abord ; `actifs` ne garde que ceux à mener, `genre` un seul genre. */
export async function listerTravauxRag(
  x: Executeur,
  o: { actifs?: boolean; genre?: GenreTravailRag; limite?: number } = {},
): Promise<LigneTravailRag[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (o.actifs) conditions.push(`status IN ${ETATS_TRAVAIL_ACTIFS}`);
  if (o.genre !== undefined) {
    conditions.push("kind=?");
    params.push(o.genre);
  }
  const limite = Math.max(1, Math.min(500, Math.trunc(o.limite ?? 100)));
  const lignes = await x.all(
    `SELECT ${COLONNES_TRAVAIL} FROM rag_jobs ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC, id LIMIT ${limite}`,
    params,
  );
  return lignes.map(ligneTravail);
}

/** Travaux à mener des collections données (la migration d'abord, sinon le plus ancien), au plus un par collection. */
export async function travauxActifsDesCollections(
  x: Executeur,
  ids: readonly string[],
): Promise<Map<string, LigneTravailRag>> {
  const sortie = new Map<string, LigneTravailRag>();
  if (!ids.length) return sortie;
  const lignes = await x.all(
    `SELECT ${COLONNES_TRAVAIL} FROM rag_jobs WHERE status IN ${ETATS_TRAVAIL_ACTIFS} ` +
      `AND collection_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, id`,
    ids,
  );
  for (const l of lignes.map(ligneTravail)) {
    const deja = sortie.get(l.collection_id);
    if (deja === undefined || (l.kind === "migrate" && deja.kind !== "migrate"))
      sortie.set(l.collection_id, l);
  }
  return sortie;
}

/** Travaux d'un compte, les plus récents d'abord ; `actifs` ne garde que ceux à mener. */
export async function travauxDuCompte(
  x: Executeur,
  uid: number,
  o: { actifs?: boolean; collectionId?: string; limite?: number } = {},
): Promise<LigneTravailRag[]> {
  const conditions = ["owner_user_id=?"];
  const params: (string | number)[] = [uid];
  if (o.actifs) conditions.push(`status IN ${ETATS_TRAVAIL_ACTIFS}`);
  if (o.collectionId !== undefined) {
    conditions.push("collection_id=?");
    params.push(o.collectionId);
  }
  const limite = Math.max(1, Math.min(500, Math.trunc(o.limite ?? 50)));
  const lignes = await x.all(
    `SELECT ${COLONNES_TRAVAIL} FROM rag_jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id LIMIT ${limite}`,
    params,
  );
  return lignes.map(ligneTravail);
}

export async function lireDocument(x: Executeur, id: string): Promise<LigneDocumentRag | null> {
  const r = await x.get(`SELECT ${COLONNES_DOCUMENT} FROM rag_documents WHERE id=?`, [id]);
  return r === undefined ? null : ligneDocument(r);
}

export async function documentsParIds(x: Executeur, ids: readonly string[]): Promise<LigneDocumentRag[]> {
  if (!ids.length) return [];
  const lignes = await x.all(
    `SELECT ${COLONNES_DOCUMENT} FROM rag_documents WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  return lignes.map(ligneDocument);
}

export type TriDocumentsRag = "chemin" | "recent" | "taille";

const ORDRES_DOCUMENTS: Readonly<Record<TriDocumentsRag, string>> = {
  chemin: "rel_path ASC, id",
  recent: "created_at DESC, id",
  taille: "bytes DESC, id",
};

/** Page de documents d'une collection : filtre sur le chemin (sans casse), liste d'états, tri ; rend aussi le nombre total qui répond au filtre. */
export async function listerDocumentsRag(
  x: Executeur,
  collectionId: string,
  o: {
    q?: string | undefined;
    etats?: readonly string[] | undefined;
    tri?: TriDocumentsRag | undefined;
    offset: number;
    limite: number;
  },
): Promise<{ lignes: LigneDocumentRag[]; total: number }> {
  const conditions = ["collection_id=?"];
  const params: (string | number)[] = [collectionId];
  if (o.q !== undefined && o.q.trim() !== "") {
    conditions.push("LOWER(rel_path) LIKE ? ESCAPE '\\'");
    params.push(
      `%${o.q
        .trim()
        .toLowerCase()
        .replace(/[\\%_]/gu, "\\$&")}%`,
    );
  }
  if (o.etats !== undefined && o.etats.length) {
    conditions.push(`status IN (${o.etats.map(() => "?").join(",")})`);
    params.push(...o.etats);
  }
  const ou = conditions.join(" AND ");
  const [n] = await x.valeurs<[unknown]>(`SELECT COUNT(*) FROM rag_documents WHERE ${ou}`, params);
  const lignes = await x.all(
    `SELECT ${COLONNES_DOCUMENT} FROM rag_documents WHERE ${ou} ORDER BY ${ORDRES_DOCUMENTS[o.tri ?? "chemin"]} LIMIT ${Math.max(1, Math.trunc(o.limite))} OFFSET ${Math.max(0, Math.trunc(o.offset))}`,
    params,
  );
  return { lignes: lignes.map(ligneDocument), total: nombre(n?.[0]) };
}

/** Prochains documents à traiter d'une collection (ordre d'arrivée), sans ceux déjà en cours dans ce process. */
export async function documentsATraiter(
  x: Executeur,
  collectionId: string,
  exclus: ReadonlySet<string>,
): Promise<LigneDocumentRag | null> {
  const lignes = await x.all(
    `SELECT ${COLONNES_DOCUMENT} FROM rag_documents WHERE collection_id=? AND status IN ${ETATS_DOCUMENT_A_TRAITER} ` +
      `ORDER BY created_at, id LIMIT ${exclus.size + 1}`,
    [collectionId],
  );
  return lignes.map(ligneDocument).find((d) => !exclus.has(d.id)) ?? null;
}

/** Prochain document prêt d'une migration, après le curseur (ordre des identifiants). */
export async function documentAMigrer(
  x: Executeur,
  collectionId: string,
  curseur: string | null,
): Promise<LigneDocumentRag | null> {
  const r =
    curseur === null
      ? await x.get(
          `SELECT ${COLONNES_DOCUMENT} FROM rag_documents WHERE collection_id=? AND status='ready' ORDER BY id LIMIT 1`,
          [collectionId],
        )
      : await x.get(
          `SELECT ${COLONNES_DOCUMENT} FROM rag_documents WHERE collection_id=? AND status='ready' AND id > ? ORDER BY id LIMIT 1`,
          [collectionId, curseur],
        );
  return r === undefined ? null : ligneDocument(r);
}

export async function resteATraiter(x: Executeur, collectionId: string): Promise<number> {
  const [r] = await x.valeurs<[unknown]>(
    `SELECT COUNT(*) FROM rag_documents WHERE collection_id=? AND status IN ${ETATS_DOCUMENT_A_TRAITER}`,
    [collectionId],
  );
  return nombre(r?.[0]);
}

export async function lireCollection(x: Executeur, id: string): Promise<LigneCollectionRag | null> {
  const r = await x.get(`SELECT ${COLONNES_COLLECTION} FROM rag_collections WHERE id=?`, [id]);
  if (r === undefined) return null;
  const meta = String(r["meta_json"] ?? "{}");
  return {
    id: String(r["id"]),
    owner_user_id: nombre(r["owner_user_id"]),
    name: String(r["name"]),
    chunk_json: String(r["chunk_json"] ?? "{}"),
    meta_json: meta,
    meta: metaCollectionRag(meta),
    embed_model: String(r["embed_model"] ?? ""),
    embed_dim: nombre(r["embed_dim"]),
    status: String(r["status"]),
    allow_source_open: nombre(r["allow_source_open"]) === 1,
  };
}

/** Octets des sources de toutes les collections d'un compte (quota de stockage). */
export async function octetsDuCompte(x: Executeur, uid: number): Promise<number> {
  const [r] = await x.valeurs<[unknown]>(
    "SELECT COALESCE(SUM(d.bytes), 0) FROM rag_documents d JOIN rag_collections c ON c.id = d.collection_id WHERE c.owner_user_id=?",
    [uid],
  );
  return nombre(r?.[0]);
}

export async function documentsDeLaCollection(x: Executeur, collectionId: string): Promise<number> {
  const [r] = await x.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_documents WHERE collection_id=?", [
    collectionId,
  ]);
  return nombre(r?.[0]);
}

/** Travail actif d'une collection autre qu'une migration (au plus un), sinon `null`. */
export async function travailDocumentsActif(
  x: Executeur,
  collectionId: string,
): Promise<LigneTravailRag | null> {
  const r = await x.get(
    `SELECT ${COLONNES_TRAVAIL} FROM rag_jobs WHERE collection_id=? AND status IN ${ETATS_TRAVAIL_ACTIFS} ` +
      "AND kind <> 'migrate' ORDER BY created_at, id LIMIT 1",
    [collectionId],
  );
  return r === undefined ? null : ligneTravail(r);
}

export async function migrationActive(x: Executeur, collectionId: string): Promise<LigneTravailRag | null> {
  const r = await x.get(
    `SELECT ${COLONNES_TRAVAIL} FROM rag_jobs WHERE collection_id=? AND status IN ${ETATS_TRAVAIL_ACTIFS} ` +
      "AND kind = 'migrate' ORDER BY created_at, id LIMIT 1",
    [collectionId],
  );
  return r === undefined ? null : ligneTravail(r);
}

/** Ajoute `n` documents au travail actif de la collection (un seul à la fois, une migration exceptée), ou en crée un ; dans la transaction de l'appelant. */
export async function rejoindreTravail(
  x: Executeur,
  a: {
    collectionId: string;
    uid: number;
    genre: "ingest" | "reindex";
    n: number;
    reextraire?: boolean;
    t: number;
  },
): Promise<LigneTravailRag> {
  const actif = await travailDocumentsActif(x, a.collectionId);
  if (actif !== null) {
    const params = a.reextraire ? JSON.stringify({ ...actif.params, reextraire: true }) : null;
    await x.run(
      `UPDATE rag_jobs SET total = total + ?, params_json = COALESCE(?, params_json), finished_at = NULL WHERE id=?`,
      [a.n, params, actif.id],
    );
    return (await lireTravail(x, actif.id)) as LigneTravailRag;
  }
  const id = randomUUID();
  await x.run(
    "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, status, total, done, failed, params_json, created_at) " +
      "VALUES(?, ?, ?, ?, 'queued', ?, 0, 0, ?, ?)",
    [id, a.collectionId, a.uid, a.genre, a.n, JSON.stringify(a.reextraire ? { reextraire: true } : {}), a.t],
  );
  return (await lireTravail(x, id)) as LigneTravailRag;
}

/** Migration de modèle de la collection : l'active si elle existe, sinon une nouvelle vers la génération suivante ; dans la transaction de l'appelant. */
export async function assurerMigration(
  x: Executeur,
  a: { collection: LigneCollectionRag; modele: string; t: number },
): Promise<{ travail: LigneTravailRag; cree: boolean }> {
  const actif = await migrationActive(x, a.collection.id);
  if (actif !== null) return { travail: actif, cree: false };
  const id = randomUUID();
  const params: ParamsTravailRag = {
    generation: a.collection.meta.generation + 1,
    modele: a.modele,
    curseur: null,
    debut: a.t,
  };
  await x.run(
    "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, status, total, done, failed, params_json, created_at) " +
      "VALUES(?, ?, ?, 'migrate', 'queued', 0, 0, 0, ?, ?)",
    [id, a.collection.id, a.collection.owner_user_id, JSON.stringify(params), a.t],
  );
  return { travail: (await lireTravail(x, id)) as LigneTravailRag, cree: true };
}

export async function ecrireParamsTravail(x: Executeur, id: string, params: ParamsTravailRag): Promise<void> {
  await x.run("UPDATE rag_jobs SET params_json=? WHERE id=?", [JSON.stringify(params), id]);
}

/** Compteurs et état d'une collection recalculés des documents et des travaux. */
export async function rafraichirCollection(x: Executeur, collectionId: string): Promise<void> {
  const migration = await migrationActive(x, collectionId);
  const autre = migration === null ? await travailDocumentsActif(x, collectionId) : null;
  let status = migration !== null ? "migrating" : autre !== null ? "indexing" : "ready";
  if (status === "ready") {
    const dernier = await x.get(
      "SELECT status FROM rag_jobs WHERE collection_id=? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
      [collectionId],
    );
    if (dernier?.["status"] === "failed") status = "error";
  }
  await x.run(
    "UPDATE rag_collections SET " +
      "doc_count = (SELECT COUNT(*) FROM rag_documents WHERE collection_id = ?), " +
      "chunk_count = (SELECT COALESCE(SUM(chunk_count), 0) FROM rag_documents WHERE collection_id = ? AND status = 'ready'), " +
      "bytes = (SELECT COALESCE(SUM(bytes), 0) FROM rag_documents WHERE collection_id = ?), status = ? WHERE id = ?",
    [collectionId, collectionId, collectionId, status, collectionId],
  );
}
