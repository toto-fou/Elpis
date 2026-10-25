// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/chats.ts — historique des conversations (`/api/saved/chats*`) et boîte de réception. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";
import { COLLECTIONS_CHAT_RAG_MAX, schemaReglageRagChat, schemaUuidRag } from "./rag";

export const schemaResumeChat = z.object({
  id: z.string(),
  title: z.string(),
  updated_at: horodatage,
  archived: z.boolean(),
});
export type ResumeChat = z.infer<typeof schemaResumeChat>;
export const schemaListeChats = z.object({ items: z.array(schemaResumeChat) });
export type ListeChats = z.infer<typeof schemaListeChats>;

/** Ce que le direct montre d'une étape et que la `tool_history` ne garde pas : durée, réflexion qui la précède, arrêt, capture. */
export const schemaMetaEtape = z.object({
  ms: entier.min(0).optional(),
  think: z.string().optional(),
  think_ms: entier.min(0).optional(),
  state: z.literal("stopped").optional(),
  shot: z.string().startsWith("/api/playwright/screenshot/").optional(),
  shot_step: entier.min(0).optional(),
});
export type MetaEtape = z.infer<typeof schemaMetaEtape>;

/** `tool_meta` d'un message assistant : étapes par `call_id`, réflexion d'après le dernier outil. */
export const schemaMetaOutils = z.object({
  steps: z.record(z.string(), schemaMetaEtape),
  tail: z.object({ think: z.string(), think_ms: entier.min(0).optional() }).optional(),
});
export type MetaOutils = z.infer<typeof schemaMetaOutils>;

/** `error` d'un message assistant dont le tour a échoué : message, détail technique, genre (`kind` de l'événement `error`). */
export const schemaErreurTour = z.object({ text: z.string(), detail: z.string(), kind: z.string() });
export type ErreurTour = z.infer<typeof schemaErreurTour>;

/** Message tel que le front l'enregistre ; à valider un par un : le serveur garde tel quel ce qu'il reçoit. */
export const schemaMessageStocke = z.looseObject({ role: z.string() });
export type MessageStocke = z.infer<typeof schemaMessageStocke>;

export const schemaChat = z.object({
  id: z.string(),
  title: z.string(),
  updated_at: horodatage,
  archived: z.boolean(),
  messages: z.array(z.unknown()),
  tools: z.array(z.string()).nullable(),
  plan_mode: z.boolean(),
  todos: z.array(z.unknown()),
  ctx_pruned_keys: z.array(z.unknown()),
  ctx_usage: dictionnaire.nullable(),
  llm_user_suffixes: dictionnaire,
  /** « Ne pas me réveiller » posé sur la conversation (tâches de fond) ; absent : défaut du compte (valeur effective dans `GET /api/jobs`). */
  wake_disabled: z.boolean().optional(),
  /** RAG du chat (`meta_json.rag`), collections réduites à celles que le compte lit encore ; absent si jamais réglé. */
  rag: schemaReglageRagChat.optional(),
});
export type Chat = z.infer<typeof schemaChat>;

/** `rag_collections` : collections actives scellées à la création (celles que le compte ne lit pas sont écartées). */
export const schemaCorpsNouveauChat = z.object({
  plan_mode: z.boolean().optional(),
  rag_collections: z.array(schemaUuidRag).max(COLLECTIONS_CHAT_RAG_MAX).optional(),
});
/** `rag_collections` : collections effectivement actives, rendu seulement si le corps en portait. */
export const schemaReponseNouveauChat = z.object({
  id: z.string(),
  rag_collections: z.array(schemaUuidRag).optional(),
});

export const schemaCorpsRenommage = z.object({ title: z.string() });
export const schemaCorpsOutilsChat = z.object({ tools: z.array(z.string()) });
export const schemaCorpsModePlan = z.object({ plan_mode: z.boolean() });
export const schemaReponseModePlan = z.object({ ok: z.literal(true), plan_mode: z.boolean() });

export const schemaCorpsSauvegardeMessages = z.object({
  messages: z.array(schemaMessageStocke),
  title: z.string().optional(),
});
/** `skipped` : un run tient le chat, le chat n'existe plus, ou le contenu reçu est plus court que le stocké. */
export const schemaReponseSauvegardeMessages = z.object({
  ok: z.literal(true),
  skipped: z.enum(["generation_running", "absent", "stale"]).optional(),
});
export type ReponseSauvegardeMessages = z.infer<typeof schemaReponseSauvegardeMessages>;

export const schemaCorpsIdsChats = z.object({ ids: z.array(z.string()) });
export const schemaReponseSuppressions = z.object({ ok: z.literal(true), deleted: entier });
export const schemaReponseArchivages = z.object({ ok: z.literal(true), archived: entier });

export const schemaReponseBoiteReception = z.object({ count: entier, prompts: entier });
