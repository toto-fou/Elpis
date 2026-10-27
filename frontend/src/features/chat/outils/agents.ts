// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/agents.ts — un sous-agent dit comme une étape : ce qu'il fait, son bilan court, son état en français, et sa chronologie (narrations et étapes groupées) pour le volet de l'agent. */
import type { EtapeNumerotee } from "../message/chronologie.ts";
import { libelleEtatRun, libelleStatutTache, resumeDetailsTache, statutReserve } from "./bilan-tache.ts";
import type { EtapeOutil, ExecutionSousAgent } from "./types.ts";
import { texteEtape } from "./verbes.ts";

export interface EntreeAgent {
  text?: string;
  tool?: string;
  args_preview?: string;
  status?: string;
  result_preview?: string;
}

export type BlocAgent =
  { k: "texte"; cle: string; texte: string } | { k: "etapes"; cle: string; etapes: EtapeNumerotee[] };

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

/** Chronologie d'un agent : narrations à leur place, étapes consécutives groupées, numérotées sur tout le déroulé. */
export function chronologieAgent(run: ExecutionSousAgent): BlocAgent[] {
  const blocs: BlocAgent[] = [];
  let numero = 0;
  entrees(run).forEach((e, i) => {
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

/** Bilan court d'un agent fini (« 2 fichiers · 1 commit », « 14 appels ») précédé de son état, ou de son statut s'il est terminé sans réussite déclarée. */
export function bilanCourtAgent(run: ExecutionSousAgent): string {
  const h = run.harness;
  const bilan = h
    ? resumeDetailsTache(h) || `${h.tool_calls} appel${h.tool_calls > 1 ? "s" : ""}`
    : run.steps_total
      ? `${run.steps_total} appel${run.steps_total > 1 ? "s" : ""}`
      : "";
  const reserve = statutReserve(run);
  if (run.state === "completed" && reserve === null) return bilan || "terminé";
  return [reserve === null ? libelleEtatRun(run.state) : libelleStatutTache(reserve), bilan]
    .filter(Boolean)
    .join(" · ");
}

/** « 2 agents · 1 fini » pour des agents lancés ensemble. */
export function resumeAgents(runs: readonly ExecutionSousAgent[]): string {
  const finis = runs.filter((r) => r.state && r.state !== "running").length;
  return `${runs.length} agents · ${finis} fini${finis > 1 ? "s" : ""}`;
}
