// SPDX-License-Identifier: MIT
/** packages/config/src/rag.ts — section `rag` de config.json relue à chaque appel : magasin, Qdrant, embeddings, reranker, OCR, groupes autorisés, quotas, indexation. */
import path from "node:path";

import { stripPy } from "@elpis/commun";

import { estDict } from "./brut";
import type { Dict } from "./brut";
import { config } from "./instance";
import { configView } from "./vivant";

export interface QuotasRag {
  storage_mb: number;
  collections: number;
  file_mb: number;
  docs_per_collection: number;
}

export interface ConfigRag {
  /** Racine absolue du magasin : `RAG_STORE_DIR`, sinon `rag.store_dir`, sinon `<dossier de la base>/rag`. */
  store_dir: string;
  qdrant_url: string;
  embed: { url: string; model: string; api_key: string; batch: number; timeout_s: number };
  reranker: { enabled: boolean; url: string; model: string };
  /** Modèle de vision qui lit les pages scannées (OpenAI-compatible) ; `url` vide = pas d'OCR. Envoyé à l'extracteur à chaque extraction. */
  ocr: {
    url: string;
    model: string;
    api_key: string;
    timeout_s: number;
    max_side_px: number;
    max_tokens: number;
  };
  /** Groupes qui ont le droit RAG ; vide = tous les comptes (l'admin l'a toujours). */
  groups: number[];
  quotas: QuotasRag;
  indexation: { concurrence: number; par_compte: number };
}

export const QUOTAS_RAG_DEFAUT: Readonly<QuotasRag> = Object.freeze({
  storage_mb: 2048,
  collections: 10,
  file_mb: 200,
  docs_per_collection: 2000,
});

/** Bornes hautes des quotas (au-delà : la valeur par défaut s'applique). */
export const QUOTAS_RAG_MAX: Readonly<QuotasRag> = Object.freeze({
  storage_mb: 10_000_000,
  collections: 10_000,
  file_mb: 100_000,
  docs_per_collection: 1_000_000,
});

const QDRANT_URL_DEFAUT = "http://127.0.0.1:6333";
const MODELE_EMBED_DEFAUT = "bge-m3";
const MODELE_RERANKER_DEFAUT = "bge-reranker-v2-m3";

function section(v: unknown, cle: string): Dict {
  const s = estDict(v) ? v[cle] : undefined;
  return estDict(s) ? s : {};
}

function texte(v: unknown, defaut: string): string {
  return typeof v === "string" && stripPy(v) ? stripPy(v) : defaut;
}

/** Entier JSON dans `[bas, haut]`, sinon le défaut (ni texte, ni flottant, ni booléen). */
function entier(v: unknown, defaut: number, bas: number, haut: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= bas && v <= haut ? v : defaut;
}

function booleen(v: unknown, defaut: boolean): boolean {
  return typeof v === "boolean" ? v : defaut;
}

/** Adresse http(s) sans `/` final ; illisible : le défaut. */
export function urlHttp(v: unknown, defaut: string): string {
  const brut = texte(v, "");
  if (!brut) return defaut;
  try {
    const u = new URL(brut);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return defaut;
  } catch {
    return defaut;
  }
  return brut.replace(/\/+$/u, "");
}

/** Identifiants de groupes positifs, dédoublonnés, 200 au plus ; le reste est ignoré. */
export function groupesRag(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const g of v.slice(0, 200))
    if (typeof g === "number" && Number.isSafeInteger(g) && g > 0 && !out.includes(g)) out.push(g);
  return out;
}

/** Quotas lus d'un objet (`rag.quotas` ou surcharge d'un compte) ; une clé absente ou hors bornes garde `defaut`. */
export function lireQuotasRag(v: unknown, defaut: Readonly<QuotasRag> = QUOTAS_RAG_DEFAUT): QuotasRag {
  const q = estDict(v) ? v : {};
  const lire = (cle: keyof QuotasRag): number => entier(q[cle], defaut[cle], 0, QUOTAS_RAG_MAX[cle]);
  return {
    storage_mb: lire("storage_mb"),
    collections: lire("collections"),
    file_mb: lire("file_mb"),
    docs_per_collection: lire("docs_per_collection"),
  };
}

function dossierMagasin(v: unknown): string {
  const env = stripPy(process.env["RAG_STORE_DIR"] ?? "");
  const choisi = env || texte(v, "");
  const defaut = path.join(path.dirname(config.DB_PATH), "rag");
  if (!choisi || choisi.includes("\0")) return defaut;
  const absolu = path.resolve(config.PROJECT_ROOT, choisi);
  return absolu === path.parse(absolu).root ? defaut : absolu;
}

/** Section `rag` de la vue courante de config.json, défauts et bornes appliqués à la lecture. */
export function configRag(vue: unknown = configView()): ConfigRag {
  const rag = section(vue, "rag");
  const embed = section(rag, "embed");
  const reranker = section(rag, "reranker");
  const ocr = section(rag, "ocr");
  const indexation = section(rag, "indexation");
  const concurrence = entier(indexation["concurrence"], 2, 1, 16);
  return {
    store_dir: dossierMagasin(rag["store_dir"]),
    qdrant_url: urlHttp(rag["qdrant_url"], QDRANT_URL_DEFAUT),
    embed: {
      url: urlHttp(embed["url"], ""),
      model: texte(embed["model"], MODELE_EMBED_DEFAUT),
      api_key: texte(embed["api_key"], ""),
      batch: entier(embed["batch"], 32, 1, 512),
      timeout_s: entier(embed["timeout_s"], 60, 1, 600),
    },
    reranker: {
      enabled: booleen(reranker["enabled"], false),
      url: urlHttp(reranker["url"], ""),
      model: texte(reranker["model"], MODELE_RERANKER_DEFAUT),
    },
    ocr: {
      url: urlHttp(ocr["url"], ""),
      model: texte(ocr["model"], ""),
      api_key: texte(ocr["api_key"], ""),
      timeout_s: entier(ocr["timeout_s"], 180, 5, 3600),
      max_side_px: entier(ocr["max_side_px"], 1280, 256, 4096),
      max_tokens: entier(ocr["max_tokens"], 8192, 256, 65536),
    },
    groups: groupesRag(rag["groups"]),
    quotas: lireQuotasRag(rag["quotas"]),
    indexation: {
      concurrence,
      par_compte: Math.min(concurrence, entier(indexation["par_compte"], 1, 1, 16)),
    },
  };
}
