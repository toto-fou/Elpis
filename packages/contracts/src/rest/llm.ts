// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/llm.ts — connecteurs LLM du compte, catalogue et cycle de vie des modèles, santé et file d'attente (`/api/llm/*`) ; les flux SSE et les routes à joker sont hors registre. */
import { z } from "zod";

import { dictionnaire, entier, horodatage } from "./commun";
import { schemaChargeMoteur, schemaEtatModeles, schemaMoteurDeclare } from "../systeme";

const entierNul = entier.nullable();

/** Connecteur sans sa clé : `has_key` dit seulement qu'elle existe ; les trois limites sont `null` en découverte automatique. */
export const schemaConnecteurLlm = z.object({
  id: entier,
  owner_user_id: entierNul,
  scope: z.enum(["user", "shared"]),
  provider_type: z.string(),
  wire: z.string(),
  label: z.string(),
  base_url: z.string(),
  default_model: z.string(),
  models_json: z.string(),
  enabled: z.boolean(),
  key_scheme: z.string(),
  created_at: horodatage.nullable(),
  updated_at: horodatage.nullable(),
  last_used: horodatage.nullable(),
  has_key: z.boolean(),
  context_window: entierNul,
  max_models: entierNul,
  max_concurrency: entierNul,
});
export type ConnecteurLlm = z.infer<typeof schemaConnecteurLlm>;

export const schemaPresetFournisseur = z.object({
  wire: z.string(),
  base_url: z.string(),
  label: z.string(),
  admin_only: z.boolean(),
  user_base_locked: z.boolean(),
});
export const schemaReponseConnecteursLlm = z.object({
  connectors: z.array(schemaConnecteurLlm.extend({ provider_allowed: z.boolean() })),
  shared: z.array(schemaConnecteurLlm),
  presets: z.record(z.string(), schemaPresetFournisseur),
  allowed_provider_types: z.array(z.string()),
  builtin_allowed: z.boolean(),
  can_manage_models: z.boolean(),
});
export type ReponseConnecteursLlm = z.infer<typeof schemaReponseConnecteursLlm>;

export const schemaCorpsCreationConnecteurLlm = z.object({
  provider_type: z.string(),
  api_key: z.string(),
  label: z.string().optional(),
  base_url: z.string().optional(),
  default_model: z.string().optional(),
  models_json: z.string().optional(),
});
export const schemaReponseConnecteurCree = z.object({ ok: z.literal(true), id: entier });
/** Une clé vide laisse la clé enregistrée inchangée. */
export const schemaCorpsMajConnecteurLlm = z.object({
  label: z.string().optional(),
  default_model: z.string().optional(),
  models_json: z.string().optional(),
  enabled: z.boolean().optional(),
  api_key: z.string().optional(),
});

/** Sonde d'un moteur d'après son profil : adresses attendues, version, modèle servi, contexte, métriques, conseils (drapeau exact). */
export const schemaRapportMoteur = z.object({
  cle: z.string(),
  type: z.string(),
  libelle: z.string(),
  base_url: z.string(),
  joignable: z.boolean(),
  version: z.string().nullable(),
  modeles: z.array(z.object({ id: z.string(), max_model_len: entier.nullable() })),
  modele_declare: z.string(),
  modele_servi: z.string().nullable(),
  contexte: entier.nullable(),
  metriques: z.boolean().nullable(),
  tokenisation: z.boolean().nullable(),
  jetons_en_cache: z.boolean().nullable(),
  parseurs_connus: z.boolean(),
  parseur_reflexion: z.string().nullable(),
  parseur_outils: z.string().nullable(),
  concurrence: z.object({ mode: z.enum(["file", "moteur"]), max: entier.nullable() }),
  chargement: z.boolean(),
  cle_api: z.boolean(),
  adresses: z.array(z.object({ role: z.string(), chemin: z.string(), statut: entier, ok: z.boolean() })),
  charge: z
    .object({
      kv: z.object({ used: entier, total: entier, pct: z.number() }).nullable(),
      en_cours: z.number().nullable(),
      en_attente: z.number().nullable(),
      debit_tps: z.number().nullable(),
      cache_prefixe_pct: z.number().nullable(),
      ttft_s: z.number().nullable().optional(),
      prefill_tps: z.number().nullable().optional(),
    })
    .nullable(),
  conseils: z.array(
    z.object({ code: z.string(), niveau: z.enum(["erreur", "avertissement", "info"]), message: z.string() }),
  ),
  sonde_a: z.number(),
});
export type RapportMoteur = z.infer<typeof schemaRapportMoteur>;

