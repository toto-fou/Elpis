// SPDX-License-Identifier: MIT
/** apps/core/src/rag/admin.ts — console d'administration du RAG : état des services, essais, collections (métadonnées seulement), suppression, quotas par compte, progression de la réindexation globale, travaux. */
import { getUserSettings, reglagesDepuis } from "@elpis/auth";
import { configRag, lireQuotasRag, QUOTAS_RAG_MAX } from "@elpis/config";
import type { QuotasRag } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";
import { ClientEmbeddings, ClientQdrant, ClientReranker, ErreurRag } from "@elpis/rag";

import { MASQUE_SECRET } from "../admin/config";
import { journal } from "../journal";
import { pousserNotification } from "../notifications/envoi";
import { droitRag } from "./acces";
import { getServiceUrl, ping } from "./client";
import { audiencePublicationRag } from "./collections";
import { ErreurRouteRag } from "./http";
import { estUuidRag } from "./magasin";
import { modelesVision } from "./vision";
import { definirQuotaRagCompte, surchargeQuotaRag } from "./quotas";
import type { ServiceIndexationRag } from "./service";
import {
  ETATS_TRAVAIL_ACTIFS,
  listerTravauxRag,
  travailPublic,
  travauxActifsDesCollections,
} from "./travaux";
import type { LigneTravailRag, TravailRagPublic } from "./travaux";

const log = journal("rag");

const SONDE_MS = 2_500;
const VALIDITE_SONDE_MS = 5_000;
const ESSAI_MS = 10_000;
const LIMITE_DEFAUT = 50;
const LIMITE_MAX = 200;
const LOT_SQL = 400;
const CLES_QUOTAS = ["storage_mb", "collections", "file_mb", "docs_per_collection"] as const;

export interface DependancesAdminRag {
  readonly base: Base;
  readonly service: () => ServiceIndexationRag | null;
  /** Client Qdrant d'une adresse (par défaut le vrai client ; les tests le remplacent). */
  readonly qdrant?: ((url: string) => ClientQdrant) | undefined;
  /** Sonde de l'extracteur (remplaçable) : réponse de `GET /api/health`. */
  readonly sondeExtracteur?: (() => Promise<unknown>) | undefined;
}

const nombre = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const marques = (n: number): string => Array.from({ length: n }, () => "?").join(",");

function lots<T>(liste: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += LOT_SQL) out.push(liste.slice(i, i + LOT_SQL));
  return out;
}

