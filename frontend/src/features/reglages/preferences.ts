// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/preferences.ts — bascules à effet immédiat des Paramètres : sous-agents, terminal, voix, familles opencode, compaction (activation, seuil, nombre maximal). */
import type { Ref } from "vue";

import { voiceCompat } from "../voix/compat";
import type { Persistance } from "./persistance";
import type { CtxReglages, ReglagesApp, VueReglages } from "./types";

const COMPACTION_PCT_DEFAUT = 70;
const COMPACTION_TOKENS_DEFAUT = 80000;
const COMPACTION_ROUNDS_DEFAUT = 24;

export type UniteCompaction = "auto" | "pct" | "tokens";
export type ModeTours = "auto" | "custom" | "unlimited";

export interface DiagnosticVoix {
  navigateur: { nom: string; version: number };
  dictee: { ok: boolean; raison: string };
  lecture: { ok: boolean; raison: string };
  avertissement: string | null;
}

export function creerPreferences(
  vue: VueReglages,
  settings: Ref<ReglagesApp>,
  ctx: CtxReglages,
  persistance: Persistance,
) {
  const { computed, ref } = vue;
  const { persistImmediat, persistKeys } = persistance;

  const persistAgentsEnabled = (): Promise<void> => {
    const val = !!settings.value.agents_enabled;
    return persistImmediat(
      { agents_enabled: val },
      {
        echec: "Sous-agents : enregistrement échoué.",
        reseau: "Sous-agents : erreur réseau.",
        succes: val ? "Sous-agents activés." : "Sous-agents désactivés.",
      },
    );
  };

  const persistLiveShell = (): Promise<void> => {
    const val = !!settings.value.live_shell_enabled;
    return persistImmediat(
      { live_shell_enabled: val },
      {
        echec: "Terminal en direct : enregistrement échoué.",
        reseau: "Terminal en direct : erreur réseau.",
        succes: val ? "Terminal en direct activé." : "Terminal en direct désactivé.",
      },
    );
  };

  const persistJobsWake = (): Promise<void> => {
    const val = settings.value.jobs_wake !== false;
    return persistImmediat(
      { jobs_wake: val },
      {
        echec: "Réveil par les tâches de fond : enregistrement échoué.",
        reseau: "Réveil par les tâches de fond : erreur réseau.",
        succes: val ? "Réveil par les tâches de fond activé." : "Réveil par les tâches de fond désactivé.",
      },
    );
  };

  /** Ne gouverne que la compaction automatique : /compact reste disponible dans les deux états. */
  const persistCompressionEnabled = (): Promise<void> => {
    const val = !!settings.value.compression_enabled;
    return persistImmediat(
      { compression_enabled: val },
      {
        echec: "Compaction : enregistrement échoué.",
        reseau: "Compaction : erreur réseau.",
        succes: val ? "Compaction automatique activée." : "Compaction automatique désactivée.",
      },
    );
  };

  // ── Voix ─────────────────────────────────────────────────────────────────
  const persisterVoix = (cle: string, val: boolean, libelle: string): Promise<void> =>
    persistImmediat(
      { [cle]: val },
      {
        echec: libelle + " : enregistrement échoué.",
        reseau: libelle + " : erreur réseau.",
        succes: val ? libelle + " activée." : libelle + " désactivée.",
      },
    );
  const persistVoiceInput = (): Promise<void> =>
    persisterVoix("voice_input_enabled", !!settings.value.voice_input_enabled, "Dictée");
  const persistVoiceReplyTools = (): Promise<void> =>
    persisterVoix(
      "voice_reply_tools_enabled",
      !!settings.value.voice_reply_tools_enabled,
      "Lecture entre les outils",
    );
  function persistVoiceReply(): Promise<void> {
    const val = !!settings.value.voice_reply_enabled;
    if (!val) {
      try {
        ctx.stopSpeaking?.();
      } catch {
        /* rien à couper */
      }
    }
    return persisterVoix("voice_reply_enabled", val, "Réponse vocale");
  }

  const diagnosticVoix: DiagnosticVoix | null = voiceCompat();
  const voiceMicSupported = computed(() => {
    if (diagnosticVoix) return diagnosticVoix.dictee.ok;
    return !!(
      window.isSecureContext !== false &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia
    );
  });
  const voiceReadSupported = computed(() => !diagnosticVoix || diagnosticVoix.lecture.ok);
  const voiceCompatInfo = computed<DiagnosticVoix>(
    () =>
      diagnosticVoix ?? {
        navigateur: { nom: "", version: 0 },
        dictee: { ok: true, raison: "" },
        lecture: { ok: true, raison: "" },
        avertissement: null,
      },
  );

  // ── Familles d'outils publiées à opencode ────────────────────────────────
  const opencodeFamilyOn = (name: string): boolean => settings.value.opencode_mcp_families?.[name] !== false;
  async function toggleOpencodeFamily(name: string): Promise<void> {
    const avant = { ...(settings.value.opencode_mcp_families ?? {}) };
    settings.value.opencode_mcp_families = { ...avant, [name]: !opencodeFamilyOn(name) };
    await persistKeys(["opencode_mcp_families"], {
      rollback: () => {
        settings.value.opencode_mcp_families = avant;
      },
    });
  }

  // ── Seuil de compaction ──────────────────────────────────────────────────
  const compactionUnitPin: Ref<UniteCompaction | ""> = ref("");
  const compactionRoundsPin: Ref<ModeTours | ""> = ref("");

  /** L'unité est dérivée des valeurs ; l'épingle ne tient que le temps d'une saisie. */
  const compactionUnit = computed<UniteCompaction>(() => {
    if (Number(settings.value.compression_threshold_tokens) > 0) return "tokens";
    if (Number(settings.value.compression_threshold_pct) > 0) return "pct";
    return compactionUnitPin.value || "auto";
  });
  const compactionPct = computed(
    () => Number(settings.value.compression_threshold_pct) || COMPACTION_PCT_DEFAUT,
  );
  const compactionTokensLabel = computed(() => {
    const n = Number(settings.value.compression_threshold_tokens) || 0;
    if (!n) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  });
  const compactionThresholdHint = computed(() => {
    if (compactionUnit.value === "pct")
      return "Compacte dès que le contexte atteint cette part de la fenêtre du modèle.";
    if (compactionUnit.value === "tokens")
      return "Compacte dès que le contexte atteint ce nombre de tokens. Plafonné à ce que le modèle courant supporte.";
    return "Compacte quand la fenêtre du modèle est pleine.";
  });

  function setCompactionUnit(valeur: string): void {
    const unit: UniteCompaction = valeur === "pct" || valeur === "tokens" ? valeur : "auto";
    compactionUnitPin.value = unit;
    if (unit === "pct") {
      settings.value.compression_threshold_pct = COMPACTION_PCT_DEFAUT;
      settings.value.compression_threshold_tokens = 0;
    } else if (unit === "tokens") {
      settings.value.compression_threshold_pct = 0;
      settings.value.compression_threshold_tokens = COMPACTION_TOKENS_DEFAUT;
    } else {
      settings.value.compression_threshold_pct = 0;
      settings.value.compression_threshold_tokens = 0;
    }
    void persistCompactionThreshold();
  }
  function setCompactionPct(brut: unknown): void {
    const v = Math.round(Number(brut) || 0);
    settings.value.compression_threshold_pct = Math.max(30, Math.min(95, v));
    settings.value.compression_threshold_tokens = 0;
  }
  function setCompactionTokens(brut: unknown): void {
    const v = Math.round(Number(brut) || 0);
    settings.value.compression_threshold_tokens = v > 0 ? Math.min(4000000, v) : 0;
    settings.value.compression_threshold_pct = 0;
  }

  /** Persiste le couple (pct, tokens) à la fin du geste ; rien tant que le champ tokens est vide. */
  async function persistCompactionThreshold(): Promise<void> {
    const pct = Number(settings.value.compression_threshold_pct) || 0;
    let tok = Number(settings.value.compression_threshold_tokens) || 0;
    if (compactionUnit.value === "tokens" && !tok) return;
    if (tok) {
      tok = Math.max(2048, Math.min(4000000, tok));
      settings.value.compression_threshold_tokens = tok;
    }
    await persistImmediat(
      { compression_threshold_pct: pct, compression_threshold_tokens: tok },
      {
        echec: "Seuil de compaction : enregistrement échoué.",
        reseau: "Seuil de compaction : erreur réseau.",
        succes: tok
          ? "Compaction à partir de " + compactionTokensLabel.value + " de contexte."
          : pct
            ? "Compaction à partir de " + pct + " % du contexte."
            : "Compaction automatique : seuil auto.",
      },
    );
  }

  // ── Compactions maximales par conversation ───────────────────────────────
  const compactionRoundsMode = computed<ModeTours>(() => {
    const n = Number(settings.value.compression_max_rounds) || 0;
    if (n < 0) return "unlimited";
    if (n > 0) return "custom";
    return compactionRoundsPin.value || "auto";
  });
  const compactionRoundsHint = computed(() => {
    if (compactionRoundsMode.value === "unlimited")
      return "Aucun plafond : la conversation continue d'être résumée aussi longtemps qu'elle tourne.";
    if (compactionRoundsMode.value === "custom")
      return "Plafond atteint, les tours les plus anciens sont retirés du contexte au lieu d'être résumés.";
    return "Plafond défini par l'instance.";
  });
  function setCompactionRoundsMode(valeur: string): void {
    const mode: ModeTours = valeur === "unlimited" || valeur === "custom" ? valeur : "auto";
    compactionRoundsPin.value = mode;
    if (mode === "unlimited") settings.value.compression_max_rounds = -1;
    else if (mode === "custom") settings.value.compression_max_rounds = COMPACTION_ROUNDS_DEFAUT;
    else settings.value.compression_max_rounds = 0;
    void persistCompactionMaxRounds();
  }
  function setCompactionRounds(brut: unknown): void {
    const v = Math.round(Number(brut) || 0);
    settings.value.compression_max_rounds = v > 0 ? Math.min(200, v) : 0;
  }
  async function persistCompactionMaxRounds(): Promise<void> {
    let n = Math.round(Number(settings.value.compression_max_rounds) || 0);
    if (compactionRoundsMode.value === "custom" && n <= 0) return;
    if (n > 0) {
      n = Math.max(1, Math.min(200, n));
      settings.value.compression_max_rounds = n;
    }
    await persistImmediat(
      { compression_max_rounds: n },
      {
        echec: "Compactions max : enregistrement échoué.",
        reseau: "Compactions max : erreur réseau.",
        succes:
          n < 0
            ? "Compactions : sans limite."
            : n > 0
              ? "Compactions : " + n + " au maximum par conversation."
              : "Compactions : plafond de l'instance.",
      },
    );
  }

  /** Les épingles de saisie ne survivent pas à un rechargement des réglages. */
  function reinitialiserEpingles(): void {
    compactionUnitPin.value = "";
    compactionRoundsPin.value = "";
  }

  return {
    persistAgentsEnabled,
    persistLiveShell,
    persistJobsWake,
    persistCompressionEnabled,
    persistVoiceInput,
    persistVoiceReply,
    persistVoiceReplyTools,
    voiceMicSupported,
    voiceReadSupported,
    voiceCompatInfo,
    opencodeFamilyOn,
    toggleOpencodeFamily,
    compactionUnit,
    compactionPct,
    compactionTokensLabel,
    compactionThresholdHint,
    setCompactionUnit,
    setCompactionPct,
    setCompactionTokens,
    persistCompactionThreshold,
    compactionRoundsMode,
    compactionRoundsHint,
    setCompactionRoundsMode,
    setCompactionRounds,
    persistCompactionMaxRounds,
    reinitialiserEpingles,
  };
}