export const schemaReponseTestConnecteurLlm = z.object({
  ok: z.boolean(),
  status: entier,
  models_count: entier,
  fallback: z.string().optional(),
  error: z.string().optional(),
  hint: z.string().optional(),
  sonde: schemaRapportMoteur.optional(),
});

/** Modèles d'un connecteur : liste ordonnée (gratuits en tête) ; `fallback` signale une liste saisie à la main ou le catalogue du fournisseur. */
export const schemaReponseModelesConnecteur = z.object({
  connector_id: entier,
  default_model: z.string(),
  provider_type: z.string(),
  router: z.boolean(),
  statuses: z.record(z.string(), z.string()),
  can_manage: z.boolean(),
  ok: z.boolean().optional(),
  status: entier.optional(),
  models: z.array(z.string()).optional(),
  free: z.array(z.string()).optional(),
  fallback: z.string().optional(),
  error: z.string().optional(),
  moteur: schemaMoteurDeclare.optional(),
  kv_cache: z.object({ used: entier, total: entier, pct: z.number() }).optional(),
  n_ctx: entier.optional(),
  charge: schemaChargeMoteur.optional(),
});

/** Catalogue du serveur intégré (état poussé aussi par SSE) ou d'un serveur nommé (`engine`, `router`, `can_manage`) ; `allowed: false` si le compte n'y a pas droit. */
export const schemaCatalogueModeles = schemaEtatModeles.extend({
  engine: z.string().optional(),
  router: z.boolean().optional(),
  can_manage: z.boolean().optional(),
  allowed: z.boolean().optional(),
});
export type CatalogueModeles = z.infer<typeof schemaCatalogueModeles>;

export const schemaReponseSanteLlm = z.object({
  server_reachable: z.boolean(),
  status: z.string(),
  models_loaded: z.array(z.looseObject({ id: z.string() })),
  kv_cache: z.object({ used: entier, total: entier, pct: z.number() }),
  metrics: dictionnaire,
  /** Fenêtre (`/props` de llama.cpp ou `max_model_len`) et créneaux, quand le moteur les annonce. */
  props: z.looseObject({ n_ctx: entier.optional(), total_slots: entier.optional() }).optional(),
  moteur: schemaMoteurDeclare.optional(),
  charge: schemaChargeMoteur.optional(),
});

export const schemaCorpsChargementModele = z.object({
  model_path: z.string(),
  engine: z.string().optional(),
});
export const schemaCorpsDechargementModele = z.object({
  model_id: z.string(),
  engine: z.string().optional(),
  force: z.boolean().optional(),
});
/** Résultat d'un chargement ou d'un déchargement : `ok` faux porte `error`, et `busy_model` quand une génération tient le modèle. */
export const schemaReponseCycleModele = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  busy_model: z.string().optional(),
  active_count: entier.optional(),
});

export const schemaCorpsInfill = z.object({
  input_prefix: z.string().optional(),
  input_suffix: z.string().optional(),
  model: z.string().optional(),
});
/** Complétion du serveur ou `{ok: false, error}` quand l'ordonnanceur refuse. */
export const schemaReponseInfill = z.looseObject({
  ok: z.literal(false).optional(),
  error: z.string().optional(),
});

/** Charge du serveur intégré : détenteurs, attentes et saturation par modèle. */
export const schemaReponseFileLlm = z.object({
  llm: z.object({
    in_flight: entier,
    waiting: entier,
    capacity: entier,
    saturation_ratio: z.number(),
    models: z.array(z.object({ model: z.string(), holders: entier, max: entier, waiters: entier })),
  }),
  chat: z.object({ active_estimate: entier }),
  ts: horodatage,
});
export type ReponseFileLlm = z.infer<typeof schemaReponseFileLlm>;

/** Décomposition des paramètres d'échantillonnage d'un modèle (panneau Sampling) ; vue dégradée sans accès `/props`. */
export const schemaParametresEffectifs = z.looseObject({
  model_id: z.string().nullable(),
  task: z.string(),
  degraded: z.boolean().optional(),
  props_unavailable: z.boolean().optional(),
  supports_thinking: z.boolean().nullable(),
  supports_reasoning_effort: z.boolean().nullable(),
  reasoning_effort_values: z.array(z.string()),
  supports_preserve_reasoning: z.boolean().nullable(),
  supports_continue_final_message: z.boolean().nullable(),
  sources: z.looseObject({
    props: dictionnaire,
    task_profile: dictionnaire,
    user_override: dictionnaire,
  }),
  effective: dictionnaire,
  param_sources: z.record(z.string(), z.string()),
  agent_defaults: z.looseObject({
    max_tool_iterations: z.number().optional(),
    thinking_budget_tokens: z.number().optional(),
  }),
});
export type ParametresEffectifs = z.infer<typeof schemaParametresEffectifs>;
