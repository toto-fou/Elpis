// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/cloture.ts — clôture d'un tour arrêté ou en échec : étapes en cours arrêtées (durée figée), sous-agents annulés, budget de tours retiré. */
import type { EntreeDeroule, EtapeChat, ExecutionTache, MessageChat, OutilSousAgent } from "./types.ts";

export const ETAPE_ARRETEE = "stopped";

function arreterEtape(s: EtapeChat, maintenant: number): EtapeChat {
  if (s._kind === "compression") return { ...s, status: "skipped", progress: 0, reasonLabel: "Interrompue" };
  const ms = typeof s.startedAt === "number" ? Math.max(0, maintenant - s.startedAt) : s.durationMs;
  const { progressInfo: _p, ...reste } = s;
  return { ...reste, status: ETAPE_ARRETEE, ...(typeof ms === "number" ? { durationMs: ms } : {}) };
}

function annulerEntrees<T extends OutilSousAgent | EntreeDeroule>(liste: T[] | undefined): T[] | undefined {
  return liste?.some((x) => x.status === "running")
    ? liste.map((x) => (x.status === "running" ? { ...x, status: "cancelled" } : x))
    : liste;
}

function annulerSousAgent(x: ExecutionTache): ExecutionTache {
  return {
    ...x,
    state: "cancelled",
    progress: null,
    tools: annulerEntrees(x.tools),
    transcript: annulerEntrees(x.transcript),
  };
}

/** Champs à poser sur le message pour clore ce qui tourne encore ; `null` s'il n'y a rien à clore. */
export function cloreTour(m: MessageChat, maintenant = Date.now()): Partial<MessageChat> | null {
  const p: Partial<MessageChat> = {};
  const steps = m.toolSteps;
  if (steps?.some((s) => s.status === "running"))
    p.toolSteps = steps.map((s) => (s.status === "running" ? arreterEtape(s, maintenant) : s));
  const runs = m.taskRuns;
  if (runs?.some((x) => x.state === "running"))
    p.taskRuns = runs.map((x) => (x.state === "running" ? annulerSousAgent(x) : x));
  if (m.iterBudget) p.iterBudget = null;
  return Object.keys(p).length ? p : null;
}
