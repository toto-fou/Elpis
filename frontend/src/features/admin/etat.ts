// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/etat.ts — état de la console partagé entre familles (page, configuration éditée, blocs enregistrés, comptes), liens entre familles et aides de chemin pointé. */
import { DEFAUTS_REGLAGES_AGENTS, DEFAUTS_REGLAGES_JOBS, DEFAUTS_SEUILS_DISQUE } from "@elpis/contracts";
import type {
  CompressionConfig,
  CompteConsole,
  ConfigExecuteurs,
  ReglagesAgents,
  ReglagesJobs,
  SeuilsDisque,
} from "@elpis/contracts";
import type { Ref } from "vue";

import type { NavAdmin } from "./registre";
import type { ConfigAdmin, CtxAdmin, RefsAdmin, VueAdmin } from "./types";

export type IdBloc = "config" | "compression" | "scheduling" | "allowed" | "exec" | "agents";
export const IDS_BLOCS: readonly IdBloc[] = [
  "config",
  "compression",
  "scheduling",
  "allowed",
  "exec",
  "agents",
];

export type InstantanesPropres = Record<IdBloc, string | null>;

export interface ModeOrdonnancement {
  configured_mode: string;
  effective_mode?: string;
  capabilities?: Record<string, unknown>;
  [cle: string]: unknown;
}

export interface ProfilReseauEdite {
  id: string;
  name: string;
  mode: string;
  description?: string;
  ips: (string | number)[];
  domains: (string | number)[];
  ports: (string | number)[];
  dns: (string | number)[];
  _uid: string;
  _open: boolean;
  _portsMode: string;
  _draft: Record<string, string>;
  _err: Record<string, string>;
  [cle: string]: unknown;
}

/** Réglages des tâches de fond : le type et les défauts viennent du contrat. */
export type ConfigJobs = ReglagesJobs;
export const JOBS_PAR_DEFAUT: Readonly<ConfigJobs> = DEFAUTS_REGLAGES_JOBS;
/** Seuils d'espace disque des bacs (alerte, refus) : le type et les défauts viennent du contrat. */
export const DISQUE_PAR_DEFAUT: Readonly<SeuilsDisque> = DEFAUTS_SEUILS_DISQUE;

export interface ConfigExecEditee {
  image: string;
  limits: Record<string, unknown>;
  force_user_docker: boolean;
  idle_kill_hours: number;
  network_profiles: ProfilReseauEdite[];
  exec_user: string;
  runtime: string;
  extra_run_args: string[];
  jobs: ConfigJobs;
  disk: SeuilsDisque;
}

export interface PromptSysteme {
  category: string;
  size_chars?: number;
  mtime?: number;
  exists?: boolean;
  [cle: string]: unknown;
}

/** Fonctions d'une famille appelées par une autre ; renseignées à la composition, lues à l'appel. */
export interface LiensAdmin {
  goAdminPage(id: string): Promise<boolean>;
  adminConfirmLeave(): Promise<boolean>;
  adminDirtyCount(): number;
  markAdminStoreClean(id: IdBloc): void;
  adminChangeLabel(c: { store: string; path: string }): string;
  storeSnapshot(id: IdBloc): string | null;
  loadOverview(refresh?: boolean): Promise<void>;
  overviewShortcut(kind: string): Promise<void>;
  restartServer(): Promise<void>;
  downloadBackup(scope?: string): Promise<void>;
  revokeAllSessions(): Promise<void>;
  focusAdminTitle(): void;
  loadRestartStatus(): Promise<void>;
  loadAdminConfig(type: string): Promise<void>;
  saveConfigStore(force?: boolean): Promise<boolean>;
  loadCompressionCfg(): Promise<void>;
  saveCompressionCfg(): Promise<boolean>;
  loadLlmScheduling(): Promise<void>;
  saveLlmSchedulingMode(): Promise<boolean>;
  loadAdminLlmConnectors(): Promise<void>;
  saveAdmAllowed(): Promise<boolean>;
  loadExecConfig(): Promise<void>;
  saveExecConfig(): Promise<boolean>;
  execConfigPayload(): Record<string, unknown>;
  loadAgentsConfig(): Promise<void>;
  saveAgentsConfig(): Promise<boolean>;
  savePrompt(): Promise<boolean | undefined>;
  reloadPrompt(): Promise<void>;
  loadSecurityOverview(): Promise<void>;
  loadHttpsStatus(): Promise<void>;
  loadVoiceModels(section: "stt" | "tts"): Promise<void>;
  loadImageModels(): Promise<void>;
  loadAdminStats(): Promise<void>;
  loadUsers(notifier?: boolean): Promise<void>;
  loadAdmLlmAccessOptions(force?: boolean): Promise<void>;
  loadRecentLogs(): Promise<void>;
  onEngineSelect(): void;
  destroyAllCharts(): void;
  downloadWithModal(url: string, titre: string, repli: string, attente?: string): Promise<void>;
}

/** Hôte commun à toutes les familles de la console. */
export interface BaseAdmin {
  readonly vue: VueAdmin;
  readonly refs: RefsAdmin;
  readonly ctx: CtxAdmin;
  readonly nav: NavAdmin;
  readonly e: EtatAdmin;
  readonly lien: LiensAdmin;
  readonly estAdmin: () => boolean;
}

