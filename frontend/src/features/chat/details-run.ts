// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/details-run.ts — « Détails » d'une réponse : chronologie de l'exécution, agrégats et export, côté compte ou console (porté de `chat/_run_details.js`). */
import { ref } from "vue";

import { fmtTokenCount, tokenBreakdown } from "../../utils/utils-purs.ts";
import type { DetailTokens } from "../../utils/utils-purs.ts";
import type { FetchAuth } from "./flux/aides.ts";

export interface EtatDetailsRun {
  runId: string;
  ids: string[];
  admin: boolean;
  loading: boolean;
  error: string;
  data: ChronologieRun | null;
  open: Record<number, boolean>;
}

export interface LigneTokens {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  thinking_tokens?: unknown;
  tool_tokens?: unknown;
  cache_creation_tokens?: unknown;
}

export interface EvenementRun extends LigneTokens {
  type?: string;
  model?: string;
  tool_name?: string;
  kind?: string;
  status?: string;
  exit_code?: number | null;
  argument?: string;
  at?: number;
  duration_ms?: number;
  error_short?: string;
  result?: string;
  category?: string;
  args_bytes?: number | null;
  result_bytes?: number | null;
  source?: string;
  error_kind?: string;
  iterations?: number;
  run_id?: string;
}

export interface ExecutionRun extends LigneTokens {
  status?: string;
  started_at: number;
  ended_at?: number | null;
  tool_calls?: number;
  tool_errors?: number;
  prefill_ms?: number;
  decode_ms?: number;
  wait_ms?: number;
  files_changed?: number;
  engine?: string;
  model?: string;
  sandbox_cpu_peak?: number | null;
  sandbox_mem_peak_mb?: number | null;
}

export interface ChronologieRun {
  run: ExecutionRun;
  events: EvenementRun[];
}

/** Chronologie reçue de `/timeline` : exécution et liste d'événements, ou null hors forme. */
export function lireChronologie(d: unknown): ChronologieRun | null {
  if (!d || typeof d !== "object") return null;
  const o = d as { run?: unknown; events?: unknown };
  if (!o.run || typeof o.run !== "object") return null;
  const run = o.run as ExecutionRun;
  const events = Array.isArray(o.events)
    ? (o.events as unknown[]).filter((e): e is EvenementRun => !!e && typeof e === "object")
    : [];
  return { run: { ...run, started_at: Number(run.started_at) || 0 }, events };
}

const GENRES: Readonly<Record<string, string>> = {
  chat: "Tour de chat",
  routine: "Routine",
  subagent: "Sous-agent",
  compaction: "Compaction",
  image: "Images",
};

const base = (admin: boolean): string => (admin ? "/api/admin/runs/" : "/api/runs/");

export function runDuration(ms: unknown): string {
  const n = Math.round(Number(ms) || 0);
  if (n < 1000) return n + " ms";
  if (n < 60000) return (n / 1000).toFixed(1).replace(".", ",") + " s";
  return Math.floor(n / 60000) + " min " + Math.round((n % 60000) / 1000) + " s";
}

export function runEventLabel(ev: EvenementRun | null | undefined): string {
  if (!ev) return "";
  if (ev.type === "llm") return "Modèle" + (ev.model ? " · " + ev.model : "");
  if (ev.type === "tool") return ev.tool_name || "Outil";
  if (ev.type === "child") return GENRES[ev.kind || ""] || "Exécution";
  return "";
}

function postes(r: LigneTokens | null | undefined): DetailTokens {
  return tokenBreakdown(
    r?.input_tokens,
    r?.output_tokens,
    r?.cache_read_tokens,
    r?.thinking_tokens,
    r?.tool_tokens,
  );
}

export function runInput(r: LigneTokens | null | undefined): string {
  const b = postes(r);
  return fmtTokenCount(b.input) + (b.cache ? " (cache " + b.cache_pct + " %)" : "");
}

export function runOutput(r: LigneTokens | null | undefined): string {
  const b = postes(r);
  return fmtTokenCount(b.output) + (b.thinking ? " (réflexion " + fmtTokenCount(b.thinking) + ")" : "");
}

