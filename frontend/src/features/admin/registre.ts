// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/registre.ts — arborescence de la console d'administration : entrées, pages, alias des anciens identifiants, chargeurs et blocs enregistrés de chaque page. */

export type RoleAdmin = "staff" | "admin";
/** Appel d'un chargeur à l'entrée d'une page : nom de la fonction de la console et arguments explicites. */
export type Chargeur = readonly [nom: string, ...arguments: unknown[]];

/** Sous-onglet d'une page : ses chargeurs ne partent que lorsqu'il est affiché. */
export interface OngletPage {
  readonly id: string;
  readonly label: string;
  /** Rôle exigé quand il est plus strict que celui de la page. */
  readonly role?: RoleAdmin;
  readonly loaders: readonly Chargeur[];
}

interface DefinitionPage {
  id: string;
  label: string;
  /** Rôle exigé quand il est plus strict que celui de l'entrée. */
  role?: RoleAdmin;
  wide?: boolean;
  /** Chargeurs communs, lancés quel que soit l'onglet affiché. */
  loaders?: readonly Chargeur[];
  /** Sous-onglets (le premier est l'onglet d'arrivée) ; les chargeurs de l'onglet affiché s'ajoutent à ceux de la page. */
  onglets?: readonly OngletPage[];
  stores?: readonly string[];
  paths?: readonly string[];
}

export interface PageAdmin {
  readonly id: string;
  readonly label: string;
  readonly wide: boolean;
  readonly stores: readonly string[];
  readonly loaders: readonly Chargeur[];
  readonly onglets: readonly OngletPage[];
  readonly paths: readonly string[];
  readonly entry: string;
  readonly entryLabel: string;
  readonly role: RoleAdmin;
}

export interface EntreeAdmin {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly role: RoleAdmin;
  readonly pages: readonly DefinitionPage[];
}

/** Destination d'un lien : une page et, si elle en a, un de ses onglets (« » = onglet d'arrivée). */
export interface LienAdmin {
  readonly page: string;
  readonly onglet: string;
}

export interface NavAdmin {
  readonly entries: readonly EntreeAdmin[];
  readonly pages: Readonly<Record<string, PageAdmin>>;
  readonly aliases: Readonly<Record<string, string>>;
  /** Ancre (`logs/security`, ancien identifiant, `#` facultatif) vers page et onglet, ou `null` si elle ne désigne rien. */
  resolveLien(ancre: unknown): LienAdmin | null;
  /** Rôle exigé pour ouvrir l'onglet de la page (celui de la page, ou plus strict). */
  roleDe(page: string, onglet?: string): RoleAdmin;
  pageForPath(chemin: string): string;
}

const CONFIG: Chargeur = ["loadAdminConfig", "main"];

const ENTREES: readonly EntreeAdmin[] = [
  {
    id: "overview",
    label: "Vue d’ensemble",
    icon: "ph-squares-four",
    role: "staff",
    pages: [{ id: "overview", label: "Vue d’ensemble", wide: true, loaders: [["loadOverview"]] }],
  },
  {
    id: "supervision",
    label: "Supervision",
    icon: "ph-chart-line-up",
    role: "staff",
    pages: [
      { id: "dashboard", label: "Métriques", wide: true, loaders: [["loadAdminStats"]], paths: ["metrics."] },
      { id: "report", label: "Rapport", wide: true, loaders: [["loadDailyReport"]] },
      {
        id: "activity",
        label: "Activité",
        wide: true,
        onglets: [
          { id: "runs", label: "Exécutions", loaders: [["loadAdminRuns"]] },
          { id: "tool-calls", label: "Appels d’outils", loaders: [["loadToolCalls"]] },
        ],
      },
      {
        id: "logs",
        label: "Journaux",
        wide: true,
        onglets: [
          { id: "technical", label: "Technique", loaders: [["loadRecentLogs"]] },
          { id: "security", label: "Sécurité", role: "admin", loaders: [["loadJournalSecurite"]] },
        ],
      },
    ],
  },
  {
    id: "models",
    label: "Modèles & services",
    icon: "ph-cpu",
    role: "admin",
    pages: [
      {
        id: "inference",
        label: "Inférence",
        wide: true,
        stores: ["config", "scheduling"],
        loaders: [CONFIG, ["loadAdminLlmConnectors"], ["loadLlmScheduling"], ["loadRapportMoteur"]],
        paths: ["llama."],
      },
      { id: "compression", label: "Compression", stores: ["compression"], loaders: [["loadCompressionCfg"]] },
      {
        id: "rag",
        label: "RAG",
        wide: true,
        stores: ["config"],
        loaders: [CONFIG, ["loadGroups"], ["loadUsers"], ["loadRagAdmin"]],
        paths: ["rag."],
      },
      { id: "vision", label: "Vision & machines", stores: ["config"], loaders: [CONFIG, ["loadAxSites"]] },
      { id: "voice", label: "Voix", stores: ["config"], loaders: [CONFIG] },
      {
        id: "images",
        label: "Images",
        stores: ["config"],
        loaders: [CONFIG, ["loadImageAdmin"], ["loadGroups"]],
      },
      {
        id: "mcp",
        label: "Outils MCP",
        stores: ["config"],
        loaders: [CONFIG, ["loadMcpManifest"], ["loadOauthClients"]],
        paths: ["mcp."],
      },
      { id: "prompts", label: "Prompts", wide: true, loaders: [["loadSystemPrompts"]] },
      { id: "secrets", label: "Secrets", wide: true, loaders: [["loadInstanceSecrets"]] },
    ],
  },
  {
    id: "access",
    label: "Utilisateurs & accès",
    icon: "ph-users",
    role: "admin",
    pages: [
      { id: "accounts", label: "Comptes", wide: true, loaders: [["loadUsers"], ["loadGroups"]] },
      { id: "groups", label: "Groupes", wide: true, loaders: [["loadGroups"], ["loadUsers"]] },
      {
        id: "rights",
        label: "Droits par défaut",
        stores: ["config", "allowed"],
        loaders: [CONFIG, ["loadAdminLlmConnectors"]],
      },
      {
        id: "sessions",
        label: "Mots de passe & sessions",
        stores: ["config"],
        loaders: [CONFIG],
        paths: ["security.session.", "security.password_policy."],
      },
    ],
  },
  {
    id: "sandbox",
    label: "Sandbox",
    icon: "ph-cube",
    role: "admin",
    pages: [
      { id: "sandbox-limits", label: "Limites & politique", stores: ["exec"], loaders: [["loadExecConfig"]] },
      { id: "sandbox-network", label: "Réseau", stores: ["exec"], loaders: [["loadExecConfig"]] },
      { id: "sandbox-toolhosts", label: "Hôtes d’outils", loaders: [["loadExecConfig"], ["loadToolhosts"]] },
      { id: "sandbox-containers", label: "Conteneurs", wide: true, loaders: [["loadExecConfig"]] },
      {
        id: "sandbox-agents",
        label: "Sous-agents",
        stores: ["agents"],
        loaders: [["loadAgentsConfig"]],
        paths: ["agents."],
      },
    ],
  },
  {
    id: "system",
    label: "Système",
    icon: "ph-hard-drives",
    role: "admin",
    pages: [
      {
        id: "instance",
        label: "Instance",
        stores: ["config"],
        loaders: [CONFIG],
        paths: ["app_info.", "app."],
      },
      {
        id: "appearance",
        label: "Apparence",
        wide: true,
        stores: ["config"],
        loaders: [["loadAdminSkins"], CONFIG],
        paths: ["skins."],
      },
      { id: "https", label: "Accès HTTPS", loaders: [CONFIG] },
      {
        id: "data",
        label: "Données",
        loaders: [["loadDatabase"], ["loadRemoteBackup"]],
        paths: ["database.", "backup."],
      },
      {
        id: "audit-logging",
        label: "Journalisation",
        role: "admin",
        stores: ["audit"],
        loaders: [["loadAuditStatus"]],
        paths: ["security.audit."],
      },
      {
        id: "upkeep",
        label: "Entretien",
        stores: ["config"],
        loaders: [CONFIG, ["loadDailyReport"]],
        paths: ["maintenance."],
      },
    ],
  },
];

