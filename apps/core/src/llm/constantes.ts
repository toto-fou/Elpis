// SPDX-License-Identifier: MIT
/** apps/core/src/llm/constantes.ts — constantes du moteur LLM (config et env lues au chargement, comme l'import Python) et leurs bornes. */
import { createHash } from "node:crypto";

import { ErreurPython, estErreurPython, maxPy, minPy, stripPy, strPy } from "@elpis/commun";
import { config } from "@elpis/config";

import { entierPy, flottantPy, lowerPy } from "../python";
import { getBusySlotsSnapshot, getCachedTotalSlots, getModelTotalSlots } from "./modeles";
import { currentEngine } from "./moteurs";

function interrupteurEnv(nom: string): boolean {
  return !["0", "false", "no", ""].includes(lowerPy(stripPy(process.env[nom] ?? "1")));
}

function nombreEnv(nom: string, defaut: number, conversion: (v: string) => number): number {
  try {
    return conversion(process.env[nom] ?? String(defaut));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return defaut;
    throw e;
  }
}

export const LLAMA_MAX_MODELS = config.LLAMA_MAX_MODELS || 1;
export const LLAMA_MAX_TOOL_ITERATIONS = config.LLAMA_MAX_TOOL_ITERATIONS || 200;
export const LLAMA_THINKING_BUDGET_TOKENS = config.LLAMA_THINKING_BUDGET_TOKENS || 8192;
export const LLAMA_TOOL_TIMEOUT_S = config.LLAMA_TOOL_TIMEOUT_S || 300;

export const LLAMA_FORCE_IDLE_SLOT = interrupteurEnv("LLAMA_FORCE_IDLE_SLOT");
export const LLAMA_PIN_SLOT_BY_CHAT = interrupteurEnv("LLAMA_PIN_SLOT_BY_CHAT");

