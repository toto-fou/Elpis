// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/rag-admin.ts — console d'administration du RAG : état des services, collections (métadonnées seulement), suppression, quotas par compte, réindexation globale, travaux. */
import { z } from "zod";

import { entier, horodatage } from "./commun";
import { schemaEtatCollectionRag, schemaTravailRag, schemaUuidRag, schemaVisibiliteRag } from "./rag";

/** Codes d'erreur propres à la console du RAG (les refus communs sont dans `CODES_ERREUR_ROUTES_RAG`). */
export const CODES_ERREUR_ADMIN_RAG = ["nom_incorrect", "compte_introuvable", "service_inconnu"] as const;
export type CodeErreurAdminRag = (typeof CODES_ERREUR_ADMIN_RAG)[number];

/** Quotas par compte : stockage en Mo, nombre de collections, taille d'un fichier en Mo, documents par collection. */
export const schemaQuotasRag = z.object({
  storage_mb: entier.nonnegative(),
  collections: entier.nonnegative(),
  file_mb: entier.nonnegative(),
  docs_per_collection: entier.nonnegative(),
});
export type QuotasRagVue = z.infer<typeof schemaQuotasRag>;
export const CLES_QUOTAS_RAG = ["storage_mb", "collections", "file_mb", "docs_per_collection"] as const;

const schemaCompteRef = z.object({ id: entier, username: z.string() });

const schemaServiceExterne = z.object({
  configured: z.boolean(),
  url: z.string(),
  ok: z.boolean().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});

export const schemaTravauxActifsRag = z.object({
  queued: entier.nonnegative(),
  running: entier.nonnegative(),
  paused: entier.nonnegative(),
});

/** État des services et de l'indexation ; les sondes de l'extracteur et de Qdrant sont gardées quelques secondes. */
export const schemaReponseEtatAdminRag = z.object({
  enabled: z.boolean(),
  extractor: schemaServiceExterne.extend({ soffice: z.boolean().nullable(), ocr: z.boolean().nullable() }),
  qdrant: schemaServiceExterne,
  embed: z.object({
    configured: z.boolean(),
    url: z.string(),
    model: z.string(),
    has_api_key: z.boolean(),
  }),
  reranker: z.object({ enabled: z.boolean(), url: z.string(), model: z.string() }),
  ocr: z.object({ configured: z.boolean(), url: z.string(), model: z.string(), has_api_key: z.boolean() }),
  groups: z.array(entier),
  quotas: schemaQuotasRag,
  quotas_max: schemaQuotasRag,
  indexation: z.object({
    concurrence: entier,
    par_compte: entier,
    jobs: schemaTravauxActifsRag,
    last_heartbeat: horodatage.nullable(),
  }),
  totals: z.object({
    collections: entier.nonnegative(),
    documents: entier.nonnegative(),
    bytes: entier.nonnegative(),
    owners: entier.nonnegative(),
  }),
});
export type EtatAdminRag = z.infer<typeof schemaReponseEtatAdminRag>;

export const SERVICES_ESSAI_RAG = ["embeddings", "reranker", "qdrant", "ocr"] as const;
export type ServiceEssaiRag = (typeof SERVICES_ESSAI_RAG)[number];
/** Valeurs du formulaire (sinon celles enregistrées) ; la clé enregistrée ne part qu'à l'adresse enregistrée. */
export const schemaCorpsEssaiServiceRag = z.object({
  url: z.string().max(2048).optional(),
  model: z.string().max(200).optional(),
  api_key: z.string().max(4096).optional(),
});
export const schemaReponseEssaiServiceRag = z.union([
  z.object({
    ok: z.literal(true),
    service: z.enum(SERVICES_ESSAI_RAG),
    detail: z.string(),
    duration_ms: entier.nonnegative(),
    dimension: entier.positive().optional(),
    version: z.string().optional(),
  }),
  z.object({ ok: z.literal(false), service: z.enum(SERVICES_ESSAI_RAG), error: z.string() }),
]);

/** Travail d'indexation en cours vu de la console : jamais le nom d'un document. */
export const schemaTravailAdminRag = schemaTravailRag.extend({
  collection_name: z.string(),
  owner: schemaCompteRef,
});
export type TravailAdminRag = z.infer<typeof schemaTravailAdminRag>;

/** Collection vue de la console : métadonnées seulement (ni description, ni document, ni passage). */
export const schemaCollectionAdminRag = z.object({
  id: schemaUuidRag,
  name: z.string(),
  owner: schemaCompteRef,
  visibility: schemaVisibiliteRag,
  groups: z.array(z.object({ id: entier, name: z.string() })),
  allow_source_open: z.boolean(),
  doc_count: entier.nonnegative(),
  chunk_count: entier.nonnegative(),
  bytes: entier.nonnegative(),
  status: schemaEtatCollectionRag,
  embed_model: z.string(),
  created_at: horodatage,
  updated_at: horodatage,
  last_indexed_at: horodatage.nullable(),
  job: schemaTravailRag.nullable(),
});
export type CollectionAdminRag = z.infer<typeof schemaCollectionAdminRag>;

