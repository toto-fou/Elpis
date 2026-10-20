// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/echantillonnage.ts — surcharges d'échantillonnage par chat (panneau « Réglages de génération »), paramètres effectifs du modèle et effort de réflexion. */
import type { ParametresEffectifs } from "@elpis/contracts";
import type * as Vue from "vue";
import type { Ref } from "vue";

import { journal } from "../../platform/journal.ts";

const BUDGET_REFLEXION_DEFAUT = 8192;
const EFFORTS_CONNUS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const CLE_STOCKAGE = "sampling_override";
const SPECIFIQUES_LLAMACPP: readonly string[] = [
  "top_k",
  "min_p",
  "repeat_penalty",
  "thinking_budget_tokens",
];
/** vLLM et SGLang acceptent `top_k`, `min_p` et la pénalité de répétition ; seul le budget de réflexion reste propre à llama.cpp. */
const DIALECTE_ETENDU: readonly string[] = ["vllm", "sglang"];

export interface SurchargeEchantillonnage {
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  min_p: number | null;
  repeat_penalty: number | null;
  max_tokens: number | null;
  max_tool_iterations: number | null;
  thinking_budget_tokens: number | null;
  reasoning_effort: string | null;
  preserve_reasoning: boolean | null;
}

export type CleSurcharge = keyof SurchargeEchantillonnage;
export type SurchargeCompacte = Partial<{ [K in CleSurcharge]: NonNullable<SurchargeEchantillonnage[K]> }>;

export interface MetaMoteur {
  key: string;
  llamacpp?: boolean;
  providerType?: string;
  loaded?: string[];
  [cle: string]: unknown;
}

export interface RefsEchantillonnage {
  selectedModel: Ref<string>;
  activeModelIds: Ref<string[]>;
  selectedConnector: Ref<string>;
  selectedEngineMeta: Ref<MetaMoteur | null>;
}

export interface CtxEchantillonnage {
  fetchAuth(url: string, init: RequestInit, silencieux: boolean): Promise<Response | null>;
  /** Stockage des surcharges ; `localStorage` du navigateur par défaut. */
  stockage?: Pick<Storage, "getItem" | "removeItem" | "setItem">;
}

export type DonneesParametres = Partial<ParametresEffectifs>;

const vide = (): SurchargeEchantillonnage => ({
  temperature: null,
  top_p: null,
  top_k: null,
  min_p: null,
  repeat_penalty: null,
  max_tokens: null,
  max_tool_iterations: null,
  thinking_budget_tokens: null,
  reasoning_effort: null,
  preserve_reasoning: null,
});

type CleNombre = Exclude<CleSurcharge, "reasoning_effort" | "preserve_reasoning">;
const CLES_NOMBRE: readonly CleNombre[] = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repeat_penalty",
  "max_tokens",
  "max_tool_iterations",
  "thinking_budget_tokens",
];

const estObjet = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Réponse de `effective-params` relue champ par champ (contrat `schemaParametresEffectifs`) ; `null` si ce n'est pas un objet. */
export function lireParametres(brut: unknown): DonneesParametres | null {
  if (!estObjet(brut)) return null;
  const bool = (v: unknown): boolean | null | undefined =>
    typeof v === "boolean" ? v : v === null ? null : undefined;
  const efforts = brut["reasoning_effort_values"];
  const sources = estObjet(brut["sources"]) ? brut["sources"] : null;
  const defauts = estObjet(brut["agent_defaults"]) ? brut["agent_defaults"] : null;
  const nombre = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const sortie: DonneesParametres = { ...(brut as DonneesParametres) };
  sortie.model_id = typeof brut["model_id"] === "string" ? brut["model_id"] : null;
  sortie.degraded = bool(brut["degraded"]) ?? undefined;
  sortie.supports_thinking = bool(brut["supports_thinking"]) ?? null;
  sortie.supports_reasoning_effort = bool(brut["supports_reasoning_effort"]) ?? null;
  sortie.supports_preserve_reasoning = bool(brut["supports_preserve_reasoning"]) ?? null;
  sortie.reasoning_effort_values = Array.isArray(efforts)
    ? efforts.filter((e): e is string => typeof e === "string")
    : [];
  if (sources) {
    sortie.sources = {
      ...sources,
      props: estObjet(sources["props"]) ? sources["props"] : {},
      task_profile: estObjet(sources["task_profile"]) ? sources["task_profile"] : {},
      user_override: estObjet(sources["user_override"]) ? sources["user_override"] : {},
    };
  }
  if (defauts) {
    sortie.agent_defaults = {
      ...defauts,
      max_tool_iterations: nombre(defauts["max_tool_iterations"]),
      thinking_budget_tokens: nombre(defauts["thinking_budget_tokens"]),
    };
  }
  return sortie;
}

