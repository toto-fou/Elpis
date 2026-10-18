// SPDX-License-Identifier: MIT
/** frontend/src/utils/utils-purs.ts — fonctions pures d'utils.js : échappement, chemins, durées, tokens, recherche floue, agents intégrés. */

export interface AnalyseChemin {
  path: string;
  line: number;
  col: number;
}

export interface OptionsDuree {
  live?: boolean;
  precise?: boolean;
}

export interface DetailTokens {
  input: number;
  cache: number;
  input_new: number;
  tools: number;
  output: number;
  thinking: number;
  response: number;
  cache_pct: number;
}

export interface AgentIntegre {
  name: string;
  icon: string;
  hint: string;
}

const ENTITES_HTML: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ENTITES_HTML[c] ?? c);
}

const PATH_EXTS = new Set(
  (
    "py pyi js mjs cjs ts tsx jsx vue svelte json jsonc md mdx markdown txt " +
    "html htm css scss less xml svg yml yaml toml ini cfg conf env sh bash zsh ps1 bat " +
    "go rs java kt kts c h cc cpp hpp cs rb php pl lua r sql csv tsv log lock " +
    "dockerfile makefile gradle properties rst tex robot ipynb docx xlsx pptx pdf png jpg jpeg gif webp"
  ).split(" "),
);
const PATH_RE = /^(\.{0,2}\/)?((?:[\w@.-]+\/)*[\w@.-]+?)(?::(\d+))?(?::(\d+))?$/;

/** Chemin de fichier plausible (message du chat, terminal) : { path, line, col } ou null. */
export function parsePath(s: unknown): AnalyseChemin | null {
  const t = String(s == null ? "" : s).trim();
  if (!t || t.length > 300 || /\s/.test(t) || /:\/\//.test(t)) return null;
  const m = PATH_RE.exec(t);
  if (!m) return null;
  const lead = m[1] || "";
  let path = m[2] ?? "";
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
  const hasSlash = path.indexOf("/") >= 0 || !!lead;
  const dotfile = dot === 0 && base.length > 1;
  const resultat = (): AnalyseChemin => ({
    path,
    line: m[3] ? Number(m[3]) : 0,
    col: m[4] ? Number(m[4]) : 0,
  });
  if (dotfile) {
    if (lead === "/" && path.indexOf("work/") === 0) path = path.slice(5);
    return hasSlash || PATH_EXTS.has(ext.slice(1)) ? resultat() : null;
  }
  if (!hasSlash && !PATH_EXTS.has(ext)) return null;
  if (!hasSlash && (ext === "log" || ext === "env") && /^[A-Za-z_$][\w$]*$/.test(base.slice(0, dot)))
    return null;
  if (dot <= 0 && !PATH_EXTS.has(ext)) return null;
  if (lead === "/" && path.indexOf("work/") === 0) path = path.slice(5);
  return resultat();
}

export function looksLikePath(s: unknown): boolean {
  return !!parsePath(s);
}

/** Durée lisible en secondes entières : « 42 s », « 3 min 07 s », « 1 h 04 min » ; sous la seconde selon `opts`. */
export function fmtElapsed(sec: unknown, opts?: OptionsDuree | null): string {
  const raw = Math.max(0, Number(sec) || 0);
  const s = Math.floor(raw);
  if (s < 1) {
    if (opts && opts.live) return "0 s";
    if (opts && opts.precise) return raw < 0.1 ? "<0.1 s" : (Math.floor(raw * 10) / 10).toFixed(1) + " s";
    return "<1 s";
  }
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
  return Math.floor(s / 3600) + " h " + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + " min";
}

export function fmtElapsedMs(ms: unknown, opts?: OptionsDuree | null): string {
  return fmtElapsed((Number(ms) || 0) / 1000, opts);
}

/** Format compact unique des compteurs de tokens (fr-FR) : « 845 », « 12,3 k », « 1,2 M ». */
export function fmtTokenCount(n: unknown): string {
  const v = Math.max(0, Number(n) || 0);
  const f = (x: number, d: number): string => x.toLocaleString("fr-FR", { maximumFractionDigits: d });
  if (v >= 999500) return f(v / 1e6, v >= 1e8 ? 0 : 1) + " M";
  if (v >= 1000) return f(v / 1000, v >= 1e5 ? 0 : 1) + " k";
  return String(Math.round(v));
}

/** Postes d'une consommation : l'entrée contient cache et outils, la sortie contient la réflexion. */
export function tokenBreakdown(
  input: unknown,
  output: unknown,
  cache: unknown,
  thinking?: unknown,
  tools?: unknown,
): DetailTokens {
  const n = (x: unknown): number => Math.max(0, Math.round(Number(x) || 0));
  const inp = n(input);
  const out = n(output);
  const c = Math.min(n(cache), inp);
  const t = Math.min(n(thinking), out);
  return {
    input: inp,
    cache: c,
    input_new: inp - c,
    tools: Math.min(n(tools), inp),
    output: out,
    thinking: t,
    response: out - t,
    cache_pct: inp ? Math.round((c / inp) * 100) : 0,
  };
}

/** Sous-séquence insensible aux accents : { score, idx } (positions dans `hay`) ou null. */
export function fuzzyMatch(needle: unknown, hay: unknown): { score: number; idx: number[] } | null {
  if (!needle) return null;
  const strip = (s: unknown): string => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const n = strip(needle);
  const h = strip(hay);
  const idx: number[] = [];
  let hi = 0;
  let score = 0;
  let streak = 0;
  let lastMatchedIdx = -2;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n.charAt(ni);
    while (hi < h.length && h.charAt(hi) !== c) hi++;
    if (hi >= h.length) return null;
    if (hi === lastMatchedIdx + 1) {
      streak++;
      score += 2 + streak;
    } else {
      streak = 0;
      const prev = hi > 0 ? h.charAt(hi - 1) : "/";
      score += "/_-. ›".indexOf(prev) >= 0 ? 3 : 1;
    }
    idx.push(hi);
    lastMatchedIdx = hi;
    hi++;
  }
  const compactness = n.length / Math.max(1, h.length);
  return { score: score * (0.5 + compactness * 0.5), idx };
}

/** Forme canonique d'un chemin du bac (miroir de strip_work_prefix côté serveur) ; `sbRoot` : préfixe hôte affiché. */
export function canonPath<T>(p: T, sbRoot?: string | null): T | string {
  if (p === null || p === undefined) return p;
  let s = String(p).replace(/\\/g, "/").trim();
  if (sbRoot && s.startsWith(sbRoot)) s = s.substring(sbRoot.length);
  const out: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length && out[0] === "work") out.shift();
  return out.join("/");
}

export const BUILTIN_AGENTS: readonly AgentIntegre[] = [
  { name: "explore", icon: "ph-magnifying-glass", hint: "Explore le code et répond, sans rien modifier" },
  { name: "implement", icon: "ph-code", hint: "Écrit la modification et la vérifie, sans commiter" },
  { name: "verify", icon: "ph-test-tube", hint: "Lance les tests, diagnostique, ne modifie rien" },
  { name: "web", icon: "ph-globe", hint: "Recherche web sur navigateur réel, avec sources" },
  { name: "pr", icon: "ph-git-pull-request", hint: "Branche, commite et ouvre la pull request" },
];

export const RESERVED_AGENT_NAMES: readonly string[] = ["task"];