export const TRIS_COLLECTIONS_ADMIN_RAG = ["nom", "auteur", "taille", "documents", "recent"] as const;
export const schemaRequeteCollectionsAdminRag = z.object({
  q: z.string().max(200).optional(),
  owner_id: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/u)
    .optional(),
  visibility: schemaVisibiliteRag.optional(),
  status: schemaEtatCollectionRag.optional(),
  tri: z.enum(TRIS_COLLECTIONS_ADMIN_RAG).optional(),
  offset: z
    .string()
    .regex(/^[0-9]{1,9}$/u)
    .optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/u)
    .optional(),
});
export const schemaReponseCollectionsAdminRag = z.object({
  collections: z.array(schemaCollectionAdminRag),
  total: entier.nonnegative(),
  offset: entier.nonnegative(),
  limit: entier.positive(),
});

/** Suppression : la saisie du nom exact de la collection est exigée. */
export const schemaCorpsSuppressionAdminRag = z.object({ name: z.string().max(200) });
export const schemaReponseSuppressionAdminRag = z.object({
  ok: z.literal(true),
  deleted: z.object({ id: schemaUuidRag, name: z.string(), owner: schemaCompteRef }),
});

const ROLES_COMPTE_RAG = ["admin", "moderator", "user"] as const;
export const schemaCompteQuotaRag = z.object({
  id: entier,
  username: z.string(),
  role: z.enum(ROLES_COMPTE_RAG),
  rag_allowed: z.boolean(),
  usage: z.object({
    storage_bytes: entier.nonnegative(),
    collections: entier.nonnegative(),
    documents: entier.nonnegative(),
  }),
  override: schemaQuotasRag.partial().nullable(),
  effective: schemaQuotasRag,
});
export type CompteQuotaRag = z.infer<typeof schemaCompteQuotaRag>;
export const schemaRequeteComptesRag = z.object({
  q: z.string().max(200).optional(),
  seulement_surcharges: z.enum(["0", "1", "true", "false"]).optional(),
  offset: z
    .string()
    .regex(/^[0-9]{1,9}$/u)
    .optional(),
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/u)
    .optional(),
});
export const schemaReponseComptesRag = z.object({
  accounts: z.array(schemaCompteQuotaRag),
  total: entier.nonnegative(),
  offset: entier.nonnegative(),
  limit: entier.positive(),
});
/** Surcharge d'un compte : une clé à `null` revient à la valeur de l'instance, `reset` les retire toutes. */
export const schemaCorpsQuotaCompteRag = z.object({
  storage_mb: entier.nonnegative().nullable().optional(),
  collections: entier.nonnegative().nullable().optional(),
  file_mb: entier.nonnegative().nullable().optional(),
  docs_per_collection: entier.nonnegative().nullable().optional(),
  reset: z.boolean().optional(),
});
export const schemaReponseQuotaCompteRag = z.object({ account: schemaCompteQuotaRag });

/** Modèles d'embedding des collections et migrations en cours. */
export const schemaReponseReindexationGlobaleRag = z.object({
  model: z.string(),
  embed_configured: z.boolean(),
  to_migrate: entier.nonnegative(),
  up_to_date: entier.nonnegative(),
  empty: entier.nonnegative(),
  by_model: z.array(z.object({ model: z.string(), collections: entier.nonnegative() })),
  progress: z.object({
    collections: entier.nonnegative(),
    total: entier.nonnegative(),
    done: entier.nonnegative(),
    failed: entier.nonnegative(),
  }),
  jobs: z.array(schemaTravailAdminRag),
});
export const schemaCorpsReindexerToutRag = z.object({ force: z.boolean().optional() });
export const schemaReponseReindexerToutRag = z.object({
  started: entier.nonnegative(),
  to_migrate: entier.nonnegative(),
});

export const schemaRequeteTravauxAdminRag = z.object({
  actifs: z.enum(["0", "1", "true", "false"]).optional(),
  limite: z
    .string()
    .regex(/^[0-9]{1,3}$/u)
    .optional(),
});
export const schemaReponseTravauxAdminRag = z.object({ jobs: z.array(schemaTravailAdminRag) });
export const schemaReponseTravailAdminRag = z.object({ job: schemaTravailRag });

export type ReindexationAdminRag = z.infer<typeof schemaReponseReindexationGlobaleRag>;
export type EssaiServiceRag = z.infer<typeof schemaReponseEssaiServiceRag>;