function texte(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/** Motif LIKE d'une saisie : jokers neutralisés, sans casse. */
function motifLike(saisie: string): string {
  return `%${saisie
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/gu, "\\$&")}%`;
}

// ── État et essais des services ──────────────────────────────────────────

interface SondeServices {
  readonly t: number;
  readonly extracteur: {
    ok: boolean;
    version: string | null;
    soffice: boolean | null;
    ocr: boolean | null;
    error: string | null;
  };
  readonly qdrant: { ok: boolean; version: string | null; error: string | null };
}

const sondes = new Map<string, SondeServices>();

/** Oublie les sondes gardées (tests). */
export function oublierSondesAdminRag(): void {
  sondes.clear();
}

async function sonderExtracteur(dep: DependancesAdminRag): Promise<SondeServices["extracteur"]> {
  if (getServiceUrl() === "") return { ok: false, version: null, soffice: null, ocr: null, error: null };
  try {
    const r = await (dep.sondeExtracteur ?? (() => ping(null, null, SONDE_MS / 1000)))();
    const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    return {
      ok: o["ok"] !== false,
      version: typeof o["version"] === "string" ? o["version"] : null,
      soffice: bool(o["soffice"]),
      ocr: bool(o["ocr"]),
      error: null,
    };
  } catch (e) {
    return { ok: false, version: null, soffice: null, ocr: null, error: texte(e) };
  }
}

async function sonderQdrant(dep: DependancesAdminRag, url: string): Promise<SondeServices["qdrant"]> {
  if (url === "") return { ok: false, version: null, error: null };
  try {
    const client = (dep.qdrant ?? ((u: string) => new ClientQdrant({ url: u })))(url);
    const s = await client.sante(AbortSignal.timeout(SONDE_MS));
    return { ok: s.ok, version: s.version ?? null, error: s.erreur ?? null };
  } catch (e) {
    return { ok: false, version: null, error: texte(e) };
  }
}

/** Sondes de l'extracteur et de Qdrant, gardées 5 s par couple d'adresses (la page se rouvre souvent). */
async function sonder(dep: DependancesAdminRag, qdrantUrl: string): Promise<SondeServices> {
  const cle = `${getServiceUrl()}|${qdrantUrl}`;
  const vue = sondes.get(cle);
  if (vue !== undefined && Date.now() - vue.t < VALIDITE_SONDE_MS) return vue;
  const [extracteur, qdrant] = await Promise.all([sonderExtracteur(dep), sonderQdrant(dep, qdrantUrl)]);
  const neuve: SondeServices = { t: Date.now(), extracteur, qdrant };
  sondes.set(cle, neuve);
  if (sondes.size > 16) sondes.delete(sondes.keys().next().value as string);
  return neuve;
}

/** État des services, de la configuration utile et de l'indexation, pour la page « RAG » de la console. */
export async function etatAdminRag(dep: DependancesAdminRag) {
  const conf = configRag();
  const sonde = await sonder(dep, conf.qdrant_url);
  const x = dep.base;
  const compte = { queued: 0, running: 0, paused: 0 };
  for (const [s, n] of await x.valeurs<[unknown, unknown]>(
    `SELECT status, COUNT(*) FROM rag_jobs WHERE status IN ${ETATS_TRAVAIL_ACTIFS} GROUP BY status`,
  ))
    if (s === "queued" || s === "running" || s === "paused") compte[s] = nombre(n);
  const [battement] = await x.valeurs<[unknown]>(
    "SELECT MAX(heartbeat_at) FROM rag_jobs WHERE status='running'",
  );
  const [tot] = await x.valeurs<[unknown, unknown, unknown, unknown]>(
    "SELECT COUNT(*), COALESCE(SUM(doc_count), 0), COALESCE(SUM(bytes), 0), COUNT(DISTINCT owner_user_id) FROM rag_collections",
  );
  const urlExtracteur = getServiceUrl();
  return {
    enabled: conf.embed.url !== "",
    extractor: {
      configured: urlExtracteur !== "",
      url: urlExtracteur,
      ok: urlExtracteur === "" ? null : sonde.extracteur.ok,
      version: sonde.extracteur.version,
      error: sonde.extracteur.error,
      soffice: sonde.extracteur.soffice,
      ocr: sonde.extracteur.ocr,
    },
    qdrant: {
      configured: conf.qdrant_url !== "",
      url: conf.qdrant_url,
      ok: conf.qdrant_url === "" ? null : sonde.qdrant.ok,
      version: sonde.qdrant.version,
      error: sonde.qdrant.error,
    },
    embed: {
      configured: conf.embed.url !== "",
      url: conf.embed.url,
      model: conf.embed.model,
      has_api_key: conf.embed.api_key !== "",
    },
    reranker: {
      enabled: conf.reranker.enabled && conf.reranker.url !== "",
      url: conf.reranker.url,
      model: conf.reranker.model,
    },
    ocr: {
      configured: conf.ocr.url !== "",
      url: conf.ocr.url,
      model: conf.ocr.model,
      has_api_key: conf.ocr.api_key !== "",
    },
    groups: conf.groups,
    quotas: conf.quotas,
    quotas_max: { ...QUOTAS_RAG_MAX },
    indexation: {
      concurrence: conf.indexation.concurrence,
      par_compte: conf.indexation.par_compte,
      jobs: compte,
      last_heartbeat: battement?.[0] === null || battement?.[0] === undefined ? null : nombre(battement[0]),
    },
    totals: {
      collections: nombre(tot?.[0]),
      documents: nombre(tot?.[1]),
      bytes: nombre(tot?.[2]),
      owners: nombre(tot?.[3]),
    },
  };
}

type ServiceEssai = "embeddings" | "reranker" | "qdrant" | "ocr";

export type ResultatEssaiRag =
  | {
      ok: true;
      service: ServiceEssai;
      detail: string;
      duration_ms: number;
      dimension?: number;
      version?: string;
    }
  | { ok: false; service: ServiceEssai; error: string };

const sansBarre = (u: string): string => u.replace(/\/+$/u, "");

/** Adresse http(s) du formulaire, sinon celle qui est enregistrée ; vide si aucune n'est exploitable. */
function adresseEssai(saisie: string | undefined, enregistree: string): string {
  const brute = (saisie ?? "").trim();
  if (brute === "") return enregistree;
  try {
    const u = new URL(brute);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? sansBarre(brute) : "";
  } catch {
    return "";
  }
}

/** Essai d'un service avec les valeurs du formulaire (sinon celles enregistrées) ; toujours un résultat, jamais une exception. La clé enregistrée ne part qu'à l'adresse enregistrée. */
export async function essaiServiceRag(
  dep: DependancesAdminRag,
  service: ServiceEssai,
  corps: { url?: string | undefined; model?: string | undefined; api_key?: string | undefined },
): Promise<ResultatEssaiRag> {
  const conf = configRag();
  const t0 = performance.now();
  const duree = (): number => Math.round(performance.now() - t0);
  const echec = (error: string): ResultatEssaiRag => ({ ok: false, service, error });
  try {
    if (service === "embeddings") {
      const url = adresseEssai(corps.url, conf.embed.url);
      if (url === "") return echec("Adresse du serveur d'embeddings absente ou invalide.");
      const saisie = (corps.api_key ?? "").trim();
      const cle =
        (saisie === MASQUE_SECRET ? "" : saisie) ||
        (sansBarre(url) === sansBarre(conf.embed.url) ? conf.embed.api_key : "");
      const client = new ClientEmbeddings({
        url,
        modele: (corps.model ?? "").trim() || conf.embed.model,
        cleApi: cle,
        delaiMs: ESSAI_MS,
        reprises: 0,
      });
      const dimension = await client.sonderDimension({ signal: AbortSignal.timeout(ESSAI_MS), reprises: 0 });
      return {
        ok: true,
        service,
        detail: `Modèle joignable, vecteurs de ${dimension} dimensions.`,
        duration_ms: duree(),
        dimension,
      };
    }
    if (service === "reranker") {
      const url = adresseEssai(corps.url, conf.reranker.url);
      if (url === "") return echec("Adresse du reclassement absente ou invalide.");
      const client = new ClientReranker({
        url,
        modele: (corps.model ?? "").trim() || conf.reranker.model,
        delaiMs: ESSAI_MS,
      });
      const scores = await client.classer("essai", ["premier passage", "second passage"], {
        topN: 2,
        signal: AbortSignal.timeout(ESSAI_MS),
      });
      return {
        ok: true,
        service,
        detail: `Reclassement joignable, ${scores.length} score(s) reçu(s).`,
        duration_ms: duree(),
      };
    }
    if (service === "ocr") {
      const url = adresseEssai(corps.url, conf.ocr.url);
      if (url === "") return echec("Adresse du serveur OCR absente ou invalide.");
      const saisie = (corps.api_key ?? "").trim();
      const cle =
        (saisie === MASQUE_SECRET ? "" : saisie) ||
        (sansBarre(url) === sansBarre(conf.ocr.url) ? conf.ocr.api_key : "");
      const vus = await modelesVision(url, cle, ESSAI_MS);
      if ("erreur" in vus) return echec(vus.erreur);
      const modeles = vus.modeles;
      const voulu = (corps.model ?? "").trim() || conf.ocr.model;
      if (voulu !== "" && modeles.length && !modeles.includes(voulu))
        return echec(`Le serveur répond, mais ne sert pas le modèle « ${voulu.slice(0, 80)} ».`);
      return {
        ok: true,
        service,
        detail: modeles.length
          ? `Serveur joignable, ${modeles.length} modèle(s) : ${modeles.slice(0, 3).join(", ").slice(0, 160)}.`
          : "Serveur joignable.",
        duration_ms: duree(),
      };
    }
    const url = adresseEssai(corps.url, conf.qdrant_url);
    if (url === "") return echec("Adresse de Qdrant absente ou invalide.");
    const sante = await (dep.qdrant ?? ((u: string) => new ClientQdrant({ url: u })))(url).sante(
      AbortSignal.timeout(ESSAI_MS),
    );
    if (!sante.ok) return echec(sante.erreur ?? "Qdrant ne répond pas correctement.");
    return {
      ok: true,
      service,
      detail: sante.version ? `Qdrant ${sante.version} prêt.` : "Qdrant prêt.",
      duration_ms: duree(),
      ...(sante.version ? { version: sante.version } : {}),
    };
  } catch (e) {
    if (e instanceof ErreurRag) return echec(texte(e));
    log.warn({ err: e }, `[admin/rag/essai/${service}] échec inattendu`);
    return echec("Le service ne répond pas.");
  }
}

// ── Collections (métadonnées seulement) ──────────────────────────────────

export interface FiltresCollectionsAdminRag {
  readonly q?: string | undefined;
  readonly ownerId?: number | undefined;
  readonly visibility?: string | undefined;
  readonly status?: string | undefined;
  readonly tri?: string | undefined;
  readonly offset: number;
  readonly limite: number;
}

const ORDRES: Readonly<Record<string, string>> = {
  nom: "LOWER(c.name), c.id",
  auteur: "LOWER(u.username), LOWER(c.name), c.id",
  taille: "c.bytes DESC, c.id",
  documents: "c.doc_count DESC, c.id",
  recent: "c.updated_at DESC, c.id",
};
const ETATS_COLLECTION = new Set(["ready", "indexing", "migrating", "error"]);
const VISIBILITES = new Set(["private", "groups", "all"]);

type CollectionAdmin = {
  id: string;
  name: string;
  owner: { id: number; username: string };
  visibility: "private" | "groups" | "all";
  groups: { id: number; name: string }[];
  allow_source_open: boolean;
  doc_count: number;
  chunk_count: number;
  bytes: number;
  status: "ready" | "indexing" | "migrating" | "error";
  embed_model: string;
  created_at: number;
  updated_at: number;
  last_indexed_at: number | null;
  job: TravailRagPublic | null;
};

const COLONNES_ADMIN =
  "c.id, c.name, c.owner_user_id, u.username, c.visibility, c.allow_source_open, c.doc_count, c.chunk_count, c.bytes, " +
  "c.status, c.embed_model, c.created_at, c.updated_at, " +
  "(SELECT MAX(d.indexed_at) FROM rag_documents d WHERE d.collection_id = c.id) AS dernier";

/** Lignes complétées par les groupes accordés et le travail actif ; l'ordre de `lignes` est gardé. */
async function completerCollections(
  x: Executeur,
  lignes: readonly Record<string, unknown>[],
): Promise<CollectionAdmin[]> {
  const ids = lignes.map((r) => String(r["id"]));
  const groupes = new Map<string, { id: number; name: string }[]>();
  for (const lot of lots(ids))
    for (const [cid, gid, nom] of await x.valeurs<[unknown, unknown, unknown]>(
      `SELECT g.collection_id, gr.id, gr.name FROM rag_grants g JOIN "groups" gr ON gr.id = g.principal_id ` +
        `WHERE g.principal_type = 'group' AND g.collection_id IN (${marques(lot.length)}) ORDER BY gr.name, gr.id`,
      lot,
    )) {
      const liste = groupes.get(String(cid)) ?? [];
      liste.push({ id: nombre(gid), name: String(nom) });
      groupes.set(String(cid), liste);
    }
  const travaux = await travauxActifsDesCollections(x, ids);
  return lignes.map((r) => {
    const id = String(r["id"]);
    const etat = String(r["status"]);
    const visibilite = String(r["visibility"]);
    const travail: LigneTravailRag | undefined = travaux.get(id);
    return {
      id,
      name: String(r["name"]),
      owner: { id: nombre(r["owner_user_id"]), username: String(r["username"] ?? "") },
      visibility: (VISIBILITES.has(visibilite) ? visibilite : "private") as CollectionAdmin["visibility"],
      groups: groupes.get(id) ?? [],
      allow_source_open: nombre(r["allow_source_open"]) === 1,
      doc_count: nombre(r["doc_count"]),
      chunk_count: nombre(r["chunk_count"]),
      bytes: nombre(r["bytes"]),
      status: (ETATS_COLLECTION.has(etat) ? etat : "ready") as CollectionAdmin["status"],
      embed_model: String(r["embed_model"] ?? ""),
      created_at: nombre(r["created_at"]),
      updated_at: nombre(r["updated_at"]),
      last_indexed_at: r["dernier"] === null || r["dernier"] === undefined ? null : nombre(r["dernier"]),
      job: travail === undefined ? null : travailPublic(travail),
    };
  });
}

/** Page de toutes les collections de l'instance : métadonnées seulement, jamais un document, un passage ni la description. */
export async function listerCollectionsAdminRag(
  x: Executeur,
  f: FiltresCollectionsAdminRag,
): Promise<{ collections: CollectionAdmin[]; total: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (f.q !== undefined && f.q.trim() !== "") {
    conditions.push("(LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(u.username) LIKE ? ESCAPE '\\')");
    params.push(motifLike(f.q), motifLike(f.q));
  }
  if (f.ownerId !== undefined) {
    conditions.push("c.owner_user_id = ?");
    params.push(f.ownerId);
  }
  if (f.visibility !== undefined && VISIBILITES.has(f.visibility)) {
    conditions.push("c.visibility = ?");
    params.push(f.visibility);
  }
  if (f.status !== undefined && ETATS_COLLECTION.has(f.status)) {
    conditions.push("c.status = ?");
    params.push(f.status);
  }
  const ou = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [n] = await x.valeurs<[unknown]>(
    `SELECT COUNT(*) FROM rag_collections c JOIN users u ON u.id = c.owner_user_id ${ou}`,
    params,
  );
  const limite = Math.max(1, Math.min(LIMITE_MAX, Math.trunc(f.limite)));
  const lignes = await x.all(
    `SELECT ${COLONNES_ADMIN} FROM rag_collections c JOIN users u ON u.id = c.owner_user_id ${ou} ` +
      `ORDER BY ${ORDRES[f.tri ?? "nom"] ?? (ORDRES["nom"] as string)} LIMIT ${limite} OFFSET ${Math.max(0, Math.trunc(f.offset))}`,
    params,
  );
  return { collections: await completerCollections(x, lignes), total: nombre(n?.[0]) };
}

/** Une collection vue de la console, `null` si elle n'existe pas. */
async function lireCollectionAdminRag(x: Executeur, id: string): Promise<CollectionAdmin | null> {
  if (!estUuidRag(id)) return null;
  const lignes = await x.all(
    `SELECT ${COLONNES_ADMIN} FROM rag_collections c JOIN users u ON u.id = c.owner_user_id WHERE c.id = ?`,
    [id],
  );
  return (await completerCollections(x, lignes))[0] ?? null;
}

export const LIMITE_LISTE_ADMIN_RAG = { defaut: LIMITE_DEFAUT, max: LIMITE_MAX } as const;

/** Supprime une collection après saisie de son nom exact ; le propriétaire et les lecteurs de la publication sont prévenus. */
export async function supprimerCollectionAdminRag(
  dep: DependancesAdminRag,
  id: string,
  nomSaisi: string,
): Promise<{ id: string; name: string; owner: { id: number; username: string } }> {
  if (!estUuidRag(id)) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  const service = dep.service();
  if (service === null)
    throw new ErreurRouteRag(
      503,
      "rag_desactive",
      "Le RAG n'est pas encore démarré : réessayez dans un instant.",
    );
  const vue = await lireCollectionAdminRag(dep.base, id);
  if (vue === null) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  if (nomSaisi.normalize("NFC") !== vue.name.normalize("NFC"))
    throw new ErreurRouteRag(
      400,
      "nom_incorrect",
      "Le nom saisi ne correspond pas à celui de la collection.",
    );
  const partie = await service.supprimerCollectionParAdmin(id);
  await prevenirDeLaSuppression(dep.base, partie);
  return { id, name: vue.name, owner: vue.owner };
}

async function prevenirDeLaSuppression(
  base: Base,
  c: { id: string; owner_user_id: number; name: string; visibility: string; group_ids: readonly number[] },
): Promise<void> {
  try {
    await pousserNotification(
      base,
      c.owner_user_id,
      "rag_deleted_admin",
      `La collection ${c.name} a été supprimée`,
      {
        body: "Un administrateur a supprimé cette collection et ses documents.",
      },
    );
    if (c.visibility === "private") return;
    const lecteurs = [
      ...(await audiencePublicationRag(base, c.owner_user_id, c.visibility, c.group_ids)),
    ].slice(0, 500);
    for (const uid of lecteurs)
      await pousserNotification(base, uid, "rag_share_end", `La collection ${c.name} n'est plus disponible`, {
        body: "Un administrateur l'a supprimée : la collection partagée avec vous n'existe plus.",
      });
  } catch (e) {
    log.warn({ err: e }, `avis de la suppression de ${c.id} en échec`);
  }
}

// ── Quotas par compte ────────────────────────────────────────────────────

export interface CompteQuotaAdminRag {
  id: number;
  username: string;
  role: "admin" | "moderator" | "user";
  rag_allowed: boolean;
  usage: { storage_bytes: number; collections: number; documents: number };
  override: Partial<QuotasRag> | null;
  effective: QuotasRag;
}

const roleDe = (v: unknown): CompteQuotaAdminRag["role"] =>
  nombre(v) === 1 ? "admin" : nombre(v) === 2 ? "moderator" : "user";

async function completerComptes(
  x: Executeur,
  lignes: readonly { id: number; username: string; is_admin: unknown; reglages: Record<string, unknown> }[],
): Promise<CompteQuotaAdminRag[]> {
  const ids = lignes.map((l) => l.id);
  const collections = new Map<number, number>();
  const documents = new Map<number, { n: number; octets: number }>();
  for (const lot of lots(ids)) {
    for (const [uid, n] of await x.valeurs<[unknown, unknown]>(
      `SELECT owner_user_id, COUNT(*) FROM rag_collections WHERE owner_user_id IN (${marques(lot.length)}) GROUP BY owner_user_id`,
      lot,
    ))
      collections.set(nombre(uid), nombre(n));
    for (const [uid, n, octets] of await x.valeurs<[unknown, unknown, unknown]>(
      `SELECT c.owner_user_id, COUNT(d.id), COALESCE(SUM(d.bytes), 0) FROM rag_documents d JOIN rag_collections c ON c.id = d.collection_id ` +
        `WHERE c.owner_user_id IN (${marques(lot.length)}) GROUP BY c.owner_user_id`,
      lot,
    ))
      documents.set(nombre(uid), { n: nombre(n), octets: nombre(octets) });
  }
  const defauts = configRag().quotas;
  const sortie: CompteQuotaAdminRag[] = [];
  for (const l of lignes) {
    const surcharge = surchargeQuotaRag(l.reglages);
    const docs = documents.get(l.id);
    sortie.push({
      id: l.id,
      username: l.username,
      role: roleDe(l.is_admin),
      rag_allowed: await droitRag(x, l.id),
      usage: {
        storage_bytes: docs?.octets ?? 0,
        collections: collections.get(l.id) ?? 0,
        documents: docs?.n ?? 0,
      },
      override: surcharge,
      effective: lireQuotasRag(l.reglages["rag_quota"], defauts),
    });
  }
  return sortie;
}

async function tousLesComptes(
  x: Executeur,
  q: string | undefined,
): Promise<{ id: number; username: string; is_admin: unknown; reglages: Record<string, unknown> }[]> {
  const motif = q !== undefined && q.trim() !== "";
  const lignes = await x.all(
    `SELECT id, username, is_admin, settings_json FROM users ${motif ? "WHERE LOWER(username) LIKE ? ESCAPE '\\'" : ""} ORDER BY LOWER(username), id`,
    motif ? [motifLike(q)] : [],
  );
  return lignes.map((r) => ({
    id: nombre(r["id"]),
    username: String(r["username"]),
    is_admin: r["is_admin"],
    reglages: reglagesDepuis(r["settings_json"] ?? "{}"),
  }));
}

/** Comptes avec leur consommation RAG, leur surcharge de quota et les quotas effectifs. */
export async function listerComptesRag(
  x: Executeur,
  f: { q?: string | undefined; seulementSurcharges: boolean; offset: number; limite: number },
): Promise<{ accounts: CompteQuotaAdminRag[]; total: number }> {
  let tous = await tousLesComptes(x, f.q);
  if (f.seulementSurcharges) tous = tous.filter((c) => surchargeQuotaRag(c.reglages) !== null);
  const limite = Math.max(1, Math.min(LIMITE_MAX, Math.trunc(f.limite)));
  const page = tous.slice(Math.max(0, f.offset), Math.max(0, f.offset) + limite);
  return { accounts: await completerComptes(x, page), total: tous.length };
}

export interface CorpsQuotaCompteAdminRag {
  storage_mb?: number | null | undefined;
  collections?: number | null | undefined;
  file_mb?: number | null | undefined;
  docs_per_collection?: number | null | undefined;
  reset?: boolean | undefined;
}

/** Pose ou retire la surcharge d'un compte (une clé à `null` revient à l'instance, `reset` les retire toutes). Rien n'est supprimé : un quota plus bas que l'usage bloque seulement les nouveaux dépôts. */
export async function modifierQuotaCompteAdminRag(
  base: Base,
  uid: number,
  corps: CorpsQuotaCompteAdminRag,
): Promise<CompteQuotaAdminRag> {
  const [existe] = await base.valeurs<[unknown]>("SELECT id FROM users WHERE id = ?", [uid]);
  if (existe === undefined) throw new ErreurRouteRag(404, "compte_introuvable", "Compte introuvable.");
  let suite: Partial<QuotasRag> | null;
  if (corps.reset) suite = null;
  else {
    suite = { ...(surchargeQuotaRag(await getUserSettings(base, uid)) ?? {}) };
    for (const cle of CLES_QUOTAS) {
      const v = corps[cle];
      if (v === undefined) continue;
      if (v === null) delete suite[cle];
      else suite[cle] = v;
    }
    if (!Object.keys(suite).length) suite = null;
  }
  try {
    await definirQuotaRagCompte(base, uid, suite);
  } catch (e) {
    if (e instanceof RangeError) throw new ErreurRouteRag(400, "requete_invalide", e.message);
    throw e;
  }
  const [ligne] = await tousLesComptes(base, undefined).then((l) => l.filter((c) => c.id === uid));
  return (await completerComptes(base, ligne === undefined ? [] : [ligne]))[0] as CompteQuotaAdminRag;
}

// ── Réindexation globale (changement de modèle d'embedding) et travaux ───

type TravailAdmin = TravailRagPublic & { collection_name: string; owner: { id: number; username: string } };

async function travauxAvecNoms(x: Executeur, lignes: readonly LigneTravailRag[]): Promise<TravailAdmin[]> {
  const noms = new Map<string, { nom: string; uid: number; utilisateur: string }>();
  for (const lot of lots([...new Set(lignes.map((l) => l.collection_id))]))
    for (const [id, nom, uid, utilisateur] of await x.valeurs<[unknown, unknown, unknown, unknown]>(
      `SELECT c.id, c.name, c.owner_user_id, u.username FROM rag_collections c JOIN users u ON u.id = c.owner_user_id WHERE c.id IN (${marques(lot.length)})`,
      lot,
    ))
      noms.set(String(id), { nom: String(nom), uid: nombre(uid), utilisateur: String(utilisateur) });
  return lignes.map((l) => {
    const n = noms.get(l.collection_id);
    return {
      ...travailPublic(l),
      collection_name: n?.nom ?? "",
      owner: { id: n?.uid ?? l.owner_user_id, username: n?.utilisateur ?? "" },
    };
  });
}

/** Travaux d'indexation de tout le monde (les plus récents d'abord), avec le nom de la collection et son propriétaire ; aucun nom de document. */
export async function travauxAdminRag(
  x: Executeur,
  o: { actifs: boolean; limite: number },
): Promise<TravailAdmin[]> {
  return travauxAvecNoms(x, await listerTravauxRag(x, { actifs: o.actifs, limite: o.limite }));
}

/** Modèles d'embedding des collections, retard par rapport au modèle configuré et progression des migrations en cours. */
export async function reindexationAdminRag(x: Executeur) {
  const conf = configRag();
  const parModele = (
    await x.valeurs<[unknown, unknown]>(
      "SELECT embed_model, COUNT(*) FROM rag_collections GROUP BY embed_model ORDER BY COUNT(*) DESC, embed_model",
    )
  ).map(([m, n]) => ({ model: String(m ?? ""), collections: nombre(n) }));
  const vides = parModele.find((m) => m.model === "")?.collections ?? 0;
  const aJour = parModele.find((m) => m.model === conf.embed.model)?.collections ?? 0;
  const total = parModele.reduce((s, m) => s + m.collections, 0);
  const travaux = (await listerTravauxRag(x, { actifs: true, genre: "migrate", limite: 500 })).reverse();
  const jobs = await travauxAvecNoms(x, travaux);
  return {
    model: conf.embed.model,
    embed_configured: conf.embed.url !== "",
    to_migrate: total - vides - (conf.embed.model === "" ? 0 : aJour),
    up_to_date: aJour,
    empty: vides,
    by_model: parModele.filter((m) => m.model !== ""),
    progress: {
      collections: jobs.length,
      total: jobs.reduce((s, j) => s + j.total, 0),
      done: jobs.reduce((s, j) => s + j.done, 0),
      failed: jobs.reduce((s, j) => s + j.failed, 0),
    },
    jobs,
  };
}
