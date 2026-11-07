// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/cloture.ts — clôture d'un tour arrêté ou en échec : étapes en cours arrêtées (durée figée), sous-agents annulés (sauf ceux en fond), budget de tours retiré. */
import type { EntreeDeroule, EtapeChat, ExecutionTache, MessageChat, OutilSousAgent } from "./types.ts";

export const ETAPE_ARRETEE = "stopped";

function arreterEtape(s: EtapeChat, maintenant: number): EtapeChat {
  if (s._kind === "compression") return { ...s, status: "skipped", progress: 0, reasonLabel: "Interrompue" };
  const ms = typeof s.startedAt === "number" ? Math.max(0, maintenant - s.startedAt) : s.durationMs;
  const { progressInfo: _p, ...reste } = s;
  return { ...reste, status: ETAPE_ARRETEE, ...(typeof ms === "number" ? { durationMs: ms } : {}) };
}

const enAttenteOuCours = (s: EtapeChat): boolean => s.status === "running" || s.status === "waiting";

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
  if (steps?.some(enAttenteOuCours))
    p.toolSteps = steps.map((s) => (enAttenteOuCours(s) ? arreterEtape(s, maintenant) : s));
  // Un sous-agent en fond survit au tour : seul son ✕ l'arrête.
  const runs = m.taskRuns;
  const coupe = (x: ExecutionTache): boolean => x.state === "running" && !x.background;
  if (runs?.some(coupe)) p.taskRuns = runs.map((x) => (coupe(x) ? annulerSousAgent(x) : x));
  if (m.iterBudget) p.iterBudget = null;
  return Object.keys(p).length ? p : null;
}
