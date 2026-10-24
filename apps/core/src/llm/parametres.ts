// SPDX-License-Identifier: MIT
/** apps/core/src/llm/parametres.ts — sampling effectif (props du modèle < profil de tâche < surcharge validée) et capacités lues sur `/props` (raisonnement, effort, raisonnement conservé). */
import { estErreurPython, floatPy, intPy, quotePy, strPy, stripPy, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { estDict } from "../python";
import type { Dict } from "../python";
import { LLAMA_MAX_TOOL_ITERATIONS, LLAMA_THINKING_BUDGET_TOKENS } from "./constantes";
import { getPy } from "./dict-py";
import { llamaGet, monotonic } from "./llama-http";
import { autoloadSuffix } from "./modeles";
import { currentEngine } from "./moteurs";
import { profilDuType } from "./profils";
import type { ProfilMoteur } from "./profils";
import { surChangementDeModele, surInvalidationGlobale } from "./registre-caches";

const log = journal("llm_params");

const BASE_SAMPLING = ["temperature", "top_p", "top_k", "min_p", "typical_p"];
const PENALTY_PARAMS = ["repeat_penalty", "repeat_last_n", "frequency_penalty", "presence_penalty"];
const MODERN_SAMPLING = [
  "dry_multiplier",
  "dry_base",
  "dry_allowed_length",
  "dry_penalty_last_n",
  "xtc_probability",
  "xtc_threshold",
  "mirostat",
  "mirostat_tau",
  "mirostat_eta",
];
const GENERATION_LIMITS = ["n_predict", "max_tokens", "seed"];

/** Seules clés admises dans une surcharge (un appelant ne peut pas écraser `model` ni `messages`). */
export const ALLOWED_SAMPLING_KEYS: ReadonlySet<string> = new Set([
  ...BASE_SAMPLING,
  ...PENALTY_PARAMS,
  ...MODERN_SAMPLING,
  ...GENERATION_LIMITS,
]);

/** Longueur de génération : jamais reprise des défauts serveur de `/props` (souvent -1 = illimité). */
export const PROPS_EXCLUDE_KEYS: ReadonlySet<string> = new Set(["n_predict", "max_tokens"]);

/** Repli prudent quand `/props` ne répond pas. */
export const HARDCODED_FALLBACK: Readonly<Dict> = Object.freeze({
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
});

/** Surcharges minimales par tâche, au-dessus des props et sous l'utilisateur. */
export const TASK_PROFILES: Readonly<Record<string, Readonly<Dict>>> = Object.freeze({
  chat: Object.freeze({}),
  tools: Object.freeze({}),
  thinking: Object.freeze({}),
  infill: Object.freeze({ n_predict: 256 }),
  debug: Object.freeze({ max_tokens: 50 }),
});

export const PROPS_CACHE_TTL_S = 300.0;
export const RAW_PROPS_SHARE_S = 10.0;

export const propsCache = new Map<string, Dict>();
const propsCacheTs = new Map<string, number>();
const rawPropsShared = new Map<string, [number, Dict]>();
const rawPropsInflight = new Map<string, Promise<Dict>>();
export const thinkingCache = new Map<string, boolean>();
const thinkingCacheTs = new Map<string, number>();
export const reasoningEffortCache = new Map<string, string[]>();
const reasoningEffortCacheTs = new Map<string, number>();
export const preserveReasoningCache = new Map<string, boolean>();
const preserveReasoningCacheTs = new Map<string, number>();
export const continueFinalCache = new Map<string, boolean>();
const continueFinalCacheTs = new Map<string, number>();

/** Une entrée sans horodatage (posée à la main) est fraîche ; les autres expirent après `PROPS_CACHE_TTL_S`. */
function cacheFrais(ts: Map<string, number>, cle: string): boolean {
  const t = ts.get(cle);
  if (t === undefined) return true;
  return monotonic() - t < PROPS_CACHE_TTL_S;
}

/** Clé de cache (serveur, modèle) : le nom seul pour l'intégré. */
function engineKey(modelId: string | null | undefined): string {
  try {
    return currentEngine().cacheKey(modelId);
  } catch {
    return modelId || "";
  }
}

/** Support connu de `continue_final_message` : `true`/`false` mémorisé (TTL), `null` jamais tenté. */
export function continueFinalSupport(modelId: string | null | undefined): boolean | null {
  const cle = engineKey(modelId);
  if (continueFinalCache.has(cle) && !cacheFrais(continueFinalCacheTs, cle)) {
    continueFinalCache.delete(cle);
    continueFinalCacheTs.delete(cle);
    return null;
  }
  return continueFinalCache.get(cle) ?? null;
}

export function noteContinueFinalSupport(modelId: string | null | undefined, ok: boolean): void {
  continueFinalCache.set(engineKey(modelId), Boolean(ok));
  continueFinalCacheTs.set(engineKey(modelId), monotonic());
}

const PAIRES: readonly [Map<string, unknown>, Map<string, number>][] = [
  [propsCache, propsCacheTs],
  [thinkingCache, thinkingCacheTs],
  [reasoningEffortCache, reasoningEffortCacheTs],
  [preserveReasoningCache, preserveReasoningCacheTs],
  [continueFinalCache, continueFinalCacheTs],
];

/** Tout (`undefined`/`null`), ou un modèle : sa clé brute, la clé `""` et ses entrées `<serveur>|<modèle>`. */
export function invalidateParamsCache(modelId?: string | null): void {
  if (modelId === undefined || modelId === null) {
    for (const [c, ts] of PAIRES) {
      c.clear();
      ts.clear();
    }
    rawPropsShared.clear();
    log.info("Cache global invalidé.");
    return;
  }
  for (const [c, ts] of PAIRES) {
    for (const cle of [modelId, ""]) {
      c.delete(cle);
      ts.delete(cle);
    }
    for (const cle of [...c.keys()].filter((k) => k.endsWith("|" + modelId))) {
      c.delete(cle);
      ts.delete(cle);
    }
  }
  for (const cle of [...rawPropsShared.keys()]) {
    const [k] = JSON.parse(cle) as [string, boolean];
    if (k === "" || k === modelId || k.endsWith("|" + modelId)) rawPropsShared.delete(cle);
  }
  log.info(`Cache invalidé pour model_id=${modelId}`);
}

/** Sampling d'une réponse `/props` : `default_generation_settings.params` (récent) sinon à plat, au-dessus de la racine. */
export function extractSamplingFromProps(props: unknown): Dict {
  if (!estDict(props)) return {};
  const brut = getPy(props, "default_generation_settings");
  let gs: unknown = veritePy(brut) ? brut : {};
  if (!estDict(gs)) gs = {};
  const imbrique = getPy(gs, "params");
  const source = estDict(imbrique) && Object.keys(imbrique).length > 0 ? imbrique : (gs as Dict);
  const fusion: Dict = {};
  for (const d of [props, source]) {
    for (const [k, v] of Object.entries(d))
      if (ALLOWED_SAMPLING_KEYS.has(k) && !PROPS_EXCLUDE_KEYS.has(k) && v !== null && v !== undefined)
        fusion[k] = v;
  }
  return fusion;
}

const LAST_N_SENTINEL_KEYS = ["repeat_last_n", "dry_penalty_last_n"];
export const INT32_MAX = 2 ** 31 - 1;

/** `*_last_n` négatif (« tout le contexte ») → INT32_MAX, seule forme acceptée par la validation stricte récente. */
export function normalizeLastNSentinels(params: Dict): Dict {
  for (const cle of LAST_N_SENTINEL_KEYS) {
    const v = params[cle];
    if (typeof v === "number" && v < 0) params[cle] = INT32_MAX;
  }
  return params;
}

/** Surcharge utilisateur filtrée : clés admises, valeurs converties et bornées ; le reste est ignoré. */
export function sanitizeOverride(override: unknown): Dict {
  if (!veritePy(override) || !estDict(override)) return {};
  const propre: Dict = {};
  for (const [cle, valeur] of Object.entries(override)) {
    if (!ALLOWED_SAMPLING_KEYS.has(cle)) {
      log.debug(`Clé ignorée dans override : ${cle}`);
      continue;
    }
    if (valeur === null || valeur === undefined) continue;
    try {
      if (cle === "temperature") {
        const v = floatPy(valeur);
        if (v >= 0.0 && v <= 2.0) propre[cle] = v;
      } else if (["top_p", "min_p", "typical_p", "xtc_probability", "xtc_threshold"].includes(cle)) {
        const v = floatPy(valeur);
        if (v >= 0.0 && v <= 1.0) propre[cle] = v;
      } else if (cle === "top_k") {
        const v = intPy(valeur);
        if (v >= 0 && v <= 1000) propre[cle] = v;
      } else if (cle === "repeat_penalty") {
        const v = floatPy(valeur);
        if (v >= 0.5 && v <= 2.0) propre[cle] = v;
      } else if (cle === "frequency_penalty" || cle === "presence_penalty") {
        const v = floatPy(valeur);
        if (v >= -2.0 && v <= 2.0) propre[cle] = v;
      } else if (
        ["repeat_last_n", "dry_penalty_last_n", "dry_allowed_length", "n_predict", "max_tokens"].includes(cle)
      ) {
        const v = intPy(valeur);
        if (v >= -1 && v <= 1_000_000) propre[cle] = v;
      } else if (["dry_multiplier", "dry_base", "mirostat_tau", "mirostat_eta"].includes(cle)) {
        const v = floatPy(valeur);
        if (v >= 0.0 && v <= 10.0) propre[cle] = v;
      } else if (cle === "mirostat") {
        const v = intPy(valeur);
        if (v === 0 || v === 1 || v === 2) propre[cle] = v;
      } else if (cle === "seed") {
        propre[cle] = intPy(valeur);
      }
    } catch (e) {
      if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
      log.debug(`Valeur invalide pour ${cle} : ${strPy(valeur)}`);
    }
  }
  return propre;
}

function profil(task: string): Readonly<Dict> {
  return Object.hasOwn(TASK_PROFILES, task) ? (TASK_PROFILES[task] ?? {}) : {};
}

/** Sampling effectif d'une requête : props du modèle (repli prudent), profil de tâche, surcharge utilisateur. */
export async function resolveSampling(
  modelId: string | null = null,
  task = "chat",
  requestOverride: unknown = null,
): Promise<Dict> {
  let props = await getCachedProps(modelId);
  if (Object.keys(props).length === 0) {
    log.warn(
      `/props indisponible pour ${modelId || "<default>"} — fallback hardcode. ` +
        "Vérifier que /props?model=<id> renvoie bien default_generation_settings.params",
    );
    props = { ...HARDCODED_FALLBACK };
  }
  const effectif: Dict = { ...props, ...profil(task), ...sanitizeOverride(requestOverride) };
  return normalizeLastNSentinels(effectif);
}

/** Suffixe d'une lecture `/props?model=X` : rien si le tour va charger X, `&autoload=false` pour une lecture d'information. */
async function probeSuffix(autoload: boolean): Promise<string> {
  return autoload ? "" : autoloadSuffix();
}

/** Sampling extrait de `/props` pour un modèle (cache à TTL, serveur de la cible) ; `{}` hors llama.cpp ou injoignable. */
export async function getCachedProps(
  modelId: string | null | undefined,
  options: { autoload?: boolean } = {},
): Promise<Dict> {
  const eng = currentEngine();
  if (!eng.profil.capacites.props) return {};
  const cle = eng.cacheKey(modelId);
  const enCache = propsCache.get(cle);
  if (enCache !== undefined && cacheFrais(propsCacheTs, cle)) return enCache;
  let props: unknown;
  if (modelId) {
    props = await llamaGet(
      `/props?model=${quotePy(modelId, "")}${await probeSuffix(options.autoload ?? true)}`,
      3.0,
    );
    if (!veritePy(props)) props = await llamaGet("/props", 3.0);
  } else props = await llamaGet("/props", 3.0);
  if (!veritePy(props)) {
    log.debug(`/props injoignable pour ${String(modelId)}`);
    return {};
  }
  const extrait = extractSamplingFromProps(props);
  if (Object.keys(extrait).length > 0) {
    propsCache.set(cle, extrait);
    propsCacheTs.set(cle, monotonic());
    log.info(
      `Props cachés pour ${modelId || "<default>"} : ${Object.keys(extrait).length} paramètres — ` +
        Object.keys(extrait).sort().join(", "),
    );
  }
  return extrait;
}

export const THINKING_TEMPLATE_MARKERS = [
  "enable_thinking",
  "enable_thought",
  "add_thinking",
  "<think>",
  "reasoning_content",
];
export const THINKING_NAME_HINTS = [
  "qwen3",
  "deepseek-r1",
  "deepseek_r1",
  "deepseekr1",
  "r1-distill",
  "qwq",
  "magistral",
  "thinking",
  "reasoning",
  "-think",
];

/** `chat_template` d'une réponse `/props` (racine, puis `default_generation_settings`). */
export function propsChatTemplate(props: unknown): string {
  if (!estDict(props)) return "";
  const brut = getPy(props, "chat_template");
  let gabarit = strPy(veritePy(brut) ? brut : "");
  if (!gabarit) {
    const gs = getPy(props, "default_generation_settings");
    if (estDict(gs)) {
      const b = getPy(gs, "chat_template");
      gabarit = strPy(veritePy(b) ? b : "");
    }
  }
  return gabarit;
}

/** `/props` BRUT (avec le gabarit), partagé `RAW_PROPS_SHARE_S` ; une lecture en vol est attendue, pas répétée. */
export async function fetchRawProps(
  modelId: string | null | undefined,
  options: { autoload?: boolean } = {},
): Promise<Dict> {
  const autoload = options.autoload ?? true;
  try {
    if (!currentEngine().profil.capacites.props) return {};
  } catch (e) {
    log.debug(`_fetch_raw_props: moteur inconnu (${String(e)})`);
    return {};
  }
  const cle = JSON.stringify([engineKey(modelId), autoload]);
  const hit = rawPropsShared.get(cle);
  if (hit && monotonic() - hit[0] < RAW_PROPS_SHARE_S) return hit[1];
  const enVol = rawPropsInflight.get(cle);
  if (enVol !== undefined) return enVol;
  const lecture = (async (): Promise<Dict> => {
    try {
      const brut = await readRawProps(modelId, autoload);
      if (Object.keys(brut).length > 0 || !autoload) rawPropsShared.set(cle, [monotonic(), brut]);
      return brut;
    } finally {
      rawPropsInflight.delete(cle);
    }
  })();
  rawPropsInflight.set(cle, lecture);
  return lecture;
}

async function readRawProps(modelId: string | null | undefined, autoload: boolean): Promise<Dict> {
  try {
    let brut: unknown = modelId
      ? await llamaGet(`/props?model=${quotePy(modelId, "")}${await probeSuffix(autoload)}`, 3.0)
      : null;
    if (!veritePy(brut)) brut = await llamaGet("/props", 3.0);
    if (!veritePy(brut)) brut = {};
    if (!estDict(brut)) return {};
    if (modelId && brut["role"] === "router") return {};
    return brut;
  } catch (e) {
    log.debug(`_fetch_raw_props: /props KO (${String(e)})`);
    return {};
  }
}

/** Marqueurs de raisonnement dans le gabarit, sinon familles reconnues au nom. */
export function detectThinkingFromProps(props: unknown, modelId: string | null | undefined): boolean {
  const tl = propsChatTemplate(props).toLowerCase();
  if (THINKING_TEMPLATE_MARKERS.some((m) => tl.includes(m))) return true;
  const nom = (modelId || "").toLowerCase();
  return THINKING_NAME_HINTS.some((h) => nom.includes(h));
}

/** Le modèle raisonne-t-il ? (cache par modèle ; une lecture vide n'est pas retenue). */
export async function getThinkingSupport(
  modelId: string | null | undefined,
  options: { autoload?: boolean } = {},
): Promise<boolean> {
  const cle = engineKey(modelId);
  const enCache = thinkingCache.get(cle);
  if (enCache !== undefined && cacheFrais(thinkingCacheTs, cle)) return enCache;
  const brut = await fetchRawProps(modelId, options);
  const resultat = detectThinkingFromProps(brut, modelId);
  if (Object.keys(brut).length === 0) return resultat;
  thinkingCache.set(cle, resultat);
  thinkingCacheTs.set(cle, monotonic());
  log.info(`thinking support pour ${modelId || "<default>"} : ${resultat ? "True" : "False"}`);
  return resultat;
}

export const REASONING_EFFORT_KNOWN_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** Valeurs `reasoning_effort` citées littéralement par le gabarit ; variable sans littéral → low, medium, high. */
export function detectReasoningEffortFromProps(props: unknown): string[] {
  const tl = propsChatTemplate(props).toLowerCase();
  if (!tl.includes("reasoning_effort")) return [];
  const valeurs = REASONING_EFFORT_KNOWN_VALUES.filter((v) => tl.includes(`"${v}"`) || tl.includes(`'${v}'`));
  return valeurs.length > 0 ? valeurs : ["low", "medium", "high"];
}

/** Valeurs `reasoning_effort` acceptées par le modèle (`[]` = non supporté), cache par modèle. */
export async function getReasoningEffortValues(
  modelId: string | null | undefined,
  options: { autoload?: boolean } = {},
): Promise<string[]> {
  const cle = engineKey(modelId);
  const enCache = reasoningEffortCache.get(cle);
  if (enCache !== undefined && cacheFrais(reasoningEffortCacheTs, cle)) return enCache;
  const brut = await fetchRawProps(modelId, options);
  const resultat = detectReasoningEffortFromProps(brut);
  if (Object.keys(brut).length === 0) return resultat;
  reasoningEffortCache.set(cle, resultat);
  reasoningEffortCacheTs.set(cle, monotonic());
  log.info(
    `reasoning_effort pour ${modelId || "<default>"} : ${resultat.length > 0 ? `[${resultat.map((v) => `'${v}'`).join(", ")}]` : "non supporté"}`,
  );
  return resultat;
}

/** `reasoning_effort` d'une surcharge brute, s'il fait partie des valeurs connues. */
export function sanitizeReasoningEffort(samplingOverride: unknown): string | null {
  if (!estDict(samplingOverride)) return null;
  const v = getPy(samplingOverride, "reasoning_effort");
  if (typeof v === "string") {
    const n = stripPy(v).toLowerCase();
    if (REASONING_EFFORT_KNOWN_VALUES.includes(n)) return n;
  }
  return null;
}

export const PRESERVE_REASONING_TEMPLATE_MARKERS = [
  "preserve_thinking",
  "clear_thinking",
  "truncate_history_thinking",
  "drop_thinking",
];

/** `chat_template_caps.supports_preserve_reasoning` (autoritaire), sinon les variables miroir du gabarit. */
export function detectPreserveReasoningFromProps(props: unknown): boolean {
  if (!estDict(props)) return false;
  const caps = getPy(props, "chat_template_caps");
  if (estDict(caps) && Object.hasOwn(caps, "supports_preserve_reasoning"))
    return veritePy(getPy(caps, "supports_preserve_reasoning"));
  const tl = propsChatTemplate(props).toLowerCase();
  return PRESERVE_REASONING_TEMPLATE_MARKERS.some((m) => tl.includes(m));
}

/** Le gabarit honore-t-il `preserve_reasoning` ? (cache par modèle). */
export async function getPreserveReasoningSupport(
  modelId: string | null | undefined,
  options: { autoload?: boolean } = {},
): Promise<boolean> {
  const cle = engineKey(modelId);
  const enCache = preserveReasoningCache.get(cle);
  if (enCache !== undefined && cacheFrais(preserveReasoningCacheTs, cle)) return enCache;
  const brut = await fetchRawProps(modelId, options);
  const resultat = detectPreserveReasoningFromProps(brut);
  if (Object.keys(brut).length === 0) return resultat;
  preserveReasoningCache.set(cle, resultat);
  preserveReasoningCacheTs.set(cle, monotonic());
  log.info(`preserve_reasoning pour ${modelId || "<default>"} : ${resultat ? "True" : "False"}`);
  return resultat;
}

/** Tri-état : `null` = absent ou invalide (le gabarit garde son défaut), sinon le choix explicite. */
export function sanitizePreserveReasoning(samplingOverride: unknown): boolean | null {
  if (!estDict(samplingOverride)) return null;
  const v = getPy(samplingOverride, "preserve_reasoning");
  return typeof v === "boolean" ? v : null;
}

/** Réflexion des tours d'outils rendue au moteur : profil qui la transmet au gabarit (SGLang) et « Raisonnement conservé » activé explicitement (éteint par défaut). */
export function reflexionDuTourRendue(profil: ProfilMoteur, samplingOverride: unknown): boolean {
  return profil.capacites.reflexionRenvoyee && sanitizePreserveReasoning(samplingOverride) === true;
}

function agentDefaults(): Dict {
  return {
    max_tool_iterations: LLAMA_MAX_TOOL_ITERATIONS,
    thinking_budget_tokens: LLAMA_THINKING_BUDGET_TOKENS,
  };
}

/** Valeurs d'effort de vLLM et SGLang, qui acceptent toujours l'interrupteur de réflexion et l'effort (sans effet sur un modèle qui ne raisonne pas) ; `null` hors de ces moteurs. */
export function effortsDuDialecte(providerType: string | null | undefined): string[] | null {
  const efforts = profilDuType(providerType || "").dialecte.efforts;
  return efforts === null ? null : [...efforts];
}

/** Vue SANS réseau du panneau Sampling (modèle non chargé ou connecteur) : profil de tâche seul, capacités inconnues sauf celles du dialecte du moteur. */
export function describeEffectiveParamsDegraded(
  modelId: string | null = null,
  task = "chat",
  providerType: string | null = null,
): Dict {
  const tache = profil(task);
  const efforts = effortsDuDialecte(providerType);
  return {
    model_id: modelId,
    task,
    degraded: true,
    supports_thinking: efforts ? true : null,
    supports_reasoning_effort: efforts ? true : null,
    reasoning_effort_values: efforts ?? [],
    supports_preserve_reasoning: null,
    supports_continue_final_message: null,
    sources: { props: {}, task_profile: { ...tache }, user_override: {} },
    effective: { ...tache },
    param_sources: Object.fromEntries(Object.keys(tache).map((k) => [k, "task_profile"])),
    agent_defaults: agentDefaults(),
  };
}

/** Décomposition source par source (panneau Sampling) ; lecture d'information, ne charge jamais le modèle. */
export async function describeEffectiveParams(
  modelId: string | null = null,
  task = "chat",
  requestOverride: unknown = null,
): Promise<Dict> {
  const reels = await getCachedProps(modelId, { autoload: false });
  const degrade = Object.keys(reels).length === 0;
  const props = degrade ? { ...HARDCODED_FALLBACK } : reels;
  const tache = profil(task);
  const surcharge = sanitizeOverride(requestOverride);
  const dialecte = effortsDuDialecte(currentEngine().providerType);
  const pense = dialecte ? true : await getThinkingSupport(modelId, { autoload: false });
  const efforts = dialecte ?? (await getReasoningEffortValues(modelId, { autoload: false }));
  const conserve = await getPreserveReasoningSupport(modelId, { autoload: false });
  const effectif: Dict = {};
  const sources: Dict = {};
  for (const [k, v] of Object.entries(props)) {
    effectif[k] = v;
    sources[k] = degrade ? "fallback" : "props";
  }
  for (const [k, v] of Object.entries(tache)) {
    effectif[k] = v;
    sources[k] = "task_profile";
  }
  for (const [k, v] of Object.entries(surcharge)) {
    effectif[k] = v;
    sources[k] = "user_override";
  }
  normalizeLastNSentinels(effectif);
  return {
    model_id: modelId,
    task,
    supports_thinking: pense,
    supports_reasoning_effort: efforts.length > 0,
    reasoning_effort_values: efforts,
    supports_preserve_reasoning: conserve,
    supports_continue_final_message: continueFinalSupport(modelId),
    props_unavailable: degrade,
    sources: { props, task_profile: { ...tache }, user_override: surcharge },
    effective: effectif,
    param_sources: sources,
    agent_defaults: agentDefaults(),
  };
}

surInvalidationGlobale("llm_params_entries_cleared", () => {
  const n = propsCache.size;
  invalidateParamsCache();
  return n;
});
surChangementDeModele("llm_params", () => invalidateParamsCache());