function plage(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

/** `id_slot` pour llama-server : hash stable du chat (KV chaud), dévié vers un slot libre si le sien est occupé ; -1 = au serveur de choisir. */
export function resolveSlotId(
  chatId: unknown,
  totalSlots: number | null | undefined,
  busySlots: Iterable<number> | null = null,
  options: { avoidOwn?: boolean } = {},
): number {
  const repli = LLAMA_FORCE_IDLE_SLOT ? -1 : 0;
  if (!LLAMA_PIN_SLOT_BY_CHAT || totalSlots === null || totalSlots === undefined || totalSlots <= 1)
    return repli;
  if (chatId === null || chatId === undefined || chatId === "" || chatId === 0 || chatId === false)
    return repli;
  const texte = strPy(chatId);
  if (!texte.isWellFormed())
    throw new ErreurPython("ValueError", "'utf-8' codec can't encode a lone surrogate");
  const digest = createHash("sha256").update(texte, "utf8").digest("hex");
  const preferred = Number.parseInt(digest.slice(0, 8), 16) % totalSlots;
  const second = Number.parseInt(digest.slice(8, 16), 16);
  const occupes = new Set(busySlots ?? []);
  if (options.avoidOwn) {
    const autres = plage(totalSlots).filter((s) => s !== preferred && !occupes.has(s));
    return autres.length > 0 ? (autres[second % autres.length] ?? preferred) : preferred;
  }
  if (occupes.size === 0 || !occupes.has(preferred)) return preferred;
  const libres = plage(totalSlots).filter((s) => !occupes.has(s));
  return libres.length > 0 ? (libres[second % libres.length] ?? preferred) : preferred;
}

/** `resolveSlotId` avec `total_slots` connu (sondé pour un connecteur) et l'occupation de `/slots`, sauté s'il n'y a qu'un slot. */
export async function resolveSlotIdAsync(
  chatId: unknown,
  options: { avoidOwn?: boolean } = {},
): Promise<number> {
  let total: number;
  try {
    total = getCachedTotalSlots();
    if (!currentEngine().isBuiltin) total = await getModelTotalSlots();
  } catch {
    return LLAMA_FORCE_IDLE_SLOT ? -1 : 0;
  }
  if (total <= 1) return resolveSlotId(chatId, total || 0, null);
  let occupes: ReadonlySet<number> | null;
  try {
    occupes = await getBusySlotsSnapshot();
  } catch {
    occupes = null;
  }
  return resolveSlotId(chatId, total, occupes, { avoidOwn: options.avoidOwn ?? false });
}

export const LLAMA_CACHE_PROMPT = interrupteurEnv("LLAMA_CACHE_PROMPT");
export const LLAMA_CACHE_REUSE_TOKENS = nombreEnv("LLAMA_CACHE_REUSE_TOKENS", 256, entierPy);

/** Réutilisation du KV de llama-server (`cache_prompt`, `n_cache_reuse`), source unique des deux chemins de chat. */
export function applyKvCacheParams(payload: Record<string, unknown>): void {
  if (LLAMA_CACHE_PROMPT) payload["cache_prompt"] = true;
  if (LLAMA_CACHE_REUSE_TOKENS > 0) payload["n_cache_reuse"] = LLAMA_CACHE_REUSE_TOKENS;
}

export const LLAMA_MAX_TOKENS_CHAT = config.LLAMA_MAX_TOKENS_CHAT;
export const LLAMA_MAX_TOKENS_THINKING = config.LLAMA_MAX_TOKENS_THINKING;
export const LLAMA_THINKING_OUTPUT_UNCAPPED = config.LLAMA_THINKING_OUTPUT_UNCAPPED;
export const LLAMA_THINK_RESUME_MAX = maxPy(0, config.LLAMA_THINK_RESUME_MAX);
export const LLAMA_THINK_RESUME_TOTAL_TOKENS = maxPy(0, config.LLAMA_THINK_RESUME_TOTAL_TOKENS);
export const LLAMA_CONTENT_RESUME_MAX = maxPy(0, config.LLAMA_CONTENT_RESUME_MAX);

export const LLAMA_GEN_CAP_CTX_RATIO = nombreEnv("LLAMA_GEN_CAP_CTX_RATIO", 0.4, flottantPy);
export const LLAMA_GEN_CAP_FLOOR = 2048;

/** Cap théorique de sortie borné à `LLAMA_GEN_CAP_CTX_RATIO` du n_ctx connu (plancher `LLAMA_GEN_CAP_FLOOR`). */
export function effectiveGenerationCap(thinkingMode: boolean, ctxSize: number | null = null): number {
  const cap = thinkingMode ? LLAMA_MAX_TOKENS_THINKING : LLAMA_MAX_TOKENS_CHAT;
  if (!ctxSize || !(ctxSize > 0)) return cap;
  return minPy(cap, maxPy(LLAMA_GEN_CAP_FLOOR, entierPy(ctxSize * LLAMA_GEN_CAP_CTX_RATIO)));
}

/** Longueur par défaut (aucune demandée) : le cap effectif injecté, ou omise en sortie non plafonnée ; une longueur explicite reste, `bornerLongueurALaFenetre` la ramène à la place libre. */
export function clampGenerationBudget(
  payload: Record<string, unknown>,
  samplingParams: Readonly<Record<string, unknown>>,
  thinkingMode: boolean,
  ctxSize: number | null = null,
  options: { uncapOutput?: boolean } = {},
): void {
  const valeur = (cle: string): unknown => (Object.hasOwn(samplingParams, cle) ? samplingParams[cle] : null);
  const positif = (cle: string): boolean => {
    const v = valeur(cle);
    if (v === null || v === undefined) return false;
    try {
      return entierPy(v) > 0;
    } catch (e) {
      if (estErreurPython(e, "TypeError", "ValueError")) return false;
      throw e;
    }
  };
  const cap = effectiveGenerationCap(thinkingMode, ctxSize);
  if (cap <= 0) return;
  if (!positif("max_tokens") && !positif("n_predict")) {
    const npResiduel =
      valeur("n_predict") !== null && valeur("n_predict") !== undefined && !positif("n_predict");
    if (options.uncapOutput) delete payload["max_tokens"];
    else payload["max_tokens"] = cap;
    if (npResiduel) delete payload["n_predict"];
    return;
  }
}

const CLES_LONGUEUR = ["max_tokens", "max_completion_tokens", "n_predict"] as const;
export const MARGE_LONGUEUR_MIN = 512;
export const MARGE_LONGUEUR_RATIO = 0.02;

/** Place laissée à la sortie : fenêtre − prompt estimé − marge d'estimation ; 0 si la fenêtre est inconnue. */
export function placeDeSortie(ctxSize: number, promptTokens: number): number {
  if (!(ctxSize > 0)) return 0;
  const marge = maxPy(MARGE_LONGUEUR_MIN, entierPy(ctxSize * MARGE_LONGUEUR_RATIO));
  return maxPy(0, ctxSize - maxPy(0, promptTokens) - marge);
}

export interface LongueurBornee {
  cle: string;
  demandee: number;
  envoyee: number;
}

/** Longueur explicite ramenée à la place libre, pour tous les moteurs ; place nulle ou fenêtre inconnue : laissée au moteur. */
export function bornerLongueurALaFenetre(
  payload: Record<string, unknown>,
  ctxSize: number,
  promptTokens: number,
): LongueurBornee[] {
  const place = placeDeSortie(ctxSize, promptTokens);
  if (place <= 0) return [];
  const bornees: LongueurBornee[] = [];
  for (const cle of CLES_LONGUEUR) {
    const v = payload[cle];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= place) continue;
    payload[cle] = place;
    bornees.push({ cle, demandee: v, envoyee: place });
  }
  return bornees;
}

