// SPDX-License-Identifier: MIT
/** packages/contracts/src/rest/reglages.ts — réglages du compte (`/api/settings`), avatars, modèles de sous-agents, aide en ligne. */
import { z } from "zod";

import { modeReflexionAgent, schemaLectureSeuleAgents, schemaReflexionAgents } from "./admin-agents";
import { dictionnaire, entier } from "./commun";

const reglagesEcrivables = {
  mcp_servers: z.array(dictionnaire),
  shared_mcp_visible: z.array(z.unknown()),
  active_mcp_url: z.string(),
  system_prompt: z.string(),
  assistant_name: z.string(),
  enable_editor: z.boolean(),
  enable_preview: z.boolean(),
  enable_mcp: z.boolean(),
  enable_rag: z.boolean(),
  enable_model_selector: z.boolean(),
  enable_charts: z.boolean(),
  editor_ratio: z.number(),
  editor_dark_mode: z.boolean(),
  dark_mode: z.boolean(),
  dark_mode_auto: z.boolean(),
  auto_open_editor_on_write: z.boolean(),
  editor_font_size: z.number(),
  editor_font_family: z.string(),
  editor_tab_size: z.number(),
  editor_insert_spaces: z.boolean(),
  editor_word_wrap: z.string(),
  editor_minimap: z.boolean(),
  editor_line_numbers: z.boolean(),
  editor_edit_highlight: z.boolean(),
  editor_auto_save: z.string(),
  editor_persist_tabs: z.boolean(),
  editor_follow_active: z.boolean(),
  chat_width: z.unknown(),
  sandbox_mode: z.unknown(),
  network_profile_id: z.unknown(),
  thinking_mode: z.unknown(),
  active_mcp_ids: z.array(z.string()),
  selected_model: z.unknown(),
  ui_lang: z.unknown(),
  ui_theme: z.unknown(),
  skin: z.string(),
  welcome_mascot: z.string(),
  welcome_mascot_anime: z.boolean(),
  memory_enabled: z.boolean(),
  hide_thinking: z.boolean(),
  agents_enabled: z.boolean(),
  custom_agents: z.array(dictionnaire),
  opencode_mcp_families: z.record(z.string(), z.boolean()),
  live_shell_enabled: z.boolean(),
  voice_input_enabled: z.boolean(),
  voice_reply_enabled: z.boolean(),
  voice_reply_tools_enabled: z.boolean(),
  compression_enabled: z.boolean(),
  compression_threshold_pct: z.number(),
  compression_threshold_tokens: z.number(),
  compression_max_rounds: z.number(),
  image_enabled: z.boolean(),
  image_tool_enabled: z.boolean(),
  /** « Créer des routines » : outil routine_save du modèle ; absent = vrai. */
  routine_tool_enabled: z.boolean(),
  image_prefs: dictionnaire,
  /** Défaut du compte de « Ne pas me réveiller » (tâches de fond) : absent = vrai (réveil actif). */
  jobs_wake: z.boolean(),
  /** « Masquer les captures web » : captures du navigateur cachées dans le fil ; absent = faux. */
  hide_web_screenshots: z.boolean(),
  /** Déroulé d'un tour dans le fil : classique (défaut), travail en bloc, chronologie, journal. */
  chat_workflow: z.enum(["classic", "work_block", "timeline", "terminal"]),
  /** Contexte dans la rangée du composeur : jetons utilisés / fenêtre (défaut), bloc qui se remplit, pourcentage, anneau. */
  context_display: z.enum(["tokens", "fill", "percent", "ring"]),
  /** Réflexions dans le fil : repliées (défaut), dépliées, masquées. */
  thinking_display: z.enum(["collapsed", "expanded", "hidden"]),
  /** Métriques du pied de réponse : complètes (défaut), essentielles, masquées. */
  footer_metrics: z.enum(["full", "essential", "hidden"]),
  /** Densité du fil : confortable (défaut), compacte. */
  thread_density: z.enum(["comfortable", "compact"]),
};

/** Corps du PUT : clés connues de la liste blanche, toutes facultatives ; le serveur ignore les autres. */
const reglagesFacultatifs = z.object(reglagesEcrivables).partial();
export const schemaCorpsReglages = reglagesFacultatifs.loose();
export type CorpsReglages = z.infer<typeof schemaCorpsReglages>;

