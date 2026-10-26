// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/types.ts — formes lues par les composants des segments d'outils (étapes, groupes, sous-agents, tâches). */
import type { BilanTache } from "@elpis/contracts";

export interface StatsCompression {
  tokens_before?: number;
  tokens_after?: number;
  tokens_saved?: number;
  messages_before?: number;
  messages_after?: number;
  ratio?: number;
  turns_compressed?: number;
  duration_ms?: number;
  model_used?: string;
  path?: string;
  had_previous_summary?: boolean;
  new_state?: { summary_xml?: string | null } | null;
}

export interface LigneJournalOutil {
  level: string;
  message: string;
}

export interface EtapeOutil {
  name: string;
  status?: string;
  callId?: string | null;
  startedAt?: number;
  seg?: number;
  _kind?: string;
  _is_error?: boolean;
  thinking?: string | null;
  thinkingOpen?: boolean;
  thinkingMs?: number | null;
  resultLength?: number | null;
  ragLabel?: string | null;
  ragResultLabel?: string | null;
  args?: Readonly<Record<string, unknown>> | null;
  result?: unknown;
  durationMs?: number | null;
  progress?: number;
  progressInfo?: { pct: number | null; message?: string | null } | null;
  logs?: readonly LigneJournalOutil[] | null;
  turns?: number;
  pct?: number;
  reasonLabel?: string | null;
  stats?: StatsCompression | null;
  est_ms?: number;
  path?: string;
  reason?: string;
  threshold?: number;
  ctx_size?: number;
  model?: string;
  shellOut?: string | null;
  shellDone?: boolean;
  shellRc?: number | null;
  shellMs?: number;
  shellLiveTruncated?: boolean;
}

export interface EtapeAffichee {
  step: EtapeOutil;
  flat: number;
  shell: boolean;
}

export interface PastilleOutil {
  name: string;
  count: number;
  icon: string;
}

export interface MetaConsoleShell {
  n: number;
  running: boolean;
  nFail: number;
  title: string;
  chip: string;
  dot: string;
  truncated: boolean;
}

export interface GroupeSegment {
  gi: number;
  text: string;
  steps: readonly EtapeOutil[];
  disp: readonly EtapeAffichee[];
  nTools: number;
  nComp: number;
  pills: { pills: readonly PastilleOutil[]; extraCount: number };
  running: boolean;
  shellRuns: readonly { step: EtapeOutil; flat: number }[];
  shellMeta: MetaConsoleShell | null;
}

/** Champs d'interface d'un message lus par les segments (posés par `setMsgUi`). */
export interface MessageOutils {
  _segsOpen?: Readonly<Record<number, boolean>> | null;
  _activeToolStep?: number | null;
  _compactOpen?: boolean;
}

export type PatchUiMessage = Readonly<Record<string, unknown>>;

export interface ExecutionSousAgent {
  id?: string | null;
  /** Appel `task` qui l'a lancé (ligne du fil, volet de l'agent). */
  callId?: string | null;
  agent?: string;
  label?: string | null;
  depth?: number;
  state?: string;
  tokens?: number | null;
  progress?: { step?: number; max_steps?: number | null } | null;
  steps_total?: number | null;
  /** Jetons de réflexion mesurés (étape finale, run persisté) ; absent sur les anciens runs. */
  think_tokens?: number | null;
  transcript?: readonly unknown[] | null;
  cancelRequested?: boolean;
  /** Bloc du harnais validé à la réception ; absent sur les anciens runs. */
  harness?: BilanTache | null;
  prompt?: string | null;
  result?: string | null;
  duration_ms?: number | null;
  /** Horodatage du lancement (direct) : horloge de la ligne et du volet. */
  startedAt?: number;
}

export interface TacheSession {
  content: string;
  status: string;
  priority?: string;
}
