// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/types.ts — types communs des réglages du compte : document `settings`, serveurs MCP, agents, contexte hôte et liens entre familles. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import type { HttpLegacy } from "../../platform/http/legacy";

export type VueReglages = Pick<typeof Vue, "computed" | "nextTick" | "ref" | "watch">;
export type FetchAuth = HttpLegacy["fetchAuth"];

export interface PaireMcp {
  name: string;
  value: string;
  has_value: boolean;
}

export interface ServeurMcp {
  id: string;
  name: string;
  type: string;
  url: string;
  command: string;
  visible: boolean;
  auth_mode?: string;
  auth_user?: string;
  auth_secret?: string;
  has_auth?: boolean;
  headers?: PaireMcp[];
  env?: PaireMcp[];
  [cle: string]: unknown;
}

export interface AgentPerso {
  name: string;
  description?: string;
  prompt?: string;
  tool_categories?: string[];
  mcp_server_ids?: string[];
  max_iters?: number;
  enabled?: boolean;
  read_only?: boolean;
  [cle: string]: unknown;
}

export interface PreferencesImage {
  ratio: string;
  side: number;
  n: number;
  enhance: boolean;
  [cle: string]: unknown;
}

/** Document `/api/settings` tel que la page le tient : défauts complétés au chargement, clés inconnues conservées. */
export interface ReglagesApp {
  enable_editor?: boolean;
  enable_preview?: boolean;
  enable_rag?: boolean;
  enable_mcp?: boolean;
  enable_charts?: boolean;
  enable_model_selector?: boolean;
  auto_open_editor_on_write?: boolean;
  dark_mode?: boolean;
  dark_mode_auto?: boolean;
  hide_thinking?: boolean;
  hide_web_screenshots?: boolean;
  live_shell_enabled?: boolean;
  jobs_wake?: boolean;
  classic_ui?: boolean;
  voice_input_enabled?: boolean;
  voice_reply_enabled?: boolean;
  voice_reply_tools_enabled?: boolean;
  memory_enabled?: boolean;
  image_enabled?: boolean;
  image_tool_enabled?: boolean;
  image_prefs?: PreferencesImage;
  agents_enabled?: boolean;
  opencode_mcp_families?: Record<string, boolean>;
  compression_enabled?: boolean;
  compression_threshold_pct?: number;
  compression_threshold_tokens?: number;
  compression_max_rounds?: number;
  custom_agents?: AgentPerso[];
  shared_mcp_visible?: string[];
  mcp_servers?: ServeurMcp[];
  skin?: string;
  welcome_mascot?: string;
  editor_font_size?: number;
  editor_font_family?: string;
  editor_tab_size?: number;
  editor_insert_spaces?: boolean;
  editor_word_wrap?: string;
  editor_minimap?: boolean;
  editor_line_numbers?: boolean;
  editor_edit_highlight?: boolean;
  editor_auto_save?: string;
  editor_persist_tabs?: boolean;
  editor_follow_active?: boolean;
  editor_dark_mode?: boolean;
  editor_ratio?: number;
  chat_width?: number;
  assistant_name?: string;
  system_prompt?: string;
  sandbox_path_display?: string;
  [cle: string]: unknown;
}

export interface ConfigChat {
  active_mcp_ids: string[];
  [cle: string]: unknown;
}

export interface UtilisateurReglages {
  username: string;
  role?: string;
  avatar?: string;
  [cle: string]: unknown;
}

/** Refs de la racine lues par les réglages. */
export interface RefsReglages {
  user: Ref<UtilisateurReglages | null>;
  settings: Ref<ReglagesApp>;
  config: Ref<ConfigChat>;
  inputMessage: Ref<string>;
  inputRef: Ref<HTMLTextAreaElement | null>;
}

/** Services de l'hôte (racine) que les réglages appellent. */
export interface CtxReglages {
  showToast(
    message: string,
    type?: string,
    options?: { duration?: number; actionLabel?: string; onAction?: () => void },
  ): void;
  fetchAuth: FetchAuth;
  openConfirm(
    titre: string,
    texte: string,
    danger?: boolean,
    libelle?: string,
    annuler?: string,
  ): Promise<boolean>;
  openPrompt(titre: string, valeur: string, indice?: string): Promise<string | null | undefined>;
  nextTick?: () => Promise<void>;
  loadAvailableModels?(): Promise<unknown>;
  loadMcpUserCategories?(): unknown;
  openSkillsTab?(): unknown;
  loadSandboxFiles?(): unknown;
  checkExternalModsSoon?(delai: number): unknown;
  loadChatsList?(): unknown;
  autoResize?(): unknown;
  openTemplate?(template: unknown): unknown;
  stopSpeaking?(): unknown;
  addCodeCopyButtons?(complet: boolean, racine: HTMLElement): unknown;
}

/** Résultat d'une persistance ciblée : succès ou non, avec rejouer en cas d'échec. */
export interface OptionsPersistance {
  rollback?: () => void;
  okMsg?: string;
  silencieux?: boolean;
}

export const clonerValeur = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

declare global {
  interface Window {
    __ADMIN_ONLY_MODE__?: unknown;
  }
}
