// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/agents.ts — un sous-agent dit comme une étape : ce qu'il fait, son bilan court, son état en français, et sa chronologie (narrations et étapes groupées) pour la fenêtre de l'agent. */
import type { ResumeJob } from "@elpis/contracts";

import { fmtTokenCount, tokenBreakdown } from "../../../utils/utils-purs.ts";
import type { EtapeNumerotee } from "../message/chronologie.ts";
import {
  libelleEtatRun,
  libelleReserve,
  lireBilanTache,
  resumeDetailsTache,
  statutReserve,
} from "./bilan-tache.ts";
import type { EtapeOutil, ExecutionSousAgent } from "./types.ts";
import { texteEtape } from "./verbes.ts";

export interface EntreeAgent {
  text?: string;
  parent?: string;
  tool?: string;
  args_preview?: string;
  status?: string;
  result_preview?: string;
}

export type BlocAgent =
  | { k: "texte"; cle: string; texte: string }
  | { k: "parent"; cle: string; texte: string }
  | { k: "etapes"; cle: string; etapes: EtapeNumerotee[] };

const entrees = (run: ExecutionSousAgent): EntreeAgent[] =>
  (Array.isArray(run.transcript) ? run.transcript : []).filter(
    (e): e is EntreeAgent => !!e && typeof e === "object",
  );

// L'aperçu des arguments est un texte : objet JSON relu si possible, sinon gardé comme objet de l'étape.
function argumentsLus(apercu: string): Record<string, unknown> {
  try {
    const o: unknown = JSON.parse(apercu);
    if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
  } catch {
    /* aperçu tronqué ou non JSON */
  }
  return apercu ? { query: apercu } : {};
}

const STATUTS: Readonly<Record<string, string>> = { running: "running", cancelled: "stopped" };

/** Entrée d'outil du déroulé → étape affichable (même grammaire que le fil). */
export function etapeDeroule(e: EntreeAgent): EtapeOutil {
  return {
    name: e.tool || "outil",
    status: STATUTS[e.status ?? ""] ?? "done",
    _is_error: e.status === "error",
    args: argumentsLus(e.args_preview ?? ""),
    result: e.result_preview ?? null,
  };
}

/** Chronologie d'un agent : narrations et messages du parent à leur place, étapes consécutives groupées, numérotées sur tout le déroulé. */
export function chronologieAgent(run: ExecutionSousAgent): BlocAgent[] {
  const blocs: BlocAgent[] = [];
  let numero = 0;
  entrees(run).forEach((e, i) => {
    if (e.parent) {
      blocs.push({ k: "parent", cle: "p:" + i, texte: e.parent });
      return;
    }
    if (e.text) {
      blocs.push({ k: "texte", cle: "t:" + i, texte: e.text });
      return;
    }
    const etape = { etape: etapeDeroule(e), flat: i, numero: ++numero };
    const dernier = blocs[blocs.length - 1];
    if (dernier?.k === "etapes") dernier.etapes.push(etape);
    else blocs.push({ k: "etapes", cle: "e:" + i, etapes: [etape] });
  });
  return blocs;
}

/** « Étape 6 · Lit query.ts » pendant que l'agent travaille ; vide avant sa première étape. */
export function etapeCouranteAgent(run: ExecutionSousAgent): string {
  const outils = entrees(run).filter((e) => e.tool);
  const e = [...outils].reverse().find((x) => x.status === "running") ?? outils[outils.length - 1];
  if (!e) return "";
  const n = run.progress?.step || outils.length;
  return "Étape " + n + " · " + texteEtape(etapeDeroule(e));
}

/** Bilan court d'un agent fini (« 2 fichiers · 1 commit », « 14 appels ») précédé de son état, ou de sa réserve s'il est terminé sans réussite déclarée. */
export function bilanCourtAgent(run: ExecutionSousAgent): string {
  const h = run.harness;
  const bilan = h
    ? resumeDetailsTache(h) || `${h.tool_calls} appel${h.tool_calls > 1 ? "s" : ""}`
    : run.steps_total
      ? `${run.steps_total} appel${run.steps_total > 1 ? "s" : ""}`
      : "";
  const reserve = statutReserve(run);
  if (run.state === "completed" && reserve === null) return bilan || "terminé";
  return [reserve === null ? libelleEtatRun(run.state) : libelleReserve(reserve), bilan]
    .filter(Boolean)
    .join(" · ");
}