/** Anciens identifiants vers la page qui contient désormais ce qu'ils désignaient. */
const ALIAS: Readonly<Record<string, string>> = Object.freeze({
  runs: "activity/runs",
  "tool-calls": "activity/tool-calls",
  observability: "activity/tool-calls",
  audit: "logs/security",
  general: "instance",
  connections: "inference",
  engines: "inference",
  llm: "inference",
  security: "sessions",
  users: "accounts",
  exec: "sandbox-limits",
  database: "data",
  maintenance: "upkeep",
  config: "instance",
  ax: "vision",
});

function construirePages(): Record<string, PageAdmin> {
  const pages: Record<string, PageAdmin> = {};
  for (const e of ENTREES) {
    for (const p of e.pages) {
      pages[p.id] = Object.freeze({
        id: p.id,
        label: p.label,
        wide: p.wide ?? false,
        stores: p.stores ?? [],
        loaders: p.loaders ?? [],
        onglets: p.onglets ?? [],
        paths: p.paths ?? [],
        entry: e.id,
        entryLabel: e.label,
        role: p.role ?? e.role,
      });
    }
  }
  return pages;
}

/** Chargeurs à lancer pour la page et l'onglet affichés : ceux de la page, puis ceux de l'onglet. */
export function chargeursDe(page: PageAdmin | undefined, onglet: string): readonly Chargeur[] {
  if (!page) return [];
  const o = page.onglets.find((x) => x.id === onglet);
  return o ? [...page.loaders, ...o.loaders] : page.loaders;
}

function creerNavAdmin(): NavAdmin {
  const pages = construirePages();
  const resolveLien = (ancre: unknown): LienAdmin | null => {
    const [tete = "", queue = ""] = String(ancre || "")
      .replace(/^#/, "")
      .split("/", 2);
    const [page = "", demande = ""] = Object.hasOwn(pages, tete)
      ? [tete, queue]
      : (Object.hasOwn(ALIAS, tete) ? (ALIAS[tete] ?? "") : "").split("/", 2);
    const def = Object.hasOwn(pages, page) ? pages[page] : undefined;
    return def ? { page, onglet: def.onglets.some((o) => o.id === demande) ? demande : "" } : null;
  };
  return Object.freeze({
    entries: ENTREES,
    pages: Object.freeze(pages),
    aliases: ALIAS,
    resolveLien,
    roleDe(page: string, onglet?: string): RoleAdmin {
      const def = Object.hasOwn(pages, page) ? pages[page] : undefined;
      if (!def) return "staff";
      const o = def.onglets.find((x) => x.id === onglet);
      return def.role === "admin" || o?.role === "admin" ? "admin" : "staff";
    },
    /** Chemin de config.json vers la page qui le règle (préfixe le plus long). */
    pageForPath(chemin: string): string {
      let meilleur = "";
      let longueur = 0;
      for (const [id, page] of Object.entries(pages)) {
        for (const pre of page.paths) {
          if (String(chemin).startsWith(pre) && pre.length > longueur) {
            meilleur = id;
            longueur = pre.length;
          }
        }
      }
      return meilleur;
    },
  });
}

/** Instance unique, publiée aussi sur `window.ELPIS_ADMIN_NAV` pour app.js. */
export const NAV_ADMIN: NavAdmin = creerNavAdmin();