export interface EtatAdmin {
  adminTab: Ref<string>;
  adminMeOpen: Ref<boolean>;
  adminChangesOpen: Ref<boolean>;
  dashMenu: Ref<string | null>;
  restartPaths: Ref<Set<string>>;
  restartPending: Ref<string[]>;
  configForm: Ref<ConfigAdmin | null>;
  adminPristine: Ref<InstantanesPropres>;
  compressionCfg: Ref<CompressionConfig | null>;
  llmScheduling: Ref<ModeOrdonnancement | null>;
  admLlmAllowed: Ref<string[]>;
  execConfig: Ref<ConfigExecEditee>;
  /** Réglages des sous-agents (`/api/admin/agents`) ; défauts du contrat tant que le core n'a pas répondu. */
  agentsConfig: Ref<ReglagesAgents>;
  promptsEditorDirty: Ref<boolean>;
  promptsSelected: Ref<string>;
  usersList: Ref<CompteConsole[]>;
  usersNetProfiles: Ref<ConfigExecuteurs["network_profiles"]>;
  usersDesktopTargets: Ref<{ name: string; os: string; access: string; allowed_users: string[] }[]>;
  groupsList: Ref<GroupeAffiche[]>;
  isSavingAdminConfig: Ref<boolean>;
  engineSel: Ref<string>;
  /** Copie de ce qui est sur disque, base du PATCH champ par champ (hors réactivité). */
  configRaw: Record<string, unknown>;
}

export interface GroupeAffiche {
  id: number;
  name: string;
  description: string | null;
  created_at?: number;
  member_count: number;
  llm_engine_keys: string[] | null;
  llm_can_manage_models: boolean | null;
}

export function creerEtatAdmin(vue: VueAdmin): EtatAdmin {
  const { ref } = vue;
  return {
    adminTab: ref("overview"),
    adminMeOpen: ref(false),
    adminChangesOpen: ref(false),
    dashMenu: ref<string | null>(null),
    restartPaths: ref(new Set<string>()),
    restartPending: ref<string[]>([]),
    configForm: ref<ConfigAdmin | null>(null),
    adminPristine: ref<InstantanesPropres>({
      config: null,
      compression: null,
      scheduling: null,
      allowed: null,
      exec: null,
      agents: null,
    }),
    compressionCfg: ref<CompressionConfig | null>(null),
    llmScheduling: ref<ModeOrdonnancement | null>(null),
    admLlmAllowed: ref<string[]>([]),
    execConfig: ref<ConfigExecEditee>({
      image: "elpis/sandbox:1.0.0",
      limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
      force_user_docker: false,
      idle_kill_hours: 24,
      network_profiles: [],
      exec_user: "10001:10001",
      runtime: "",
      extra_run_args: [],
      jobs: { ...JOBS_PAR_DEFAUT },
      disk: { ...DISQUE_PAR_DEFAUT },
    }),
    agentsConfig: ref<ReglagesAgents>(JSON.parse(JSON.stringify(DEFAUTS_REGLAGES_AGENTS)) as ReglagesAgents),
    promptsEditorDirty: ref(false),
    promptsSelected: ref(""),
    usersList: ref<CompteConsole[]>([]),
    usersNetProfiles: ref<ConfigExecuteurs["network_profiles"]>([]),
    usersDesktopTargets: ref([]),
    groupsList: ref<GroupeAffiche[]>([]),
    isSavingAdminConfig: ref(false),
    engineSel: ref("__local__"),
    configRaw: {},
  };
}

// ── Chemins pointés ─────────────────────────────────────────────────────────
type Noeud = Record<string, unknown>;
const estNoeud = (v: unknown): v is Noeud => typeof v === "object" && v !== null && !Array.isArray(v);

/** Feuilles d'un objet JSON : un objet se déplie, tout le reste (tableau, scalaire, null) est une feuille. */
export function aplatir(
  obj: unknown,
  prefixe = "",
  sortie: Record<string, unknown> = {},
): Record<string, unknown> {
  if (estNoeud(obj)) {
    for (const k of Object.keys(obj)) aplatir(obj[k], prefixe ? prefixe + "." + k : k, sortie);
  } else if (prefixe) {
    sortie[prefixe] = obj;
  }
  return sortie;
}

export interface FeuilleModifiee {
  path: string;
  before: unknown;
  after: unknown;
  removed: boolean;
}

const jsonOuIndefini = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** Feuilles qui diffèrent entre deux documents. */
export function diffFeuilles(avant: unknown, apres: unknown): FeuilleModifiee[] {
  const a = aplatir(avant ?? {});
  const b = aplatir(apres ?? {});
  const sortie: FeuilleModifiee[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (jsonOuIndefini(a[k]) !== jsonOuIndefini(b[k]))
      sortie.push({ path: k, before: a[k], after: b[k], removed: !(k in b) });
  }
  return sortie;
}

export function lireChemin(obj: unknown, chemin: string): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const k of String(chemin).split(".")) {
    if (!estNoeud(cur) || !(k in cur)) return { found: false, value: undefined };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

export function poserChemin(obj: unknown, chemin: string, valeur: unknown): void {
  const parts = String(chemin).split(".");
  let cur = obj as Noeud;
  for (const k of parts.slice(0, -1)) {
    const suivant = cur[k];
    if (!estNoeud(suivant)) cur[k] = {};
    cur = cur[k] as Noeud;
  }
  const dernier = parts[parts.length - 1] ?? "";
  if (valeur === undefined) delete cur[dernier];
  else
    cur[dernier] =
      valeur && typeof valeur === "object" ? (JSON.parse(JSON.stringify(valeur)) as unknown) : valeur;
}