/** « 2 agents · 1 fini » pour des agents lancés ensemble. */
export function resumeAgents(runs: readonly ExecutionSousAgent[]): string {
  const finis = runs.filter((r) => r.state && r.state !== "running").length;
  return `${runs.length} agents · ${finis} fini${finis > 1 ? "s" : ""}`;
}

export interface JetonsAgent {
  /** « 42,9 k jetons » : contexte de la dernière requête de l'agent tel que le moteur l'a rapporté, comme le pied du message principal ; vide avant la première requête. */
  conso: string;
  /** Détail pour l'infobulle, comme celle du message principal : contexte, puis entrée et sortie cumulées sur ses appels au moteur. */
  detail: string;
}

/** Jetons d'un sous-agent affichés comme ceux du message principal : seulement ce que le moteur a rapporté, le contexte de la dernière requête en vue, les cumuls dans le détail. */
export function jetonsAgent(run: ExecutionSousAgent): JetonsAgent {
  const d = tokenBreakdown(run.input_tokens, run.output_tokens, run.cache_tokens, run.think_tokens);
  const ctx = Math.max(0, Number(run.tokens) || 0);
  const k = fmtTokenCount;
  const lignes: string[] = [];
  if (ctx > 0) lignes.push(`Contexte ${k(ctx)} à la dernière requête au moteur`);
  if (d.input)
    lignes.push(
      `Entrée ${k(d.input)} cumulée sur ses appels au moteur` +
        (d.cache ? ` · cache ${k(d.cache)} (${d.cache_pct} %)` : ""),
    );
  if (d.output)
    lignes.push(
      `Sortie ${k(d.output)}` +
        (d.thinking ? ` · réflexion ${k(d.thinking)} · réponse ${k(d.response)}` : ""),
    );
  return {
    conso: ctx > 0 ? `${k(ctx)} jetons` : "",
    detail: lignes.join("\n"),
  };
}

const nb = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Sous-agent lancé en fond vu à travers son job : progression en direct, puis état final (statut du harnais, rapport, jetons) une fois le tour fini ou la page rechargée ; tout autre run tel quel. */
export function avecJobFond<T extends ExecutionSousAgent>(run: T, jobs: readonly ResumeJob[]): T {
  if (!run.background || !jobs.length) return run;
  const job = jobs.find(
    (j) => j.kind === "agent" && (j.id === run.job_id || (run.id && j.agent?.child_id === run.id)),
  );
  const d = job?.agent;
  if (!job || !d) return run;
  const actif = job.state === "running" || job.state === "starting";
  const plus = (a: number | null | undefined, b: number | undefined): number | undefined =>
    b === undefined ? (a ?? undefined) : Math.max(a ?? 0, b);
  const vu: ExecutionSousAgent = {
    ...run,
    id: run.id || d.child_id,
    tokens: plus(run.tokens, nb(d.context_tokens)) ?? null,
    input_tokens: plus(run.input_tokens, nb(d.input_tokens)) ?? null,
    output_tokens: plus(run.output_tokens, nb(d.output_tokens)) ?? null,
    cache_tokens: plus(run.cache_tokens, nb(d.cache_tokens)) ?? null,
    think_tokens: plus(run.think_tokens, nb(d.think_tokens)) ?? null,
  };
  if (actif) {
    if (run.state !== "running") return run;
    if (typeof d.step === "number" && (run.progress?.step ?? 0) < d.step)
      vu.progress = { step: d.step, max_steps: d.max_steps ?? run.progress?.max_steps ?? null };
    if (typeof run.startedAt !== "number" && typeof d.started_at === "number")
      vu.startedAt = d.started_at * 1000;
    return vu as T;
  }
  const bilan = lireBilanTache(d.harness);
  const resultat = d.result;
  vu.state =
    job.state === "lost"
      ? "lost"
      : d.state && d.state !== "running"
        ? d.state
        : job.state === "killed"
          ? "cancelled"
          : "completed";
  vu.progress = null;
  vu.cancelRequested = false;
  if (typeof d.tool_calls === "number") vu.steps_total = d.tool_calls;
  if (typeof d.duration_s === "number") vu.duration_ms = Math.round(d.duration_s * 1000);
  if (bilan) vu.harness = bilan;
  if (!run.result && typeof resultat === "string") vu.result = resultat;
  return vu as T;
}