function repliDegrade(id: string): DonneesParametres {
  return {
    model_id: id,
    degraded: true,
    supports_thinking: null,
    supports_reasoning_effort: null,
    reasoning_effort_values: [],
    supports_preserve_reasoning: null,
    sources: { props: {}, task_profile: {}, user_override: {} },
    agent_defaults: {},
  };
}

export type VueEchantillonnage = Pick<typeof Vue, "computed" | "ref" | "watch">;

export function setupEchantillonnage(
  vue: VueEchantillonnage,
  refs: RefsEchantillonnage,
  ctx: CtxEchantillonnage,
) {
  const { computed, ref, watch } = vue;
  const { selectedModel, activeModelIds, selectedConnector, selectedEngineMeta } = refs;
  const stockage = (): NonNullable<CtxEchantillonnage["stockage"]> => ctx.stockage ?? localStorage;
  const meta = (): MetaMoteur | null => selectedEngineMeta.value;
  const viaConnecteur = (): boolean => !!selectedConnector.value;
  const connecteurNonLlama = (): boolean => viaConnecteur() && !meta()?.llamacpp;

  const dernierBudget = ref(BUDGET_REFLEXION_DEFAUT);
  const showSamplingPanel = ref(false);
  const samplingOverride: Ref<SurchargeEchantillonnage> = ref(vide());
  const effectiveParamsData: Ref<DonneesParametres | null> = ref(null);
  const effectiveParamsLoading = ref(false);

  /** Relit les seules clés connues, nombres finis ou valeurs listées : un stockage corrompu n'injecte rien. */
  function restaurer(): void {
    try {
      const brut: unknown = JSON.parse(stockage().getItem(CLE_STOCKAGE) || "null");
      if (!brut || typeof brut !== "object") return;
      const sauve = brut as Record<string, unknown>;
      const cible = samplingOverride.value;
      const effort = sauve["reasoning_effort"];
      if (typeof effort === "string" && EFFORTS_CONNUS.includes(effort)) cible.reasoning_effort = effort;
      const conserve = sauve["preserve_reasoning"];
      if (typeof conserve === "boolean") cible.preserve_reasoning = conserve;
      for (const k of CLES_NOMBRE) {
        const v = sauve[k];
        if (typeof v === "number" && Number.isFinite(v)) cible[k] = v;
      }
    } catch {
      /* stockage illisible : valeurs par défaut */
    }
  }
  restaurer();

  /** Clés renseignées seulement (le moteur garde sa valeur pour les autres) ; `null` si rien. */
  function _cleanSamplingOverride(): SurchargeCompacte | null {
    const sortie: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(samplingOverride.value)) {
      if (v !== null && v !== undefined && (v as unknown) !== "") sortie[k] = v;
    }
    return Object.keys(sortie).length > 0 ? (sortie as SurchargeCompacte) : null;
  }

  function persister(): void {
    try {
      const propre = _cleanSamplingOverride();
      if (propre) stockage().setItem(CLE_STOCKAGE, JSON.stringify(propre));
      else stockage().removeItem(CLE_STOCKAGE);
    } catch {
      /* stockage indisponible */
    }
  }
  watch(samplingOverride, persister, { deep: true });

  const ignoredByEngine = computed<readonly string[]>(() => {
    if (!connecteurNonLlama()) return [];
    return DIALECTE_ETENDU.includes(meta()?.providerType ?? "")
      ? ["thinking_budget_tokens"]
      : SPECIFIQUES_LLAMACPP;
  });
  const isIgnoredByEngine = (cle: string): boolean => ignoredByEngine.value.includes(cle);

  /** Valeurs du modèle indisponibles : connecteur cloud, ou modèle local non chargé (lire /props le chargerait). */
  function estDegradePour(id: string): boolean {
    if (viaConnecteur()) {
      const m = meta();
      if (!m || !m.llamacpp) return true;
      return !Array.isArray(m.loaded) || !m.loaded.includes(id);
    }
    return !Array.isArray(activeModelIds.value) || !activeModelIds.value.includes(id);
  }

  async function loadEffectiveParams(modelId?: string | null): Promise<void> {
    const id = modelId || selectedModel.value;
    if (!id) {
      effectiveParamsData.value = null;
      return;
    }
    const degrade = estDegradePour(id);
    effectiveParamsLoading.value = true;
    try {
      const cleMoteur = viaConnecteur() && meta() ? (meta()?.key ?? "") : "";
      const res = await ctx.fetchAuth(
        `/api/llm/models/${encodeURIComponent(id)}/effective-params?task=chat` +
          (degrade ? "&degraded=1" : "") +
          (cleMoteur ? "&engine=" + encodeURIComponent(cleMoteur) : ""),
        {},
        true,
      );
      const lu = res && res.ok ? lireParametres(await res.json()) : null;
      if (lu) {
        effectiveParamsData.value = lu;
        appliquerDefauts(lu);
      } else {
        effectiveParamsData.value = repliDegrade(id);
      }
    } catch (e) {
      journal.avertir("[sampling] Impossible de charger effective-params", e);
      effectiveParamsData.value = repliDegrade(id);
    } finally {
      effectiveParamsLoading.value = false;
    }
  }

  /** Défaut de réflexion actif sur un modèle qui la supporte, purge des choix que le modèle ne supporte pas. */
  function appliquerDefauts(d: DonneesParametres): void {
    const o = samplingOverride.value;
    if (
      d.supports_thinking &&
      (o.thinking_budget_tokens === null || o.thinking_budget_tokens === undefined)
    ) {
      o.thinking_budget_tokens = BUDGET_REFLEXION_DEFAUT;
    }
    const effort = o.reasoning_effort;
    if (effort != null) {
      const inconnu =
        d.supports_reasoning_effort === false ||
        (d.supports_reasoning_effort &&
          Array.isArray(d.reasoning_effort_values) &&
          !d.reasoning_effort_values.includes(effort));
      if (inconnu) o.reasoning_effort = null;
    }
    if (d.supports_preserve_reasoning === false && o.preserve_reasoning !== null) o.preserve_reasoning = null;
  }

  function resetSamplingOverride(): void {
    samplingOverride.value = vide();
    if (effectiveParamsData.value?.supports_thinking) {
      samplingOverride.value.thinking_budget_tokens = BUDGET_REFLEXION_DEFAUT;
    }
  }

  let dernierChargement = "";
  /** Charge les paramètres du modèle sélectionné, une fois par modèle, moteur et mode (dégradé ou complet). */
  function chargerSiNouveau(): void {
    const m = selectedModel.value;
    if (!m) return;
    const moteur = viaConnecteur() && meta() ? (meta()?.key ?? "builtin") : "builtin";
    const cle = moteur + "|" + m + "|" + (estDegradePour(m) ? "deg" : "full");
    if (dernierChargement === cle) return;
    dernierChargement = cle;
    void loadEffectiveParams(m);
  }
  watch(
    [selectedModel, () => selectedConnector.value],
    () => {
      if (samplingOverride.value.thinking_budget_tokens === BUDGET_REFLEXION_DEFAUT) {
        samplingOverride.value.thinking_budget_tokens = null;
      }
      if (!selectedModel.value) return;
      chargerSiNouveau();
    },
    { immediate: true },
  );
  watch(activeModelIds, chargerSiNouveau);
  watch(selectedEngineMeta, chargerSiNouveau);

  const thinkingEnabled = computed({
    get: () => (samplingOverride.value.thinking_budget_tokens ?? 0) > 0,
    set: (actif: boolean) => {
      if (actif) {
        samplingOverride.value.thinking_budget_tokens = dernierBudget.value || BUDGET_REFLEXION_DEFAUT;
        return;
      }
      const courant = samplingOverride.value.thinking_budget_tokens;
      if (courant && courant > 0) dernierBudget.value = courant;
      samplingOverride.value.thinking_budget_tokens = 0;
    },
  });
  watch(
    () => samplingOverride.value.thinking_budget_tokens,
    (v) => {
      if (typeof v === "number" && v > 0) dernierBudget.value = v;
    },
  );

  /** Miroir du clamp serveur : 0 coupe, 1..511 monte à 512, au-delà de 131072 plafonne. */
  function clampThinkingBudget(): void {
    const v = samplingOverride.value.thinking_budget_tokens;
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    samplingOverride.value.thinking_budget_tokens =
      v <= 0 ? 0 : Math.min(Math.max(Math.round(v), 512), 131072);
  }

  const preserveReasoningSupported = computed(() => {
    if (connecteurNonLlama()) return false;
    const d = effectiveParamsData.value;
    if (!d || d.degraded || !d.supports_preserve_reasoning) return false;
    return d.model_id === selectedModel.value;
  });
  const preserveReasoningEnabled = computed({
    get: () => samplingOverride.value.preserve_reasoning !== false,
    set: (actif: boolean) => {
      samplingOverride.value.preserve_reasoning = !!actif;
    },
  });

  // Le serveur ne déclare l'effort que là où il est connu : props de llama.cpp, ou dialecte de vLLM et SGLang.
  const reasoningEffortValues = computed<string[]>(() => {
    const d = effectiveParamsData.value;
    if (!d || !d.supports_reasoning_effort) return [];
    if (d.model_id !== selectedModel.value) return [];
    return Array.isArray(d.reasoning_effort_values) ? d.reasoning_effort_values : [];
  });
  const showReasoningEffortMenu = ref(false);
  const toggleReasoningEffortMenu = (): void => {
    showReasoningEffortMenu.value = !showReasoningEffortMenu.value;
  };
  /** `null` = Auto : la clé reste absente du payload. */
  function pickReasoningEffort(v: string | null): void {
    samplingOverride.value.reasoning_effort = v || null;
    showReasoningEffortMenu.value = false;
  }

  async function openSamplingPanel(modelId?: string | null): Promise<void> {
    showSamplingPanel.value = true;
    await loadEffectiveParams(modelId);
  }
  const closeSamplingPanel = (): void => {
    showSamplingPanel.value = false;
  };

  return {
    showSamplingPanel,
    samplingOverride,
    thinkingEnabled,
    effectiveParamsData,
    effectiveParamsLoading,
    ignoredByEngine,
    isIgnoredByEngine,
    _cleanSamplingOverride,
    clampThinkingBudget,
    loadEffectiveParams,
    resetSamplingOverride,
    openSamplingPanel,
    closeSamplingPanel,
    preserveReasoningSupported,
    preserveReasoningEnabled,
    reasoningEffortValues,
    showReasoningEffortMenu,
    toggleReasoningEffortMenu,
    pickReasoningEffort,
  };
}

export type SurfaceEchantillonnage = ReturnType<typeof setupEchantillonnage>;
