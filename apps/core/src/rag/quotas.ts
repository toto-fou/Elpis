// SPDX-License-Identifier: MIT
/** apps/core/src/rag/quotas.ts — quotas RAG d'un compte : défauts de l'instance (`rag.quotas`) surchargés clé par clé par `settings_json.rag_quota` (posé par l'admin). */
import { getUserSettings, mergeUserSettings } from "@elpis/auth";
import { configRag, lireQuotasRag, QUOTAS_RAG_MAX } from "@elpis/config";
import type { QuotasRag } from "@elpis/config";
import type { Base, Executeur } from "@elpis/db";

export const CLE_QUOTA_RAG = "rag_quota";

const CLES: readonly (keyof QuotasRag)[] = ["storage_mb", "collections", "file_mb", "docs_per_collection"];

/** Quotas effectifs du compte, relus à chaque appel (config.json et réglages du compte). */
export async function quotasRag(base: Executeur, uid: number): Promise<QuotasRag> {
  const instance = configRag().quotas;
  const reglages = await getUserSettings(base, uid);
  return lireQuotasRag(reglages[CLE_QUOTA_RAG], instance);
}

/** Surcharge propre au compte (`null` : aucune) ; seules les clés valides sont gardées. */
export function surchargeQuotaRag(reglages: Record<string, unknown>): Partial<QuotasRag> | null {
  const brut = reglages[CLE_QUOTA_RAG];
  if (brut === null || typeof brut !== "object" || Array.isArray(brut)) return null;
  const out: Partial<QuotasRag> = {};
  for (const cle of CLES) {
    const v = (brut as Record<string, unknown>)[cle];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= QUOTAS_RAG_MAX[cle]) out[cle] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Pose (ou retire avec `null`) la surcharge du compte ; une valeur hors bornes lève `RangeError` sans rien écrire. */
export async function definirQuotaRagCompte(
  base: Base,
  uid: number,
  surcharge: Partial<Record<keyof QuotasRag, number>> | null,
): Promise<Partial<QuotasRag> | null> {
  let propre: Partial<QuotasRag> | null = null;
  if (surcharge !== null) {
    propre = {};
    for (const cle of CLES) {
      const v = surcharge[cle];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 0 || v > QUOTAS_RAG_MAX[cle])
        throw new RangeError(`${cle} : entier de 0 à ${QUOTAS_RAG_MAX[cle]} attendu`);
      propre[cle] = v;
    }
    if (!Object.keys(propre).length) propre = null;
  }
  await mergeUserSettings(base, uid, (s) => {
    if (propre === null) delete s[CLE_QUOTA_RAG];
    else s[CLE_QUOTA_RAG] = { ...propre };
  });
  return propre;
}