/** Comptes exacts, pour l'infobulle des tuiles. */
export function runTokensTitle(r: LigneTokens | null | undefined): string {
  const b = postes(r);
  const n = (x: number): string => x.toLocaleString("fr-FR");
  let t =
    "Entrée " +
    n(b.input) +
    " : cache " +
    n(b.cache) +
    " · utile " +
    n(b.input_new) +
    (b.tools ? " · outils ≈ " + n(b.tools) : "") +
    "\nSortie " +
    n(b.output) +
    " : réflexion " +
    n(b.thinking) +
    " · réponse " +
    n(b.response);
  const crees = Number(r?.cache_creation_tokens) || 0;
  if (crees) t += "\nMis en cache " + n(crees);
  return t;
}

export function runEventMeta(ev: EvenementRun | null | undefined): string {
  if (!ev) return "";
  if (ev.type === "llm") return runInput(ev) + " → " + runOutput(ev);
  if (ev.type === "tool") {
    const parts: string[] = [];
    if (ev.exit_code !== null && ev.exit_code !== undefined) parts.push("code " + ev.exit_code);
    if (ev.argument) parts.push(ev.argument);
    return parts.join(" · ");
  }
  if (ev.type === "child") return ev.status || "";
  return "";
}

export function runEventState(ev: EvenementRun | null | undefined): string {
  const s = String(ev?.status || "ok");
  if (s === "ok" || s === "success") return "ok";
  if (s === "cancelled" || s === "aborted") return "stop";
  return "error";
}

export function runClock(ts: unknown): string {
  try {
    return new Date(Number(ts) * 1000).toLocaleTimeString("fr-FR");
  } catch {
    return "";
  }
}

export function setupRunDetails(_vue: unknown, ctx: { fetchAuth?: FetchAuth } | null) {
  const runDetails = ref<EtatDetailsRun | null>(null);
  const lire: FetchAuth = ctx && typeof ctx.fetchAuth === "function" ? ctx.fetchAuth : (u, o) => fetch(u, o);
  // Une réponse arrivée après fermeture ou changement d'onglet n'écrit rien.
  const courant = (id: string): EtatDetailsRun | null =>
    runDetails.value && runDetails.value.runId === id ? runDetails.value : null;

  async function showRunDetails(
    runId: string,
    ids?: readonly string[] | null,
    opts?: { admin?: boolean },
  ): Promise<void> {
    const liste = Array.isArray(ids) && ids.length ? [...ids] : [runId];
    const admin = opts && typeof opts.admin === "boolean" ? opts.admin : !!runDetails.value?.admin;
    runDetails.value = { runId, ids: liste, admin, loading: true, error: "", data: null, open: {} };
    try {
      const r = await lire(base(admin) + encodeURIComponent(runId) + "/timeline", {}, true);
      const d = courant(runId);
      if (!d) return;
      if (!r || !r.ok) {
        runDetails.value = {
          ...d,
          loading: false,
          error:
            r && r.status === 404
              ? "Détails indisponibles (exécution purgée ou antérieure à cette version)."
              : "Détails indisponibles.",
        };
        return;
      }
      const data = lireChronologie(await r.json());
      const apres = courant(runId);
      if (apres)
        runDetails.value = { ...apres, loading: false, data, error: data ? "" : "Détails indisponibles." };
    } catch {
      const d = courant(runId);
      if (d) runDetails.value = { ...d, loading: false, error: "Détails indisponibles (réseau)." };
    }
  }

  function openRunDetails(msg: { run_ids?: readonly unknown[] | null } | null | undefined): void {
    const ids = Array.isArray(msg?.run_ids)
      ? msg.run_ids.filter((x): x is string => typeof x === "string" && !!x)
      : [];
    const dernier = ids[ids.length - 1];
    if (dernier) void showRunDetails(dernier, ids, { admin: false });
  }

  function closeRunDetails(): void {
    runDetails.value = null;
  }

  function toggleRunEvent(i: number): void {
    const d = runDetails.value;
    if (d) runDetails.value = { ...d, open: { ...d.open, [i]: !d.open[i] } };
  }

  function runExportHref(id: string): string {
    return base(!!runDetails.value?.admin) + encodeURIComponent(id) + "/export";
  }

  return {
    runDetails,
    openRunDetails,
    closeRunDetails,
    showRunDetails,
    toggleRunEvent,
    runDuration,
    runEventLabel,
    runEventMeta,
    runEventState,
    runClock,
    runExportHref,
    runInput,
    runOutput,
    runTokensTitle,
  };
}
