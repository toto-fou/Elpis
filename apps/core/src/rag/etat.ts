// SPDX-License-Identifier: MIT
/** apps/core/src/rag/etat.ts — état du RAG pour un compte : droit, services (embeddings, extracteur, Qdrant) avec la raison lisible d'une indisponibilité, quotas et utilisation. */
import { configRag } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { ClientQdrant } from "@elpis/rag";

import { droitRag } from "./acces";
import { getServiceUrl, ping } from "./client";
import { quotasRag } from "./quotas";
import type { ServiceIndexationRag } from "./service";
import { ETATS_TRAVAIL_ACTIFS, octetsDuCompte } from "./travaux";

const SONDE_MS = 2_500;
const VALIDITE_SONDE_MS = 5_000;

export interface DependancesEtatRag {
  readonly base: Base;
  readonly service: () => ServiceIndexationRag | null;
  readonly qdrant: () => ClientQdrant;
  /** Sonde de l'extracteur (remplaçable) : `ok`, et ses capacités quand il les annonce. */
  readonly sondeExtracteur?: () => Promise<{ ok: boolean; ocr: boolean | null; soffice: boolean | null }>;
}

export interface EtatRagVue {
  allowed: boolean;
  usable: boolean;
  reason: { code: string; message: string } | null;
  can_publish_all: boolean;
  embed: { configured: boolean; model: string };
  extractor: { configured: boolean; ok: boolean | null; ocr: boolean | null; soffice: boolean | null };
  qdrant: { configured: boolean; ok: boolean | null };
  reranker: { enabled: boolean };
  quotas: { storage_mb: number; collections: number; file_mb: number; docs_per_collection: number };
  usage: { storage_bytes: number; collections: number; documents: number };
  active_jobs: number;
}

interface Sonde {
  readonly t: number;
  readonly extracteur: { ok: boolean; ocr: boolean | null; soffice: boolean | null };
  readonly qdrant: boolean;
}

const sondes = new Map<string, Sonde>();

async function sonderExtracteur(): Promise<{ ok: boolean; ocr: boolean | null; soffice: boolean | null }> {
  try {
    const r = await ping(null, null, SONDE_MS / 1000);
    const o = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
    return { ok: o["ok"] !== false, ocr: bool(o["ocr"]), soffice: bool(o["soffice"]) };
  } catch {
    return { ok: false, ocr: null, soffice: null };
  }
}

/** Sondes des deux services, gardées 5 s par adresse : la page est rouverte souvent, les services ne sont pas à marteler. */
async function sonder(dep: DependancesEtatRag): Promise<Sonde> {
  const cle = `${getServiceUrl()}|${configRag().qdrant_url}`;
  const vue = sondes.get(cle);
  if (vue !== undefined && Date.now() - vue.t < VALIDITE_SONDE_MS) return vue;
  const [extracteur, qdrant] = await Promise.all([
    getServiceUrl() === ""
      ? Promise.resolve({ ok: false, ocr: null, soffice: null })
      : (dep.sondeExtracteur ?? sonderExtracteur)(),
    dep
      .qdrant()
      .sante(AbortSignal.timeout(SONDE_MS))
      .then((s) => s.ok)
      .catch(() => false),
  ]);
  const neuve: Sonde = { t: Date.now(), extracteur, qdrant };
  sondes.set(cle, neuve);
  if (sondes.size > 16) sondes.delete(sondes.keys().next().value as string);
  return neuve;
}

/** Oublie les sondes gardées (tests). */
export function oublierSondesRag(): void {
  sondes.clear();
}

const nombre = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

function raison(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/** État du RAG pour `uid` : utilisable ou non (première raison rencontrée), services, quotas et utilisation. */
export async function etatRag(dep: DependancesEtatRag, uid: number): Promise<EtatRagVue> {
  const conf = configRag();
  const autorise = await droitRag(dep.base, uid);
  const [moi] = await dep.base.valeurs<[unknown]>("SELECT is_admin FROM users WHERE id = ?", [uid]);
  const quotas = await quotasRag(dep.base, uid);
  const [colls] = await dep.base.valeurs<[unknown]>(
    "SELECT COUNT(*) FROM rag_collections WHERE owner_user_id = ?",
    [uid],
  );
  const [docs] = await dep.base.valeurs<[unknown]>(
    "SELECT COUNT(*) FROM rag_documents d JOIN rag_collections c ON c.id = d.collection_id WHERE c.owner_user_id = ?",
    [uid],
  );
  const [actifs] = await dep.base.valeurs<[unknown]>(
    `SELECT COUNT(*) FROM rag_jobs WHERE owner_user_id = ? AND status IN ${ETATS_TRAVAIL_ACTIFS}`,
    [uid],
  );
  const embedConfigure = conf.embed.url !== "";
  const extracteurConfigure = getServiceUrl() !== "";
  const base: EtatRagVue = {
    allowed: autorise,
    usable: false,
    reason: null,
    can_publish_all: nombre(moi?.[0]) === 1,
    embed: { configured: embedConfigure, model: conf.embed.model },
    extractor: { configured: extracteurConfigure, ok: null, ocr: null, soffice: null },
    qdrant: { configured: conf.qdrant_url !== "", ok: null },
    reranker: { enabled: conf.reranker.enabled && conf.reranker.url !== "" },
    quotas,
    usage: {
      storage_bytes: await octetsDuCompte(dep.base, uid),
      collections: nombre(colls?.[0]),
      documents: nombre(docs?.[0]),
    },
    active_jobs: nombre(actifs?.[0]),
  };
  if (!autorise)
    return { ...base, reason: raison("rag_interdit", "Le RAG n'est pas ouvert à votre compte.") };
  if (!embedConfigure)
    return {
      ...base,
      reason: raison(
        "embeddings_non_configures",
        "Le RAG est désactivé : aucun serveur d'embeddings n'est configuré.",
      ),
    };
  if (!extracteurConfigure)
    return {
      ...base,
      reason: raison(
        "extracteur_non_configure",
        "Le RAG est désactivé : l'extracteur de documents n'est pas configuré.",
      ),
    };
  const sonde = await sonder(dep);
  const vu: EtatRagVue = {
    ...base,
    extractor: {
      configured: true,
      ok: sonde.extracteur.ok,
      ocr: sonde.extracteur.ok && sonde.extracteur.ocr !== false && conf.ocr.url !== "",
      soffice: sonde.extracteur.soffice,
    },
    qdrant: { ...base.qdrant, ok: sonde.qdrant },
  };
  if (!sonde.extracteur.ok)
    return { ...vu, reason: raison("extracteur_injoignable", "L'extracteur de documents est injoignable.") };
  if (!sonde.qdrant)
    return { ...vu, reason: raison("qdrant_injoignable", "La base vectorielle (Qdrant) est injoignable.") };
  const attentes = (await dep.service()?.etat())?.travailleur?.attentes ?? [];
  if (attentes.some((a) => a.service === "embeddings" && a.jusqua > Date.now() / 1000))
    return { ...vu, reason: raison("embeddings_injoignables", "Le serveur d'embeddings est injoignable.") };
  return { ...vu, usable: true };
}
