// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/echantillonnage.ts — réglages du panneau « Génération », rangés sur le compte : échantillonnage, longueur, réflexion, paramètres effectifs du modèle et place dans la fenêtre. */
import type { ParametresEffectifs } from "@elpis/contracts";
import type * as Vue from "vue";
import type { Ref } from "vue";

import { journal } from "../../platform/journal.ts";

const BUDGET_REFLEXION_DEFAUT = 8192;
const EFFORTS_CONNUS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
/** Ancienne place des réglages (navigateur) : relue une fois pour les porter sur le compte. */
const CLE_STOCKAGE = "sampling_override";
const LONGUEUR_LIMITE_DEFAUT = 8192;
const DELAI_ENREGISTREMENT_MS = 600;

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
  /** Document de réglages du compte ; remplacé en bloc à chaque lecture du serveur. */
  settings: Ref<{ sampling_override?: unknown }>;
  /** Occupation du contexte du chat ouvert (dernier tour). */
  ctxUsage: Ref<{ used: number; total: number } | null>;
}

export type ModeLongueur = "auto" | "limit";

/** Place dans la fenêtre du modèle, en jetons ; `compaction` vaut 0 quand elle est coupée. */
export interface PlaceFenetre {
  total: number;
  utilise: number;
  reserve: number;
  marge: number;
  compaction: number;
}

export interface CtxEchantillonnage {
  fetchAuth(url: string, init: RequestInit, silencieux: boolean): Promise<Response | null>;
  /** Ancien stockage des réglages, relu pour la migration ; `localStorage` du navigateur par défaut. */
  stockage?: Pick<Storage, "getItem" | "removeItem">;
  showToast?(
    message: string,
    type?: string,
    opts?: { duration?: number; actionLabel?: string; onAction?: () => void },
  ): unknown;
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

export type CleNombre = Exclude<CleSurcharge, "reasoning_effort" | "preserve_reasoning">;
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

/** Réglages surchargés pour ce chat ; le budget de réflexion posé par défaut n'en est pas un. */
export function clesModifiees(o: Partial<SurchargeEchantillonnage>): CleSurcharge[] {
  return (Object.keys(vide()) as CleSurcharge[]).filter((k) => {
    const v: unknown = o[k];
    if (v === null || v === undefined || v === "") return false;
    return !(k === "thinking_budget_tokens" && v === BUDGET_REFLEXION_DEFAUT);
  });
}

/** Relit les seules clés connues, nombres finis ou valeurs listées : une valeur corrompue n'injecte rien. */
export function lireSurcharge(brut: unknown): SurchargeEchantillonnage {
  const cible = vide();
  if (!estObjet(brut)) return cible;
  const effort = brut["reasoning_effort"];
  if (typeof effort === "string" && EFFORTS_CONNUS.includes(effort)) cible.reasoning_effort = effort;
  const conserve = brut["preserve_reasoning"];
  if (typeof conserve === "boolean") cible.preserve_reasoning = conserve;
  for (const k of CLES_NOMBRE) {
    const v = brut[k];
    if (typeof v === "number" && Number.isFinite(v)) cible[k] = v;
  }
  return cible;
}

/** Clés renseignées seulement (le moteur garde sa valeur pour les autres) ; `null` si rien. */
export function compacter(o: SurchargeEchantillonnage): SurchargeCompacte | null {
  const sortie: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined && (v as unknown) !== "") sortie[k] = v;
  }
  return Object.keys(sortie).length > 0 ? (sortie as SurchargeCompacte) : null;
}

/** Valeur du modèle (ou défaut de l'agent) donnée en indication ; `null` quand le serveur ne la dit pas. */
export function valeurReference(d: DonneesParametres | null, cle: CleNombre): number | null {
  if (!d) return null;
  if (cle === "max_tool_iterations") return d.agent_defaults?.max_tool_iterations ?? 200;
  if (cle === "thinking_budget_tokens")
    return d.agent_defaults?.thinking_budget_tokens ?? BUDGET_REFLEXION_DEFAUT;
  const v = d.sources?.props?.[cle];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

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
  const conserveDefaut = bool(brut["preserve_reasoning_default"]);
  if (typeof conserveDefaut === "boolean") sortie.preserve_reasoning_default = conserveDefaut;
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
  const ignores = brut["ignored_keys"];
  sortie.ignored_keys = Array.isArray(ignores)
    ? ignores.filter((k): k is string => typeof k === "string")
    : [];
  sortie.engine_label = typeof brut["engine_label"] === "string" ? brut["engine_label"] : undefined;
  sortie.context_window = lireFenetre(brut["context_window"]);
  return sortie;
}

