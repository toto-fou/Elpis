// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/formats.ts — formats et libellés purs du chat (portés d'`app-chat.js`) : métriques d'un message, statut vivant, pastilles d'outils, libellés de compression et de boucle d'outils, teintes des catégories. */
import { fmtElapsed, fmtTokenCount, tokenBreakdown } from "../../../utils/utils-purs.ts";
import { fmtDuree } from "../outils/format.ts";
import type { DetailTokens } from "../../../utils/utils-purs.ts";
import { libelleChargementModele } from "../affichage.ts";
import type { EtapeChat, MessageChat, Objet } from "./types.ts";

export const PREFIXE_STATUT_DELTA = "Appel d'outil";

const LIBELLES_ARRET: Readonly<Record<string, string>> = {
  steps: "Budget de tours atteint",
  hard: "Trop d'appels d'outils en échec",
  wallclock: "Budget de temps atteint",
  ctx_saturated: "Contexte saturé",
  gen_cap: "Appels d'outils trop longs",
  cycle: "Boucle d'action détectée",
  empty_choices: "Réponses vides du moteur",
};

/** Libellé du bandeau « boucle d'outils stoppée » selon la cause réelle de l'arrêt. */
export function toolLimitLabel(stats: { stop_reason?: unknown } | null | undefined): string {
  const k = stats?.stop_reason;
  return (typeof k === "string" && LIBELLES_ARRET[k]) || "Limite d'itérations atteinte";
}

const RAISONS_COMPRESSION: Readonly<Record<string, string>> = {
  no_token_gain: "Sans gain — annulée",
  summary_invalid_format: "Résumé invalide — annulée",
  summary_too_short: "Résumé trop court — annulée",
  nothing_to_compress: "Rien à compresser",
  disabled: "Compression désactivée (réglage admin)",
  max_rounds_reached: "Maximum de compressions atteint",
  threshold_not_reached: "Contexte encore trop court",
  gain_too_small: "Trop peu à compacter — reportée",
  persist_failed: "Échec d'enregistrement — réessayez",
};

/** Libellé d'une compression tentée mais non appliquée. */
export function comprSkipLabel(reason: unknown): string {
  const r = String(reason || "");
  const connu = RAISONS_COMPRESSION[r];
  if (connu) return connu;
  if (r.startsWith("llm_error")) return "Erreur du modèle de compression";
  if (r.startsWith("exception")) return "Erreur interne — annulée";
  return "Non appliquée";
}

