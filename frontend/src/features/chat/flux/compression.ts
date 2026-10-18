// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/flux/compression.ts — progression estimée d'une compression de contexte : durées passées par chemin (médiane) et avancée de l'étape « compression » du message (porté de `chat/_compression_ui.js`). */
import type { Ref } from "vue";

const CLE_HISTORIQUE = "elpis_compression_history_v1";
const HISTORIQUE_MAX = 10;
const DUREES_DEFAUT: Readonly<Record<string, number>> = {
  endpoint: 4000,
  external_model: 8000,
  self: 10000,
};

export interface StatutCompression {
  started_at?: number;
  est_ms?: number;
  [cle: string]: unknown;
}

interface EtapeProgression {
  _kind?: string;
  status?: string;
  progress?: number;
  [cle: string]: unknown;
}

export interface CtxCompression {
  _getStreamMsgs(): readonly { toolSteps?: readonly EtapeProgression[] | null }[];
  _patch(idx: number, patch: Record<string, unknown>): void;
}

function lireHistorique(): Record<string, number[]> {
  try {
    const brut = localStorage.getItem(CLE_HISTORIQUE);
    const obj: unknown = brut ? JSON.parse(brut) : {};
    return obj && typeof obj === "object" ? (obj as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

/** Avancée affichée : 0 → 70 % jusqu'à l'estimation, puis asymptote lente vers 88 %. */
export function progressionCompression(ecouleMs: number, estMs: number): number {
  const ratio = ecouleMs / estMs;
  const p = ratio <= 1 ? 70 * (1 - Math.pow(1 - ratio, 2)) : 70 + 18 * (1 - Math.exp(-(ratio - 1) * 0.6));
  return Math.min(88, Math.round(p * 10) / 10);
}

export function setupChatCompressionUI(
  _vue: unknown,
  refs: { compressionStatus: Ref<StatutCompression | null>; compressionProgress: Ref<number> },
  ctx: CtxCompression,
) {
  const { compressionStatus, compressionProgress } = refs;
  let minuterie: ReturnType<typeof setInterval> | null = null;
  let porteur: number | null = null;

  function _recordCompressionDuration(path: string, ms: number): void {
    if (!path || !ms || ms < 100 || ms > 600000) return;
    try {
      const hist = lireHistorique();
      hist[path] = (hist[path] || []).concat([Math.round(ms)]).slice(-HISTORIQUE_MAX);
      localStorage.setItem(CLE_HISTORIQUE, JSON.stringify(hist));
    } catch {
      /* stockage indisponible */
    }
  }

  function _estimateCompressionMs(path: string): number {
    const hist = lireHistorique()[path] || [];
    if (hist.length === 0) return DUREES_DEFAUT[path] || DUREES_DEFAUT["self"] || 10000;
    const tries = [...hist].sort((a, b) => a - b);
    return tries[Math.floor(tries.length / 2)] ?? 10000;
  }

  function avancerEtape(mi: number, valeur: number): void {
    const cur = ctx._getStreamMsgs()[mi];
    const etapes = cur?.toolSteps;
    if (!Array.isArray(etapes) || !etapes.length) return;
    for (let i = etapes.length - 1; i >= 0; i--) {
      const st = etapes[i];
      if (st && st._kind === "compression" && st.status === "running") {
        if ((st.progress || 0) === valeur) return;
        const suite = etapes.slice();
        suite[i] = { ...st, progress: valeur };
        ctx._patch(mi, { toolSteps: suite });
        return;
      }
    }
  }

  function _stopCompressionTick(): void {
    if (minuterie) {
      clearInterval(minuterie);
      minuterie = null;
    }
    porteur = null;
  }

  function _startCompressionTick(msgIdx?: number): void {
    _stopCompressionTick();
    compressionProgress.value = 0;
    porteur = typeof msgIdx === "number" ? msgIdx : -1;
    minuterie = setInterval(() => {
      const s = compressionStatus.value;
      if (!s) {
        _stopCompressionTick();
        return;
      }
      const valeur = progressionCompression(Date.now() - (s.started_at || Date.now()), s.est_ms || 10000);
      compressionProgress.value = valeur;
      if (typeof porteur === "number" && porteur >= 0) {
        try {
          avancerEtape(porteur, valeur);
        } catch {
          /* non bloquant */
        }
      }
    }, 250);
  }

  return {
    _readCompressionHistory: lireHistorique,
    _recordCompressionDuration,
    _estimateCompressionMs,
    _startCompressionTick,
    _stopCompressionTick,
  };
}
