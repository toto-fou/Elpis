// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/chronologie.ts — un tour en une liste ordonnée, dans l'ordre d'arrivée : réflexion, texte, étapes consécutives groupées et numérotées sur le tour, sous-agents, tâches de fond, mémoire, compression ; même liste en direct et au rechargement. */
import type { EtapeOutil, ExecutionSousAgent } from "../outils/types.ts";
import { estEcritureMemoire } from "./effets.ts";
import { estLancementJob } from "./taches-fond.ts";

export interface EtapeNumerotee {
  etape: EtapeOutil;
  /** Position dans `toolSteps` (détail ouvert, captures). */
  flat: number;
  /** Rang de l'étape sur tout le tour (« Étape 3 »). */
  numero: number;
}

export interface AgentDuTour {
  etape: EtapeOutil;
  flat: number;
  /** Index du run dans `taskRuns`, ou -1 s'il n'est pas encore connu. */
  ri: number;
}

export type BlocFil =
  | { k: "texte"; cle: string; texte: string }
  | { k: "reflexion"; cle: string; texte: string; ms: number | null; vivante: boolean }
  | { k: "etapes"; cle: string; etapes: EtapeNumerotee[] }
  | { k: "agents"; cle: string; agents: AgentDuTour[] }
  | { k: "job"; cle: string; etape: EtapeOutil; flat: number }
  | { k: "memoire"; cle: string; flat: number; rang: number }
  | { k: "compression"; cle: string; etape: EtapeOutil; flat: number };

export interface MessageFil {
  toolSteps?: readonly EtapeOutil[] | null;
  segTexts?: readonly string[] | null;
  taskRuns?: readonly (ExecutionSousAgent & { callId?: string | null })[] | null;
  thinking?: string | null;
  isStreaming?: boolean;
  content?: string | null;
  _pendingPreContent?: string | null;
  _thinkingMs?: number;
  _thinkingStartedAt?: number;
  _thinkingEndedAt?: number;
}

const estAgent = (s: EtapeOutil): boolean => s._kind === "task" || s.name === "task";
const estTaches = (s: EtapeOutil): boolean => s._kind === "todo" || s.name === "todowrite";

function msReflexionFinale(m: MessageFil, maintenant: number): number | null {
  if (typeof m._thinkingMs === "number") return m._thinkingMs;
  if (!m._thinkingStartedAt) return null;
  return Math.max(0, (m._thinkingEndedAt ?? maintenant) - m._thinkingStartedAt);
}

/** Blocs du tour d'un message assistant, dans l'ordre où ils sont arrivés. */
export function chronologieTour(m: MessageFil, maintenant = Date.now()): BlocFil[] {
  const steps = m.toolSteps ?? [];
  const textes = m.segTexts ?? [];
  const runs = m.taskRuns ?? [];
  const blocs: BlocFil[] = [];
  let segSuivant = 0;
  let numero = 0;
  let rangMemoire = 0;
  let rangAgent = 0;
  // Textes des segments jusqu'à `seg` inclus, une seule fois, dans l'ordre.
  const textesJusqua = (seg: number): void => {
    for (; segSuivant <= seg && segSuivant < textes.length; segSuivant++) {
      const t = (textes[segSuivant] ?? "").trim();
      if (t) blocs.push({ k: "texte", cle: "t:" + segSuivant, texte: textes[segSuivant] ?? "" });
    }
  };
  steps.forEach((s, flat) => {
    const seg = Math.max(0, s.seg ?? 0);
    textesJusqua(seg - 1);
    if (s.thinking)
      blocs.push({
        k: "reflexion",
        cle: "r:" + flat,
        texte: s.thinking,
        ms: s.thinkingMs ?? null,
        vivante: false,
      });
    textesJusqua(seg);
    if (estTaches(s)) return;
    const dernier = blocs[blocs.length - 1];
    if (estAgent(s)) {
      const parAppel = s.callId ? runs.findIndex((r) => r.callId === s.callId) : -1;
      const ri = parAppel >= 0 ? parAppel : rangAgent < runs.length ? rangAgent : -1;
      rangAgent++;
      const agent = { etape: s, flat, ri };
      if (dernier?.k === "agents") dernier.agents.push(agent);
      else blocs.push({ k: "agents", cle: "a:" + flat, agents: [agent] });
    } else if (estLancementJob(s)) blocs.push({ k: "job", cle: "j:" + flat, etape: s, flat });
    else if (estEcritureMemoire(s)) blocs.push({ k: "memoire", cle: "m:" + flat, flat, rang: rangMemoire++ });
    else if (s._kind === "compression") blocs.push({ k: "compression", cle: "c:" + flat, etape: s, flat });
    else {
      const e = { etape: s, flat, numero: ++numero };
      if (dernier?.k === "etapes") dernier.etapes.push(e);
      else blocs.push({ k: "etapes", cle: "e:" + flat, etapes: [e] });
    }
  });
  textesJusqua(textes.length - 1);
  if (m.thinking) {
    const vivante = !!m.isStreaming && !m.content && !m._pendingPreContent;
    blocs.push({
      k: "reflexion",
      cle: "r:fin",
      texte: m.thinking,
      ms: msReflexionFinale(m, maintenant),
      vivante,
    });
  }
  return blocs;
}

/** Textes du tour dans l'ordre (narrations puis réponse), pour « Copier ». */
export function textesDuTour(m: MessageFil): string {
  const textes = (m.segTexts ?? []).map((t) => t.trim()).filter(Boolean);
  const fin = (m.content ?? "").trim();
  if (fin && textes[textes.length - 1] !== fin) textes.push(fin);
  return textes.join("\n\n");
}