type Fenetre = NonNullable<ParametresEffectifs["context_window"]>;

/** `context_window` relu : entiers positifs, paires chat et réflexion complètes ; sinon absent. */
function lireFenetre(brut: unknown): Fenetre | undefined {
  if (!estObjet(brut)) return undefined;
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  const paire = (v: unknown): { chat: number; thinking: number } | null =>
    estObjet(v) ? { chat: n(v["chat"]), thinking: n(v["thinking"]) } : null;
  const reserve = paire(brut["output_reserve"]);
  if (!reserve) return undefined;
  return {
    ctx_size: n(brut["ctx_size"]),
    buffer_tokens: n(brut["buffer_tokens"]),
    output_reserve: reserve,
    compaction_at: paire(brut["compaction_at"]),
  };
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
  const { selectedModel, activeModelIds, selectedConnector, selectedEngineMeta, settings, ctxUsage } = refs;
  const stockage = (): NonNullable<CtxEchantillonnage["stockage"]> => ctx.stockage ?? localStorage;
  const meta = (): MetaMoteur | null => selectedEngineMeta.value;
  const viaConnecteur = (): boolean => !!selectedConnector.value;

  const dernierBudget = ref(BUDGET_REFLEXION_DEFAUT);
  const showSamplingPanel = ref(false);
  const samplingOverride: Ref<SurchargeEchantillonnage> = ref(vide());
  const effectiveParamsData: Ref<DonneesParametres | null> = ref(null);
  const effectiveParamsLoading = ref(false);
  /** « Limiter » choisi : le champ reste affiché pendant qu'on le vide pour retaper une valeur. */
  const limiteChoisie = ref(false);

  /** Valeur de l'ancien stockage du navigateur, `null` s'il est vide ou illisible. */
  function ancienStockage(): SurchargeCompacte | null {
    try {
      return compacter(lireSurcharge(JSON.parse(stockage().getItem(CLE_STOCKAGE) || "null")));
    } catch {
      return null;
    }
  }
  const migration = ancienStockage();
  if (migration) samplingOverride.value = lireSurcharge(migration);

  function oublierAncienStockage(): void {
    try {
      stockage().removeItem(CLE_STOCKAGE);
    } catch {
      /* stockage indisponible */
    }
  }

  function _cleanSamplingOverride(): SurchargeCompacte | null {
    return compacter(samplingOverride.value);
  }

  let minuterie: ReturnType<typeof setTimeout> | null = null;
  let derniereEcrite = "";
  /** Rien n'est écrit avant la lecture du document du compte : une valeur locale n'écrase pas le compte. */
  let compteLu = false;

  /** Écrit la seule clé `sampling_override` du compte (le serveur fusionne) et la reporte dans le document chargé. */
  async function enregistrer(): Promise<void> {
    minuterie = null;
    const propre = _cleanSamplingOverride() ?? {};
    const texte = JSON.stringify(propre);
    if (texte === derniereEcrite) return;
    derniereEcrite = texte;
    settings.value.sampling_override = propre;
    const res = await ctx.fetchAuth(
      "/api/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampling_override: propre }),
      },
      true,
    );
    if (res?.ok) oublierAncienStockage();
    else {
      derniereEcrite = "";
      ctx.showToast?.("Génération : réglages non enregistrés.", "error");
    }
  }
  watch(
    samplingOverride,
    () => {
      if (!compteLu) return;
      if (minuterie) clearTimeout(minuterie);
      minuterie = setTimeout(() => void enregistrer(), DELAI_ENREGISTREMENT_MS);
    },
    { deep: true },
  );

  /** Document du compte relu : ses réglages font foi, sauf une saisie pas encore écrite ; vide, il reçoit l'ancien stockage du navigateur. */
  watch(
    () => settings.value,
    (doc) => {
      const premiere = !compteLu;
      compteLu = true;
      if (minuterie) return;
      const compte = compacter(lireSurcharge(doc.sampling_override));
      if (compte || doc.sampling_override !== undefined || !premiere || !migration) {
        derniereEcrite = JSON.stringify(compte ?? {});
        samplingOverride.value = lireSurcharge(compte);
        limiteChoisie.value = false;
        if (effectiveParamsData.value) appliquerDefauts(effectiveParamsData.value);
        if (premiere && migration) oublierAncienStockage();
      } else void enregistrer();
    },
  );

  const ignoredByEngine = computed<readonly string[]>(() => {
    const d = effectiveParamsData.value;
    return d && d.model_id === selectedModel.value ? (d.ignored_keys ?? []) : [];
  });
  const isIgnoredByEngine = (cle: string): boolean => ignoredByEngine.value.includes(cle);
  /** Raison affichée sous un réglage que le moteur n'applique pas. */
  const raisonIgnore = (cle: string): string | null =>
    isIgnoredByEngine(cle)
      ? `Non appliqué par ${effectiveParamsData.value?.engine_label || "ce moteur"}`
      : null;

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
    limiteChoisie.value = false;
    if (effectiveParamsData.value?.supports_thinking) {
      samplingOverride.value.thinking_budget_tokens = BUDGET_REFLEXION_DEFAUT;
    }
  }

  /** Une clé revient à la valeur du modèle ; le budget de réflexion, à son défaut sur un modèle qui réfléchit. */
  function retablirCle(cle: CleSurcharge): void {
    const o = samplingOverride.value;
    if (cle === "thinking_budget_tokens" && effectiveParamsData.value?.supports_thinking)
      o.thinking_budget_tokens = BUDGET_REFLEXION_DEFAUT;
    else o[cle] = null;
  }

  /** Toutes les valeurs du modèle ; « Annuler » du toast rend les réglages d'avant. */
  function retablirModele(): void {
    const avant = { ...samplingOverride.value };
    if (!clesModifiees(avant).length) return;
    resetSamplingOverride();
    ctx.showToast?.("Valeurs du modèle rétablies", "success", {
      duration: 6000,
      actionLabel: "Annuler",
      onAction: () => {
        samplingOverride.value = { ...avant };
      },
    });
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

  // Le serveur ne déclare `true` que là où c'est su : gabarit lu sur /props (llama.cpp), ou SGLang avec un parseur de réflexion.
  const preserveReasoningSupported = computed(() => {
    const d = effectiveParamsData.value;
    if (!d || d.supports_preserve_reasoning !== true) return false;
    return d.model_id === selectedModel.value;
  });
  const preserveReasoningEnabled = computed({
    get: () =>
      samplingOverride.value.preserve_reasoning ??
      effectiveParamsData.value?.preserve_reasoning_default ??
      true,
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

  /** Auto : la clé `max_tokens` reste absente, le moteur prend le reste de la fenêtre. */
  const modeLongueur = computed<ModeLongueur>(() =>
    limiteChoisie.value || samplingOverride.value.max_tokens ? "limit" : "auto",
  );
  let derniereLimite = 0;
  watch(
    () => samplingOverride.value.max_tokens,
    (v) => {
      if (typeof v === "number" && v > 0) derniereLimite = v;
    },
    { immediate: true },
  );
  function choisirModeLongueur(mode: ModeLongueur): void {
    limiteChoisie.value = mode === "limit";
    if (mode === "auto") {
      samplingOverride.value.max_tokens = null;
      return;
    }
    if (samplingOverride.value.max_tokens) return;
    const reserve = effectiveParamsData.value?.context_window?.output_reserve;
    const parDefaut = (thinkingEnabled.value ? reserve?.thinking : reserve?.chat) || LONGUEUR_LIMITE_DEFAUT;
    samplingOverride.value.max_tokens = derniereLimite || parDefaut;
  }

  /** Fenêtre du modèle choisi, réserve et compaction du mode de réflexion courant ; `null` si la fenêtre est inconnue. */
  const placeFenetre = computed<PlaceFenetre | null>(() => {
    const d = effectiveParamsData.value;
    const f = d && d.model_id === selectedModel.value ? d.context_window : undefined;
    if (!f || !(f.ctx_size > 0)) return null;
    const mode = thinkingEnabled.value ? "thinking" : "chat";
    const usage = ctxUsage.value;
    return {
      total: f.ctx_size,
      utilise: usage && usage.used > 0 ? Math.min(usage.used, f.ctx_size) : 0,
      reserve: f.output_reserve[mode],
      marge: f.buffer_tokens,
      compaction: f.compaction_at?.[mode] ?? 0,
    };
  });

  return {
    showSamplingPanel,
    samplingOverride,
    thinkingEnabled,
    effectiveParamsData,
    effectiveParamsLoading,
    ignoredByEngine,
    isIgnoredByEngine,
    raisonIgnore,
    modeLongueur,
    choisirModeLongueur,
    placeFenetre,
    _cleanSamplingOverride,
    clampThinkingBudget,
    loadEffectiveParams,
    resetSamplingOverride,
    retablirCle,
    retablirModele,
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