/** Horodatage court d'une notice persistée (« 12/07 22:41 »). */
export function fmtNoticeTs(ts: unknown): string {
  if (!ts) return "";
  try {
    return new Date(Number(ts) * 1000).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Compte de jetons abrégé en français (« 1,2 k », « 3 M »). */
export function fmtTokens(n: unknown): string {
  return fmtTokenCount(n);
}

export function fmtToolMs(ms: unknown): string {
  return fmtDuree(Number(ms) || 0);
}

export function fmtCtxUsage(u: { used?: unknown; total?: unknown } | null | undefined): string {
  if (!u || !(Number(u.total) > 0)) return "";
  return `${fmtTokens(u.used)}/${fmtTokens(u.total)}`;
}

export function fmtKvCache(metrics: Objet | null | undefined): string {
  const kv = metrics?.["kv_cache"] as { used?: unknown; total?: unknown } | null | undefined;
  if (!kv || !kv.total) return "";
  return `${fmtTokens(kv.used)}/${fmtTokens(kv.total)}`;
}

const nombre = (x: unknown): number => Number(x) || 0;

/** Tokens de réflexion d'un message, ou 0 (anciens messages sans mesure). */
export function thinkingTokensOf(m: Objet | null | undefined): number {
  const t = m?.["thinking_tokens"];
  return typeof t === "number" && t > 0 ? t : 0;
}

export function fmtThinkingTokens(m: Objet | null | undefined): string {
  const n = thinkingTokensOf(m);
  if (!n) return "";
  return (m?.["thinking_tokens_estimated"] ? "≈ " : "") + n.toLocaleString("fr-FR");
}

// Une entrée Anthropic d'avant la normalisation ne compte pas le cache : on la recompose.
function postes(m: Objet | null | undefined): DetailTokens {
  let inp = nombre(m?.["input_tokens"]);
  const lu = nombre(m?.["cache_read_input_tokens"]);
  if (lu > inp) inp += lu + nombre(m?.["cache_creation_input_tokens"]);
  return tokenBreakdown(inp, m?.["output_tokens"], lu, thinkingTokensOf(m), m?.["tool_input_tokens"]);
}

export function cachePctOf(m: Objet | null | undefined): number {
  if (!m || !(nombre(m["cache_read_input_tokens"]) > 0) || !(nombre(m["input_tokens"]) > 0)) return 0;
  return postes(m).cache_pct;
}

export function cacheTitle(m: Objet | null | undefined): string {
  const b = postes(m);
  return (
    "Entrée : " +
    b.input.toLocaleString("fr-FR") +
    " jetons, dont " +
    b.cache.toLocaleString("fr-FR") +
    " relus du cache et " +
    b.input_new.toLocaleString("fr-FR") +
    " utiles (calculés)"
  );
}

/** Infobulle des métriques : entrée, sortie, cache créé, cumul, contexte de fin de tour, segments. */
export function metricsTooltip(m: Objet | null | undefined): string {
  if (!m) return "";
  const nb = (x: unknown): string => Math.max(0, Number(x) || 0).toLocaleString("fr-FR");
  const lignes: string[] = [];
  const duree = m["duration"];
  lignes.push("Modèle : " + String(m["model"] || "?") + (duree ? " · " + fmtElapsed(duree) : ""));
  const reflexion = thinkingTokensOf(m);
  const b = postes(m);
  if (b.input) {
    const d: string[] = [];
    if (b.cache) d.push("cache " + nb(b.cache) + " (" + b.cache_pct + " %)");
    d.push("utile " + nb(b.input_new));
    if (b.tools) d.push("outils ≈ " + nb(b.tools));
    if (m["read_tps"]) d.push(String(m["read_tps"]) + " jetons/s");
    lignes.push("Entrée " + nb(b.input) + " · " + d.join(" · "));
  }
  if (b.output) {
    const d: string[] = [];
    if (reflexion) {
      d.push("réflexion " + fmtThinkingTokens(m));
      const rep = m["response_tokens"];
      d.push("réponse " + nb(typeof rep === "number" ? rep : b.response));
    }
    if (m["write_tps"]) d.push(String(m["write_tps"]) + " jetons/s");
    lignes.push("Sortie " + nb(b.output) + (d.length ? " · " + d.join(" · ") : ""));
  }
  if (nombre(m["cache_creation_input_tokens"]) > 0)
    lignes.push("Mis en cache " + nb(m["cache_creation_input_tokens"]));
  const dernier = m["last_prompt_tokens"];
  if (typeof dernier === "number" && m["input_tokens"] && m["input_tokens"] !== dernier) {
    const it = nombre(m["iterations"]);
    lignes.push("Entrée cumulée sur " + (it > 1 ? it + " appels" : "plusieurs appels") + " du modèle");
  }
  const kv = m["kv_cache"] as { used?: unknown; total?: unknown; pct?: unknown } | null | undefined;
  if (kv && nombre(kv.total) > 0)
    lignes.push("Contexte " + nb(kv.used) + " / " + nb(kv.total) + " (" + String(kv.pct) + " %)");
  else if (typeof dernier === "number" && dernier > 0) lignes.push("Contexte " + nb(dernier));
  if (nombre(m["segments"]) > 1)
    lignes.push("Total de " + nombre(m["segments"]) + " segments (« Continuer »)");
  return lignes.join("\n");
}

/** Durée du raisonnement d'un message, ou '' tant qu'elle n'est pas connue. */
export function fmtThinkingMeta(msg: MessageChat | null | undefined): string {
  if (!msg || !msg.thinking) return "";
  if (typeof msg._thinkingMs === "number") return fmtDuree(msg._thinkingMs);
  if (msg._thinkingStartedAt && msg._thinkingEndedAt)
    return fmtDuree(msg._thinkingEndedAt - msg._thinkingStartedAt);
  return "";
}

/** Argument le plus parlant d'un appel d'outil (basename pour un chemin), 40 caractères au plus. */
export function toolKeyArg(step: { args?: unknown } | null | undefined): string {
  const a = (step?.args && typeof step.args === "object" ? step.args : {}) as Objet;
  let v: unknown =
    a["path"] ||
    a["filename"] ||
    a["file"] ||
    a["query"] ||
    a["q"] ||
    a["name"] ||
    a["url"] ||
    a["cmd"] ||
    a["command"] ||
    a["pattern"] ||
    a["branch"] ||
    a["repo"] ||
    a["message"] ||
    "";
  if (Array.isArray(v)) v = v[0] || "";
  let s = String(v == null ? "" : v)
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return "";
  if (s.includes("/")) s = s.split("/").filter(Boolean).pop() || s;
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

export interface PhaseChat {
  kind: string;
  label: string;
}

const EXCLUS_PILL = new Set(["compression", "memory", "todo"]);

/** Phase vivante d'un message assistant (outil en cours, préremplissage, réflexion, statut brut normalisé). */
export function statusPhase(msg: MessageChat | null | undefined): PhaseChat | null {
  if (!msg || msg._imageTurn) return null;
  if (msg._modelLoad) return { kind: "wait", label: libelleChargementModele(msg._modelLoad) };
  const steps = msg.toolSteps && msg.toolSteps.length ? msg.toolSteps : null;
  let enCours: EtapeChat | null = null;
  if (steps)
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s && s.status === "running") {
        enCours = s;
        break;
      }
    }
  if (enCours && enCours._kind === "task") return null;
  if (enCours && !EXCLUS_PILL.has(enCours._kind || "")) {
    if ((enCours.name || "").startsWith("rag_"))
      return { kind: "rag", label: enCours.ragLabel || "Consultation documentaire" };
    const arg = toolKeyArg(enCours);
    return { kind: "tool", label: arg ? `${enCours.name} · ${arg}` : enCours.name || "Outil" };
  }
  const s0 = (msg._statusLine || "").trim();
  if (s0.startsWith(PREFIXE_STATUT_DELTA)) return { kind: "tool", label: s0 };
  if (msg._pendingPreContent) return null;
  if (typeof msg._prefillPct === "number" && msg._prefillPct < 100) {
    const c = msg._prefillCachePct;
    return { kind: "think", label: "Prefill… " + msg._prefillPct + " %" + (c ? " · cache " + c + " %" : "") };
  }
  if (msg.thinking && !msg.content) return { kind: "think", label: "Réflexion…" };
  const s = (msg._statusLine || "").trim();
  if (!s) return null;
  const a = (...xs: string[]): boolean => xs.some((x) => s.includes(x));
  if (a("Connexion", "Connecté", "MCP", "prêt")) return { kind: "connect", label: "Connexion aux outils…" };
  if (a("Recherche", "Lecture", "Consultation", "Exploration", "documentaire"))
    return { kind: "rag", label: s };
  if (a("attente")) return { kind: "wait", label: "En attente…" };
  if (a("Génération", "Generation", "Réflexion", "eflexion")) return { kind: "think", label: "Réflexion…" };
  return { kind: "run", label: s };
}

export function statusDotClass(kind: string): string {
  if (kind === "think") return "bg-emerald-500";
  if (kind === "rag") return "bg-purple-400";
  if (kind === "tool" || kind === "connect") return "bg-blue-400";
  if (kind === "wait") return "bg-slate-300";
  return "bg-slate-400";
}

/** Classe Phosphor d'un nom d'outil (correspondance par sous-chaîne, engrenage par défaut). */
export function toolIconFor(name: unknown): string {
  const n = String(name || "").toLowerCase();
  const a = (...xs: string[]): boolean => xs.some((x) => n.includes(x));
  if (n === "shell_job") return "ph-timer";
  if (a("search", "grep", "find")) return "ph-magnifying-glass";
  if (a("write", "save", "create")) return "ph-pencil-simple-line";
  if (a("edit", "replace", "patch")) return "ph-pencil-simple";
  if (a("read", "view", "cat")) return "ph-eye";
  if (a("delete", "rm", "remove")) return "ph-trash";
  if (a("bash", "shell", "exec", "run", "command")) return "ph-terminal";
  if (a("git")) return "ph-git-branch";
  if (a("http", "fetch", "curl", "web", "browser")) return "ph-globe";
  if (a("rag", "memory", "todo")) return "ph-database";
  if (a("chart", "plot", "graph")) return "ph-chart-bar";
  if (a("mkdir", "folder", "dir")) return "ph-folder-simple";
  if (a("move", "rename")) return "ph-arrows-left-right";
  return "ph-gear";
}

export interface Pastilles {
  pills: { name: string; count: number; icon: string }[];
  extraCount: number;
}

const HORS_PASTILLES = new Set(["compression", "memory", "todo", "task"]);
const PASTILLES_MAX = 4;

/** Aperçu groupé des outils d'un segment : 4 pastilles au plus (par fréquence), reste agrégé en « +N ». */
export function getToolPillsFor(toolSteps: readonly EtapeChat[] | null | undefined): Pastilles {
  const out: Pastilles = { pills: [], extraCount: 0 };
  if (!Array.isArray(toolSteps) || toolSteps.length === 0) return out;
  const ordre: string[] = [];
  const comptes = new Map<string, number>();
  for (const s of toolSteps) {
    if (!s || HORS_PASTILLES.has(s._kind || "")) continue;
    const nom = s.name || "?";
    if (!comptes.has(nom)) ordre.push(nom);
    comptes.set(nom, (comptes.get(nom) ?? 0) + 1);
  }
  if (!ordre.length) return out;
  const tries = ordre
    .map((name, i) => ({ name, count: comptes.get(name) ?? 0, premier: i }))
    .sort((a, b) => b.count - a.count || a.premier - b.premier);
  out.pills = tries
    .slice(0, PASTILLES_MAX)
    .map((p) => ({ name: p.name, count: p.count, icon: toolIconFor(p.name) }));
  out.extraCount = tries.slice(PASTILLES_MAX).reduce((a, t) => a + t.count, 0);
  return out;
}

/** Narration Markdown aplatie en une ligne de résumé (code, liens, emphase et titres retirés). */
export function mdSnippet(t: unknown, max: number): string {
  let s = String(t || "");
  s = s.replace(/```[\s\S]*?(```|$)/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/(\*{1,3}|_{1,3}|~~)([^*_~]+)\1/g, "$2");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

interface StyleCategorie {
  bg: string;
  toggle: string;
}

// Classes écrites en entier : la feuille Tailwind précompilée ne lit que des littéraux.
const MCP_CAT_STYLES: Readonly<Record<string, StyleCategorie>> = {
  blue: { bg: "bg-blue-50 text-blue-600", toggle: "peer-checked:bg-blue-600 peer-checked:border-blue-600" },
  sky: { bg: "bg-sky-50 text-sky-600", toggle: "peer-checked:bg-sky-600 peer-checked:border-sky-600" },
  cyan: { bg: "bg-cyan-50 text-cyan-600", toggle: "peer-checked:bg-cyan-600 peer-checked:border-cyan-600" },
  teal: { bg: "bg-teal-50 text-teal-600", toggle: "peer-checked:bg-teal-600 peer-checked:border-teal-600" },
  emerald: {
    bg: "bg-emerald-50 text-emerald-600",
    toggle: "peer-checked:bg-emerald-600 peer-checked:border-emerald-600",
  },
  green: {
    bg: "bg-green-50 text-green-600",
    toggle: "peer-checked:bg-green-600 peer-checked:border-green-600",
  },
  lime: { bg: "bg-lime-50 text-lime-600", toggle: "peer-checked:bg-lime-600 peer-checked:border-lime-600" },
  amber: {
    bg: "bg-amber-50 text-amber-600",
    toggle: "peer-checked:bg-amber-600 peer-checked:border-amber-600",
  },
  orange: {
    bg: "bg-orange-50 text-orange-600",
    toggle: "peer-checked:bg-orange-600 peer-checked:border-orange-600",
  },
  yellow: {
    bg: "bg-yellow-50 text-yellow-600",
    toggle: "peer-checked:bg-yellow-600 peer-checked:border-yellow-600",
  },
  red: { bg: "bg-red-100 text-red-600", toggle: "peer-checked:bg-red-600 peer-checked:border-red-600" },
  rose: { bg: "bg-rose-100 text-rose-600", toggle: "peer-checked:bg-rose-600 peer-checked:border-rose-600" },
  pink: { bg: "bg-pink-50 text-pink-600", toggle: "peer-checked:bg-pink-600 peer-checked:border-pink-600" },
  fuchsia: {
    bg: "bg-fuchsia-50 text-fuchsia-600",
    toggle: "peer-checked:bg-fuchsia-600 peer-checked:border-fuchsia-600",
  },
  purple: {
    bg: "bg-purple-50 text-purple-600",
    toggle: "peer-checked:bg-purple-600 peer-checked:border-purple-600",
  },
  violet: {
    bg: "bg-violet-50 text-violet-600",
    toggle: "peer-checked:bg-violet-600 peer-checked:border-violet-600",
  },
  indigo: {
    bg: "bg-indigo-50 text-indigo-600",
    toggle: "peer-checked:bg-indigo-600 peer-checked:border-indigo-600",
  },
};
const BLEU: StyleCategorie = {
  bg: "bg-blue-50 text-blue-600",
  toggle: "peer-checked:bg-blue-600 peer-checked:border-blue-600",
};

function styleCategorie(cat: { color?: unknown } | null | undefined): StyleCategorie | null {
  const c = typeof cat?.color === "string" ? cat.color.toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(MCP_CAT_STYLES, c) ? (MCP_CAT_STYLES[c] ?? null) : null;
}

export function mcpCategoryBgClass(cat: { color?: unknown } | null | undefined): string {
  return styleCategorie(cat)?.bg ?? "bg-slate-100 text-slate-600";
}

export function mcpCategoryToggleClass(cat: { color?: unknown } | null | undefined): string {
  return (styleCategorie(cat) ?? BLEU).toggle;
}
