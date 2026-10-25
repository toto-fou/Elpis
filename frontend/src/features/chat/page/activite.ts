// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/activite.ts — barre « Activité » : ce qui tourne dans la conversation (sous-agents, étape en cours), étape d'un job dans le fil, retour à une ligne du fil avec un bref surlignage. */
import type { ExecutionTache, MessageChat } from "../coeur/types";

export interface SousAgentActif {
  idx: number;
  ri: number;
  libelle: string;
  titre: string;
}

export interface EtapeEnCours {
  callId: string | null;
  nom: string;
}

const messagesChat = (m: readonly unknown[]): readonly MessageChat[] => m as readonly MessageChat[];

/** Sous-agents en cours, du plus récent message au plus ancien. */
export function sousAgentsActifs(messages: readonly unknown[]): SousAgentActif[] {
  const out: SousAgentActif[] = [];
  messagesChat(messages).forEach((m, idx) => {
    (m?.taskRuns ?? []).forEach((run: ExecutionTache, ri) => {
      if (run.state !== "running") return;
      const nom = run.label || run.agent || "Sous-agent";
      const p = run.progress;
      const etape = p && p.step ? ` · étape ${p.step}${p.max_steps ? "/" + p.max_steps : ""}` : "";
      out.push({ idx, ri, libelle: nom + etape, titre: `Ouvrir le déroulé de ${nom}` });
    });
  });
  return out.reverse();
}

/** Dernière étape d'outil qui tourne dans le message en cours de génération. */
export function etapeEnCours(messages: readonly unknown[]): EtapeEnCours | null {
  const dernier = messagesChat(messages).at(-1);
  if (!dernier || dernier.role !== "assistant" || !dernier.isStreaming) return null;
  const etape = [...(dernier.toolSteps ?? [])].reverse().find((s) => s.status === "running");
  return etape ? { callId: etape.callId ?? null, nom: etape.name } : null;
}

/** Appel `shell_job` qui a lancé ce job : son identifiant figure dans le résultat de l'outil. */
export function appelDuJob(messages: readonly unknown[], jobId: string): string | null {
  const liste = messagesChat(messages);
  for (let i = liste.length - 1; i >= 0; i--) {
    for (const s of liste[i]?.toolSteps ?? []) {
      if (s.name !== "shell_job" || !s.callId) continue;
      const res = typeof s.result === "string" ? s.result : JSON.stringify(s.result ?? "");
      if (res.includes(jobId)) return s.callId;
    }
  }
  return null;
}

const SURLIGNAGE_MS = 1200;

/** Fait défiler jusqu'à la ligne du fil `[data-etape="<callId>"]` et la surligne brièvement ; faux si elle est absente. */
export function allerALEtape(callId: string | null | undefined): boolean {
  if (!callId) return false;
  const el = document.querySelector<HTMLElement>(`[data-etape="${CSS.escape(callId)}"]`);
  if (!el) return false;
  const reduit = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ block: "center", behavior: reduit ? "auto" : "smooth" });
  if (!reduit && typeof el.animate === "function") {
    el.animate([{ boxShadow: "0 0 0 3px var(--accent-ring)" }, { boxShadow: "0 0 0 0 transparent" }], {
      duration: SURLIGNAGE_MS,
      easing: "ease-out",
    });
  } else {
    el.style.outline = "2px solid var(--accent-ring)";
    setTimeout(() => (el.style.outline = ""), SURLIGNAGE_MS);
  }
  return true;
}