export const LLAMA_TOOL_PARALLELISM = nombreEnv("LLAMA_TOOL_PARALLELISM", 8, entierPy);

/** Préfixes d'outils exécutés en série (état partagé : sandbox, dépôt, mémoire, écran, onglet, sous-agent). */
export const LLAMA_TOOL_SERIAL_PREFIXES: readonly string[] = (
  process.env["LLAMA_TOOL_SERIAL_PREFIXES"] ??
  "write_file,edit_file,sandbox_,git_,fs_write,fs_edit,fs_delete,fs_move,fs_rename,skill_run_script,memory," +
    "manage_files,skill_save,skill_add_file,task,desktop_,pw_"
)
  .split(",")
  .map(stripPy)
  .filter((p) => p !== "");

export const TASK_CHILD_TIMEOUT_S = config.TASK_CHILD_TIMEOUT_S || 3600;
/** Lu pour la parité avec le Python, sans effet : un sous-agent ne lance jamais de sous-agent. */
export const TASK_SUBAGENT_DEPTH = maxPy(1, config.TASK_SUBAGENT_DEPTH || 1);
export const TASK_RESUME_TTL_S = config.TASK_RESUME_TTL_S || 21600;
export const TASK_RESUME_MAX = config.TASK_RESUME_MAX || 200;
export const TASK_MAX_ITERS_EXPLORE = maxPy(1, config.TASK_MAX_ITERS_EXPLORE || 60);
export const TASK_MAX_ITERS_IMPLEMENT = maxPy(1, config.TASK_MAX_ITERS_IMPLEMENT || 100);
export const TASK_MAX_ITERS_VERIFY = maxPy(1, config.TASK_MAX_ITERS_VERIFY || 60);
export const TASK_MAX_ITERS_WEB = maxPy(1, config.TASK_MAX_ITERS_WEB || 60);
export const TASK_MAX_ITERS_PR = maxPy(1, config.TASK_MAX_ITERS_PR || 40);
const itersGeneral = maxPy(1, config.TASK_MAX_ITERS_GENERAL || 80);
export const TASK_MAX_ITERS_CUSTOM = maxPy(1, config.TASK_MAX_ITERS_CUSTOM || itersGeneral);

/** Garde-fou du résultat final d'un sous-agent persisté pour la modale « œil » (pas une troncature d'affichage). */
export const TASK_RESULT_PERSIST_CAP = 256 * 1024;

/** Capacité vision par modèle (`/v1/models`), vidée avec les caches de modèles. */
export const VISION_CAPABILITY_CACHE = new Map<string, boolean>();

export const VISION_MODEL_PATTERNS: readonly string[] = [
  "-vl-",
  "vl-instruct",
  "vision",
  "llava",
  "qwen2.5-omni",
  "qwen3-omni",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen3-vl",
  "gemma-3-",
  "gemma-4-",
  "llama-3.2-vision",
  "llama-4-",
  "pixtral",
  "moondream",
  "intern-vl",
  "internvl",
  "minicpm-v",
  "minicpm-o",
  "molmo",
  "phi-3.5-vision",
  "phi-4-vision",
  "cohere-aya-vision",
  "smolvlm",
];

/** Dernière capture par (utilisateur, chat), en JPEG réduit : une par session. */
export const LAST_SCREENSHOT = new Map<string, Uint8Array>();
export const VISION_MAX_WIDTH = 1024;
export const VISION_JPEG_QUALITY = 85;
