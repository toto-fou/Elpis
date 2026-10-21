// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/types.ts — types communs de la console : hôte (refs et services), configuration éditée, comptes, état partagé entre familles. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import type { HttpLegacy } from "../../platform/http/legacy";
import type { NavAdmin } from "./registre";

export type VueAdmin = Pick<typeof Vue, "computed" | "onUnmounted" | "ref" | "watch">;
export type FetchAuth = HttpLegacy["fetchAuth"];

export interface UtilisateurAdmin {
  username?: string;
  role?: string;
  is_admin?: boolean | number;
  [cle: string]: unknown;
}

export interface RefsAdmin {
  user: Ref<UtilisateurAdmin | null>;
  isAdminView?: Ref<boolean>;
}

export interface EntreeJournal {
  id?: number | string;
  ts?: number;
  service?: string;
  level?: string;
  category?: string;
  message?: string;
  [cle: string]: unknown;
}

export interface ChoixDialogue {
  id: string;
  label: string;
  tone: string;
}

export interface ApiTheme {
  toggleThemeMode(): unknown;
  setAppSkin(id: string): unknown;
  skins: readonly { id: string; label: string }[];
}

/** Services de l'hôte (racine) que la console appelle. */
export interface CtxAdmin {
  showToast(message: string, type?: string, options?: { duration?: number }): void;
  fetchAuth: FetchAuth;
  openConfirm(
    titre: string,
    texte: string,
    danger?: boolean,
    libelle?: string,
    annuler?: string,
  ): Promise<boolean>;
  openChoice(
    titre: string,
    texte: string,
    choix: ChoixDialogue[],
    annuler: string,
  ): Promise<string | null | undefined>;
  openTypedConfirm?(titre: string, texte: string, mot: string, libelle: string): Promise<boolean>;
  nextTick(): Promise<void>;
  handleSessionExpired?(): unknown;
  loadPublicConfig(): unknown;
  liveLogs?: Ref<EntreeJournal[]>;
  showNewUserModal?: Ref<boolean>;
  mainAppUrl?: Ref<string>;
  systemAlert: Ref<string>;
  readonly themeApi?: ApiTheme | null;
}

// ── Configuration éditée (config.json) ──────────────────────────────────────
export interface CibleBureauConfig {
  name: string;
  os: string;
  agent_url: string;
  default: boolean;
  access: string;
  allowed_users: string[];
  [cle: string]: unknown;
}

export interface ConfigAdmin {
  welcome: {
    type: string;
    icon: string;
    width: number;
    height: number;
    image_b64: string;
    scene: {
      mascottes_on: boolean;
      motif: string;
      word_scale: number;
      mascot_scale: number;
      mascottes_actives: string[];
      mascotte_defaut: string;
    };
    [cle: string]: unknown;
  };
  maintenance: {
    hour: number;
    metrics_retention_days: number;
    usage_events_retention_days: number;
    session_messages_retention_days: number;
    tool_metrics_retention_days: number;
    routine_runs_retention_days: number;
    daily_report_retention_days: number;
    [cle: string]: unknown;
  };
  security: {
    password_policy: {
      min_length: number;
      require_uppercase: boolean;
      require_lowercase: boolean;
      require_numbers: boolean;
      require_special: boolean;
    };
    session: {
      max_age_sec: number;
      idle_timeout_sec: number;
      cookie_name: string;
      same_site: string;
      https_only: boolean;
      global_min_ts: number;
    };
    https?: { enabled?: boolean; [cle: string]: unknown };
    [cle: string]: unknown;
  };
  login_page: {
    title: string;
    subtitle: string;
    icon_type: string;
    icon: string;
    icon_color: string;
    icon_bg: string;
    logo_b64: string;
    bg_color: string;
    card_color: string;
    text_color: string;
    btn_color: string;
  };
  app_info: {
    name: string;
    version: string;
    team_name: string;
    engine: string;
    description: string;
    icon_type: string;
    icon: string;
    icon_color: string;
    icon_bg: string;
    logo_b64: string;
    use_welcome_image: boolean;
  };
  llama: {
    engine: string;
    url: string;
    model: string;
    retries: number;
    retry_backoff_sec: number;
    max_concurrency: number;
    max_models: number;
    n_ctx: number;
    ip: string;
    port: number;
    timeout_sec: number;
    /** `********` quand une clé est enregistrée (jamais la valeur), vide sinon. */
    api_key?: string;
    [cle: string]: unknown;
  };
  mcp: {
    servers_dir: string;
    tools_cache_ttl_sec: number;
    tokens: { tools_enabled: boolean; tools_families: string; max_days: number; max_per_user: number };
    oauth: { enabled: boolean; dcr_enabled: boolean; access_ttl_s: number; refresh_days: number };
    [cle: string]: unknown;
  };
  rag: {
    service_url: string;
    service_token: string;
    service_timeout: number;
    qdrant_url: string;
    embed: { url: string; model: string; api_key: string; batch: number; timeout_s: number };
    reranker: { enabled: boolean; url: string; model: string };
    ocr: { url: string; model: string; api_key: string; timeout_s: number };
    groups: number[];
    quotas: { storage_mb: number; collections: number; file_mb: number; docs_per_collection: number };
    indexation: { concurrence: number; par_compte: number };
    [cle: string]: unknown;
  };
  app: {
    upload_dir: string;
    sandbox_dir: string;
    enable_model_selector?: boolean;
    max_recent_chats?: number;
    [cle: string]: unknown;
  };
  features: { opencode: boolean; office_preview: boolean; [cle: string]: unknown };
  vision: { endpoint_url: string; format: string; prompt: string; model: string; passes: number };
  voice: {
    enabled: boolean;
    stt: {
      endpoint_url: string;
      format: string;
      model: string;
      language: string;
      prompt: string;
      token: string;
      logprob_min: number;
      timeout_sec: number;
      max_upload_mb: number;
      max_utterance_sec: number;
      max_concurrent: number;
      verify: boolean;
    };
    tts: {
      endpoint_url: string;
      format: string;
      token: string;
      model: string;
      voice: string;
      speed: number;
      timeout_sec: number;
      max_chars: number;
      max_concurrent: number;
      verify: boolean;
    };
  };
  image: {
    enabled: boolean;
    provider: string;
    url: string;
    model: string;
    verify: boolean;
    ca_pem: string;
    timeout_sec: number;
    max_concurrent: number;
    max_n: number;
    max_side: number;
    default_side: number;
    size_policy: string;
    sizes: string[];
    edit_mode: string;
    keep_per_user: number;
    groups: number[];
    tool_max_calls: number;
    enhance_enabled: boolean;
    [cle: string]: unknown;
  };
  desktop: { targets: CibleBureauConfig[]; screenshot_format: string; screenshot_quality: number };
  [cle: string]: unknown;
}

export const clonerJson = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export interface BaseAdminBrute {
  vue: VueAdmin;
  refs: RefsAdmin;
  ctx: CtxAdmin;
  nav: NavAdmin;
}