export const schemaMascotteCatalogue = z.object({
  id: z.string(),
  label: z.string(),
  apercu: z.literal(false).optional(),
});
export type MascotteCatalogue = z.infer<typeof schemaMascotteCatalogue>;

/** Document lu : réglages enregistrés, défauts du serveur (toujours présents) et valeurs calculées ; les clés inconnues déjà stockées passent telles quelles. */
export const schemaReglages = reglagesFacultatifs
  .required({
    mcp_servers: true,
    shared_mcp_visible: true,
    active_mcp_url: true,
    system_prompt: true,
    assistant_name: true,
    editor_dark_mode: true,
    dark_mode: true,
    dark_mode_auto: true,
    skin: true,
    welcome_mascot: true,
    welcome_mascot_anime: true,
    auto_open_editor_on_write: true,
    editor_font_size: true,
    editor_font_family: true,
    editor_tab_size: true,
    editor_insert_spaces: true,
    editor_word_wrap: true,
    editor_minimap: true,
    editor_line_numbers: true,
    editor_edit_highlight: true,
    editor_auto_save: true,
    editor_persist_tabs: true,
    editor_follow_active: true,
    memory_enabled: true,
    hide_thinking: true,
    agents_enabled: true,
    custom_agents: true,
    live_shell_enabled: true,
    compression_enabled: true,
    compression_threshold_pct: true,
    compression_threshold_tokens: true,
    compression_max_rounds: true,
    enable_mcp: true,
    voice_input_enabled: true,
    voice_reply_enabled: true,
    voice_reply_tools_enabled: true,
    image_enabled: true,
    image_tool_enabled: true,
    enable_model_selector: true,
    image_prefs: true,
  })
  .extend({
    mascottes_actives: z.array(z.string()),
    mascottes_catalogue: z.array(schemaMascotteCatalogue),
    mascottes_on: z.boolean(),
    sandbox_path_display: z.string(),
    image_ready: z.boolean(),
    image_available: z.boolean(),
  })
  .loose();
export type Reglages = z.infer<typeof schemaReglages>;

export const schemaReponseAvatar = z.object({ ok: z.literal(true), avatar: z.string() });
export type ReponseAvatar = z.infer<typeof schemaReponseAvatar>;

/** Entrée canonique de `custom_agents` : agent personnel, ou surcharge d'un livré (même nom) ; `read_only` : case « Lecture seule » du compte, `thinking` : réflexion de l'agent, absents = défaut de l'administrateur pour le type (`custom` pour un agent personnel). */
export const schemaEntreeAgentCompte = z.looseObject({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tool_categories: z.array(z.string()),
  mcp_server_ids: z.array(z.string()),
  max_iters: entier.optional(),
  enabled: z.literal(false).optional(),
  read_only: z.boolean().optional(),
  thinking: modeReflexionAgent.optional(),
});
export type EntreeAgentCompte = z.infer<typeof schemaEntreeAgentCompte>;

/** `read_only_default` et `read_only_forced` : réglages de l'administrateur pour ce type (case cochée et grisée si imposée). */
export const schemaModeleAgent = z.object({
  name: z.string(),
  summary: z.string(),
  prompt: z.string(),
  tool_categories: z.array(z.string()),
  max_iters: entier,
  read_only_default: z.boolean(),
  read_only_forced: z.boolean(),
});
/** `read_only_policy` et `thinking_policy` : réglages de l'administrateur par type, `custom` valant pour les agents personnels. */
export const schemaReponseModelesAgents = z.object({
  templates: z.array(schemaModeleAgent),
  read_only_policy: schemaLectureSeuleAgents,
  thinking_policy: schemaReflexionAgents,
});
export type ReponseModelesAgents = z.infer<typeof schemaReponseModelesAgents>;

/** `doc` : `dev` (architecture) ou `user` (guide) ; le texte d'erreur de lecture est rendu en 200. */
export const schemaReponseAide = z.object({ content: z.string(), doc: z.enum(["user", "dev"]) });
export type ReponseAide = z.infer<typeof schemaReponseAide>;
