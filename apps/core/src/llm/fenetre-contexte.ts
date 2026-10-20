// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fenetre-contexte.ts — fenêtre de contexte de la cible courante : lue sur le moteur selon son profil (`/props`, `max_model_len`), sinon déclarée, famille connue, défaut du fournisseur ou `LLM_REMOTE_N_CTX`. */
import { ErreurPython, intPy, stripPy, veritePy } from "@elpis/commun";

import { journal } from "../journal";
import { estDict } from "../python";
import { currentTarget } from "./cible";
import { getPy } from "./dict-py";
import { monotonic } from "./llama-http";
import { getModelContextSize } from "./modeles";
import { engineForTarget, useEngine } from "./moteurs";
import type { CibleMoteur } from "./moteurs";
import { connecteurs } from "./ports";
import { profilDe } from "./profils";
import type { SourceContexte } from "./profils";
import { surInvalidationGlobale } from "./registre-caches";

const log = journal("ctx_window");

/** Préfixe (minuscules) du nom de modèle → fenêtre ; conservateur, le premier préfixe trouvé gagne. */
export const KNOWN_WINDOWS: readonly (readonly [string, number])[] = [
  ["claude-opus-5", 200_000],
  ["claude-sonnet-5", 200_000],
  ["claude-fable-5", 200_000],
  ["claude-haiku-4-5", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude-3-7", 200_000],
  ["claude-3-5", 200_000],
  ["claude-3", 200_000],
  ["claude-", 200_000],
  ["gpt-5", 200_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-4-turbo", 128_000],
  ["gpt-4", 8_192],
  ["gpt-3.5", 16_385],
  ["o3", 200_000],
  ["o1-mini", 128_000],
  ["o1-preview", 128_000],
  ["o1", 200_000],
  ["gemini-2", 1_000_000],
  ["gemini-1.5", 1_000_000],
  ["gemini-", 32_768],
  ["qwen3", 131_072],
  ["qwen2.5", 131_072],
  ["qwen2", 32_768],
  ["deepseek-v3", 131_072],
  ["deepseek-r1", 131_072],
  ["deepseek", 65_536],
  ["kimi", 131_072],
  ["moonshot", 131_072],
  ["llama-4", 131_072],
  ["llama-3.3", 131_072],
  ["llama-3.1", 131_072],
  ["llama-3", 8_192],
  ["mistral-large", 131_072],
  ["mixtral", 32_768],
  ["mistral", 32_768],
  ["command-r", 131_072],
  ["grok", 131_072],
];

/** Fenêtre par défaut d'un fournisseur aux identifiants inconnus (la plus petite de son catalogue). */
export const PROVIDER_DEFAULT_WINDOWS: Readonly<Record<string, number>> = { opencode: 131_072 };

export const NEG_TTL_S = 60.0;
export const DECLARED_TTL_S = 60.0;

const prevenus = new Set<string>();
export const cache = new Map<string, number>();
const negTs = new Map<string, number>();
const declarees = new Map<unknown, [number, number]>();

const RE_TAILLE = /[-_](\p{Nd}+)([km])(?![\p{L}\p{N}_])/u;

/** Fenêtre devinée au nom (nom complet puis dernier segment, puis suffixe `-128k` / `-1m` en base décimale). */
export function fromKnownFamily(modelId: string | null | undefined): number {
  const m = stripPy(modelId || "").toLowerCase();
  if (!m) return 0;
  const candidats = [m];
  if (m.includes("/")) candidats.push(m.slice(m.lastIndexOf("/") + 1));
  for (const cand of candidats) {
    for (const [prefixe, fenetre] of KNOWN_WINDOWS) if (cand.startsWith(prefixe)) return fenetre;
  }
  const mm = RE_TAILLE.exec(m);
  if (mm !== null) {
    try {
      return intPy(mm[1]) * (mm[2] === "k" ? 1000 : 1_000_000);
    } catch (e) {
      if (!(e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError"))) throw e;
    }
  }
  return 0;
}

function entierPositif(v: unknown): number {
  try {
    return intPy(veritePy(v) ? v : 0);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return 0;
    throw e;
  }
}

/** `context_window` déclaré sur le connecteur (ou `n_ctx` / `ctx_size`, à la racine puis dans `meta`). */
export async function fromConnector(connectorId: unknown): Promise<number> {
  if (!veritePy(connectorId)) return 0;
  let ligne: unknown;
  try {
    ligne = await connecteurs().getMeta(intPy(connectorId));
  } catch {
    return 0;
  }
  if (!estDict(ligne)) return 0;
  for (const cle of ["context_window", "n_ctx", "ctx_size"]) {
    const v = entierPositif(getPy(ligne, cle));
    if (v > 0) return v;
  }
  const meta = getPy(ligne, "meta");
  if (estDict(meta)) {
    for (const cle of ["context_window", "n_ctx", "ctx_size"]) {
      const v = entierPositif(getPy(meta, cle));
      if (v > 0) return v;
    }
  }
  return 0;
}

/** Fenêtre déclarée par connecteur, mémorisée `DECLARED_TTL_S` (lecture de base hors du chemin chaud). */
export async function declaredWindow(connectorId: unknown): Promise<number> {
  if (!veritePy(connectorId)) return 0;
  const hit = declarees.get(connectorId);
  const maintenant = monotonic();
  if (hit !== undefined && maintenant - hit[1] < DECLARED_TTL_S) return hit[0];
  let fenetre: number;
  try {
    fenetre = await fromConnector(connectorId);
  } catch {
    fenetre = 0;
  }
  declarees.set(connectorId, [fenetre, maintenant]);
  return fenetre;
}

export function envDefault(): number {
  try {
    return Math.max(0, intPy(process.env["LLM_REMOTE_N_CTX"] || 0));
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return 0;
    throw e;
  }
}

/** Ce que la résolution lit d'une cible (une `LlmTarget` ou tout objet de même forme). */
export interface CibleFenetre extends CibleMoteur {
  isLocalLlamacpp?: boolean;
  isLlamacpp?: boolean;
  model?: string | null;
}

/** Source de la fenêtre d'après le type déclaré de la cible (`/props`, `/v1/models` ou aucune). */
function sourceContexte(c: CibleFenetre): SourceContexte {
  if (c.isLlamacpp ?? false) return "props";
  return profilDe(c.providerType || "generic").capacites.contexte;
}

/** Fenêtre utilisable pour la cible, en tokens ; 0 = inconnue. Ne lève jamais. */
export async function resolveContextWindow(
  modelId: string | null = null,
  target: CibleFenetre | null = null,
): Promise<number> {
  let cible = target;
  try {
    cible ??= currentTarget();
  } catch {
    cible = null;
  }
  if (cible === null || (cible.isLocalLlamacpp ?? true)) {
    try {
      return await getModelContextSize(modelId || "");
    } catch {
      return 0;
    }
  }
  const modele = stripPy(modelId || cible.model || "");
  const cid = cible.connectorId ?? null;
  if (sourceContexte(cible) !== "aucune") {
    const declaree = await declaredWindow(cid);
    if (declaree > 0) return declaree;
    try {
      const vivante = await useEngine(engineForTarget(cible), () => getModelContextSize(modele));
      if (vivante > 0) return vivante;
    } catch (e) {
      log.debug(`fenêtre du moteur muette (${String(e)}) — la suite décide`);
    }
  }
  const cle = JSON.stringify([cid, modele]);
  const hit = cache.get(cle);
  if (hit !== undefined) {
    if (hit > 0) return hit;
    if (monotonic() - (negTs.get(cle) ?? 0.0) < NEG_TTL_S) return 0;
    cache.delete(cle);
  }
  let fenetre = await declaredWindow(cid);
  let source = "connecteur";
  if (fenetre <= 0) {
    fenetre = fromKnownFamily(modele);
    source = "famille connue";
  }
  if (fenetre <= 0) {
    const pt = cible.providerType || "";
    fenetre = Object.hasOwn(PROVIDER_DEFAULT_WINDOWS, pt) ? (PROVIDER_DEFAULT_WINDOWS[pt] ?? 0) : 0;
    source = "défaut du fournisseur";
  }
  if (fenetre <= 0) {
    fenetre = envDefault();
    source = "LLM_REMOTE_N_CTX";
  }
  if (fenetre > 0) {
    cache.set(cle, fenetre);
    log.info(`n_ctx=${fenetre} pour '${modele || "?"}' (source : ${source})`);
    return fenetre;
  }
  if (!prevenus.has(modele)) {
    prevenus.add(modele);
    log.warn(
      `fenêtre de contexte INCONNUE pour '${modele || "?"}' (cible distante) — compaction, ` +
        "élagage et budget dur restent inactifs sur ce modèle. Déclarez ``context_window`` sur le connecteur ou " +
        "posez LLM_REMOTE_N_CTX.",
    );
  }
  cache.set(cle, 0);
  negTs.set(cle, monotonic());
  return 0;
}

/** Purge la mémoïsation (changement de connecteur côté admin). */
export function invalidateCache(): void {
  cache.clear();
  negTs.clear();
  declarees.clear();
  prevenus.clear();
}

surInvalidationGlobale("ctx_window_entries_cleared", () => {
  const n = cache.size;
  invalidateCache();
  return n;
});
